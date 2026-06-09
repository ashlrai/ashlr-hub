/**
 * swarms.tsx — "Swarms" Raycast command.
 *
 * Lists active and recent swarms from ~/.ashlr/swarms/ with live task burndown
 * (done / total) and per-phase progress. Auto-revalidates every 2 seconds via
 * the useAutoRevalidate hook.
 *
 * Actions:
 *  - Show detail  → Detail view with full swarm info
 *  - Open project → Finder reveal of the swarm's project path
 *  - Refresh      → manual revalidation
 */

import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { openInFinder } from "./lib/open";
import { runAshlrJson, useAutoRevalidate } from "./lib/ashlr-runner";

// ---------------------------------------------------------------------------
// Types — mirror src/core/types.ts SwarmRun / SwarmTaskRun exactly.
//
// Real swarm status:  'planning' | 'running' | 'done' | 'aborted' | 'failed'
// Real task status:   'pending'  | 'running' | 'done' | 'failed'  | 'skipped'
// Tasks are a FLAT array; each task carries a `phase: string`. There is no
// phases[] array — per-phase progress is derived by grouping tasks[] by phase.
// The project path field is `project: string | null`.
// ---------------------------------------------------------------------------

interface SwarmTask {
  id: string;
  status: "pending" | "running" | "done" | "failed" | "skipped" | string;
  phase: string;
  goal?: string;
}

interface SwarmRun {
  id: string;
  goal: string;
  status: "planning" | "running" | "done" | "aborted" | "failed" | string;
  project: string | null;
  createdAt: string;
  updatedAt?: string;
  tasks?: SwarmTask[];
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const SWARMS_DIR = path.join(os.homedir(), ".ashlr", "swarms");

/**
 * Scan ~/.ashlr/swarms/*.json — the real on-disk layout written by
 * core/swarm/store.ts (one file per swarm). Returns an empty array on any
 * error — never throws. There is no top-level swarms.json index, so we don't
 * probe for one.
 */
function loadSwarmsFromDisk(): SwarmRun[] {
  try {
    if (!fs.existsSync(SWARMS_DIR)) return [];
    const files = fs.readdirSync(SWARMS_DIR).filter((f) => f.endsWith(".json"));
    const records: SwarmRun[] = [];
    for (const file of files.slice(0, 50)) {
      try {
        const raw = fs.readFileSync(path.join(SWARMS_DIR, file), "utf-8");
        const rec = JSON.parse(raw) as SwarmRun;
        if (rec && typeof rec.id === "string") records.push(rec);
      } catch {
        // skip malformed file
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Fetch live swarm data via `ashlr swarms --json` (emits a bare SwarmRun[]).
 * Falls back to a disk scan if the subprocess fails (so the view stays
 * populated even offline). NOTE: must be `swarms` (the read-only list command),
 * NOT `swarm <goal>` — `ashlr swarm list` would treat "list" as a goal and
 * actually plan & launch a real swarm run.
 */
async function fetchSwarms(): Promise<SwarmRun[]> {
  const result = await runAshlrJson<SwarmRun[]>(["swarms", "--json"], 15_000);
  if (result.ok && result.data && Array.isArray(result.data)) {
    return result.data;
  }
  // Subprocess unavailable or produced unexpected shape — fall back to disk.
  return loadSwarmsFromDisk();
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** A swarm is "active" when it is still planning or running. */
function isActive(swarm: SwarmRun): boolean {
  return swarm.status === "running" || swarm.status === "planning";
}

function taskCounts(swarm: SwarmRun): { done: number; total: number } {
  const tasks = swarm.tasks ?? [];
  const done = tasks.filter((t) => t.status === "done").length;
  return { done, total: tasks.length };
}

/** Group the flat tasks[] array by their `phase` string, in first-seen order. */
function tasksByPhase(swarm: SwarmRun): { name: string; tasks: SwarmTask[] }[] {
  const order: string[] = [];
  const map = new Map<string, SwarmTask[]>();
  for (const t of swarm.tasks ?? []) {
    const phase = t.phase || "unknown";
    if (!map.has(phase)) {
      map.set(phase, []);
      order.push(phase);
    }
    map.get(phase)!.push(t);
  }
  return order.map((name) => ({ name, tasks: map.get(name)! }));
}

/**
 * Name of the phase currently in progress: the phase of the first running
 * task, else the first phase with a pending task. Returns null when none.
 */
function activePhaseName(swarm: SwarmRun): string | null {
  const phases = tasksByPhase(swarm);
  for (const phase of phases) {
    if (phase.tasks.some((t) => t.status === "running")) return phase.name;
  }
  for (const phase of phases) {
    if (phase.tasks.some((t) => t.status === "pending")) return phase.name;
  }
  return null;
}

function statusIcon(status: string): { source: Icon; tintColor: Color } {
  switch (status) {
    case "running":
      return { source: Icon.CircleProgress, tintColor: Color.Blue };
    case "planning":
      return { source: Icon.Clock, tintColor: Color.Blue };
    case "done":
      return { source: Icon.CheckCircle, tintColor: Color.Green };
    case "failed":
    case "aborted":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
    default:
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
  }
}

function burndownBar(done: number, total: number, width = 20): string {
  if (total === 0) return "─".repeat(width);
  const filled = Math.round((done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function SwarmDetail({ swarm }: { swarm: SwarmRun }) {
  const { done, total } = taskCounts(swarm);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const phases = tasksByPhase(swarm);
  const phasesBlock =
    phases.length > 0
      ? phases
          .map((phase) => {
            const phaseDone = phase.tasks.filter(
              (t) => t.status === "done",
            ).length;
            const rows = phase.tasks
              .map((t) => {
                const statusMark =
                  t.status === "done"
                    ? "✅"
                    : t.status === "running"
                      ? "🔄"
                      : t.status === "failed"
                        ? "❌"
                        : t.status === "skipped"
                          ? "⏭️"
                          : "⬜";
                return `  ${statusMark} ${t.goal ?? t.id}`;
              })
              .join("\n");
            return `### Phase: ${phase.name} (${phaseDone}/${phase.tasks.length})\n${rows || "  *(no tasks)*"}`;
          })
          .join("\n\n")
      : "*No phase data available*";

  const projectLine = swarm.project
    ? `\n- **Project:** \`${swarm.project}\``
    : "";
  const updatedLine = swarm.updatedAt
    ? `\n- **Updated:** ${relativeTime(swarm.updatedAt)}`
    : "";

  const md = `# Swarm · \`${swarm.id}\`

**Goal:** ${swarm.goal}
**Status:** ${swarm.status}
**Progress:** ${done}/${total} tasks (${pct}%)
\`${burndownBar(done, total, 30)}\`${projectLine}${updatedLine}

---

## Phases

${phasesBlock}
`;

  return (
    <Detail
      navigationTitle={`Swarm · ${swarm.id}`}
      markdown={md}
      actions={
        <ActionPanel>
          {swarm.project && (
            <Action
              title="Open Project in Finder"
              icon={Icon.Finder}
              onAction={() => openInFinder(swarm.project!)}
            />
          )}
          <Action.CopyToClipboard
            title="Copy Swarm ID"
            content={swarm.id}
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy Goal"
            content={swarm.goal}
            icon={Icon.Text}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Main list component
// ---------------------------------------------------------------------------

export default function Swarms() {
  const { push } = useNavigation();
  const [swarms, setSwarms] = useState<SwarmRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const records = await fetchSwarms();
      // Sort: active first, then by most-recently updated.
      records.sort((a, b) => {
        const aActive = isActive(a) ? 0 : 1;
        const bActive = isActive(b) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const aTime = a.updatedAt ?? a.createdAt ?? "";
        const bTime = b.updatedAt ?? b.createdAt ?? "";
        return bTime.localeCompare(aTime);
      });
      setSwarms(records);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    load();
  }, [load]);

  // Auto-revalidate every 2s
  useAutoRevalidate(load, 2_000, !isLoading);

  // Manual refresh action
  async function handleRefresh() {
    setIsLoading(true);
    await load();
    await showToast({ style: Toast.Style.Success, title: "Swarms refreshed" });
  }

  const RefreshAction = (
    <Action
      title="Refresh"
      icon={Icon.ArrowClockwise}
      onAction={handleRefresh}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
    />
  );

  // ── Error state ────────────────────────────────────────────────────────────
  if (!isLoading && error && swarms.length === 0) {
    return (
      <List navigationTitle="Swarms" isLoading={isLoading}>
        <List.EmptyView
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title="Could not load swarms"
          description={error}
          actions={<ActionPanel>{RefreshAction}</ActionPanel>}
        />
      </List>
    );
  }

  // ── Partition by status ────────────────────────────────────────────────────
  const activeSwarms = swarms.filter(isActive);
  const recentSwarms = swarms.filter((s) => !isActive(s)).slice(0, 20);

  const subtitle = lastUpdated
    ? `Updated ${relativeTime(lastUpdated.toISOString())}`
    : undefined;

  return (
    <List
      navigationTitle="Swarms"
      isLoading={isLoading}
      searchBarPlaceholder="Filter swarms…"
    >
      {/* ── Active swarms ──────────────────────────────────────────────────── */}
      {activeSwarms.length > 0 && (
        <List.Section
          title="Active"
          subtitle={`${activeSwarms.length} running · ${subtitle ?? ""}`}
        >
          {activeSwarms.map((swarm) => {
            const { done, total } = taskCounts(swarm);
            const phase = activePhaseName(swarm);
            const progressText =
              total > 0 ? `${done}/${total} tasks` : "No tasks";
            const phaseText = phase ? ` · Phase: ${phase}` : "";

            return (
              <List.Item
                key={swarm.id}
                icon={statusIcon(swarm.status)}
                title={swarm.goal}
                subtitle={`${progressText}${phaseText}`}
                accessories={[
                  total > 0
                    ? {
                        tag: {
                          value: `${Math.round((done / total) * 100)}%`,
                          color: Color.Blue,
                        },
                        tooltip: `${done} of ${total} tasks done`,
                      }
                    : null,
                  swarm.updatedAt
                    ? { text: relativeTime(swarm.updatedAt) }
                    : null,
                ].filter((a): a is NonNullable<typeof a> => a !== null)}
                actions={
                  <ActionPanel>
                    <Action
                      title="Show Detail"
                      icon={Icon.Eye}
                      onAction={() => push(<SwarmDetail swarm={swarm} />)}
                    />
                    {swarm.project && (
                      <Action
                        title="Open Project in Finder"
                        icon={Icon.Finder}
                        onAction={() => openInFinder(swarm.project!)}
                        shortcut={{ modifiers: ["cmd"], key: "f" }}
                      />
                    )}
                    <ActionPanel.Section>{RefreshAction}</ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {/* ── Recent / completed swarms ──────────────────────────────────────── */}
      {recentSwarms.length > 0 && (
        <List.Section
          title="Recent"
          subtitle={`${recentSwarms.length} swarm${recentSwarms.length !== 1 ? "s" : ""}`}
        >
          {recentSwarms.map((swarm) => {
            const { done, total } = taskCounts(swarm);
            const progressText = total > 0 ? `${done}/${total} tasks` : "";

            return (
              <List.Item
                key={swarm.id}
                icon={statusIcon(swarm.status)}
                title={swarm.goal}
                subtitle={progressText}
                accessories={[
                  {
                    tag: {
                      value: swarm.status,
                      color:
                        swarm.status === "done"
                          ? Color.Green
                          : swarm.status === "failed" ||
                              swarm.status === "aborted"
                            ? Color.Red
                            : Color.SecondaryText,
                    },
                  },
                  swarm.updatedAt
                    ? { text: relativeTime(swarm.updatedAt) }
                    : swarm.createdAt
                      ? { text: relativeTime(swarm.createdAt) }
                      : null,
                ].filter((a): a is NonNullable<typeof a> => a !== null)}
                actions={
                  <ActionPanel>
                    <Action
                      title="Show Detail"
                      icon={Icon.Eye}
                      onAction={() => push(<SwarmDetail swarm={swarm} />)}
                    />
                    {swarm.project && (
                      <Action
                        title="Open Project in Finder"
                        icon={Icon.Finder}
                        onAction={() => openInFinder(swarm.project!)}
                        shortcut={{ modifiers: ["cmd"], key: "f" }}
                      />
                    )}
                    <ActionPanel.Section>{RefreshAction}</ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {!isLoading && swarms.length === 0 && (
        <List.EmptyView
          icon={{ source: Icon.Layers, tintColor: Color.SecondaryText }}
          title="No swarms found"
          description="Run `ashlr swarm <goal>` in your terminal to create a swarm."
          actions={<ActionPanel>{RefreshAction}</ActionPanel>}
        />
      )}
    </List>
  );
}
