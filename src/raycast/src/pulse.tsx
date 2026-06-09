/**
 * pulse.tsx — "Pulse" Raycast view command.
 *
 * Runs `ashlr pulse --json --window 7d` (or a user-selected window) and
 * renders a rich List with sections:
 *
 *   1. Budget status (always first, color/icon by level)
 *   2. Totals for the window
 *   3. By Project (sessions, commits, tokens, cost)
 *   4. Top Models (calls, tokens, cost)
 *
 * Actions: Refresh, open project in editor/Finder.
 * Loading spinner while the subprocess is running.
 */

import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import * as cp from "child_process";
import * as path from "path";

// ---------------------------------------------------------------------------
// Inline type mirrors — matches src/core/types.ts M5 interfaces exactly.
// We copy only what we need here to avoid a build-time cross-package import.
// ---------------------------------------------------------------------------

interface ProjectActivity {
  project: string;
  sessions: number;
  commits: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  lastActive: string | null;
}

interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  calls: number;
}

interface BudgetAlert {
  level: "ok" | "warn" | "over";
  window: string;
  spentUsd: number;
  capUsd: number | null;
  spentTokens: number;
  capTokens: number | null;
  message: string;
}

interface ActivityRollup {
  window: string;
  since: string;
  totals: {
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    sessions: number;
    commits: number;
  };
  byProject: ProjectActivity[];
  byModel: ModelUsage[];
  budget: BudgetAlert;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

interface Prefs {
  editor?: "cursor" | "vscode";
}

function getEditor(): "cursor" | "vscode" {
  try {
    const prefs = getPreferenceValues<Prefs>();
    return prefs.editor === "vscode" ? "vscode" : "cursor";
  } catch {
    return "cursor";
  }
}

// ---------------------------------------------------------------------------
// Window type
// ---------------------------------------------------------------------------

type Window = "1d" | "7d" | "30d";

const WINDOW_LABELS: Record<Window, string> = {
  "1d": "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a token count as a compact human-readable string: 1.2k, 38.4k, 1.1M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format a USD cost to 2–4 decimal places, trimming unnecessary zeros. */
function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Basename of a project path, falling back to the full string. */
function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

/** Relative-time label: "today", "2d ago", "3w ago", etc. */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (isNaN(ms) || ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ---------------------------------------------------------------------------
// Budget icon + color
// ---------------------------------------------------------------------------

function budgetIcon(level: BudgetAlert["level"]): { source: Icon; tintColor: Color } {
  switch (level) {
    case "over":
      return { source: Icon.ExclamationMark, tintColor: Color.Red };
    case "warn":
      return { source: Icon.Warning, tintColor: Color.Yellow };
    default:
      return { source: Icon.CheckCircle, tintColor: Color.Green };
  }
}

function budgetTagColor(level: BudgetAlert["level"]): Color {
  switch (level) {
    case "over":
      return Color.Red;
    case "warn":
      return Color.Yellow;
    default:
      return Color.Green;
  }
}

// ---------------------------------------------------------------------------
// ashlr pulse runner
// ---------------------------------------------------------------------------

import * as os from "os";

const ASHLR_PATHS = [
  path.join(os.homedir(), ".local", "bin", "ashlr"),
  "/usr/local/bin/ashlr",
  "ashlr",
];

function resolveAshlr(): string {
  // Try known paths; fall back to bare name (relies on PATH)
  const { execFileSync } = cp;
  for (const candidate of ASHLR_PATHS) {
    try {
      if (candidate === "ashlr") return candidate;
      execFileSync("test", ["-f", candidate], { timeout: 500 });
      return candidate;
    } catch {
      // not found at this path
    }
  }
  return "ashlr";
}

function runPulse(window: Window): Promise<ActivityRollup> {
  return new Promise((resolve, reject) => {
    const bin = resolveAshlr();
    const args = ["pulse", "--json", "--window", window];

    let stdout = "";
    let stderr = "";

    const child = cp.spawn(bin, args, {
      env: { ...process.env, PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}` },
      timeout: 30_000,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      // `ashlr pulse --json` intentionally exits 1 when the budget level is
      // 'over' — but it still prints a valid ActivityRollup on stdout. Treat a
      // clean JSON payload as success regardless of exit code; budget.level
      // already conveys 'over' for UI highlighting. Only reject when stdout is
      // empty or unparseable.
      const out = stdout.trim();
      if (out.length > 0) {
        try {
          const parsed = JSON.parse(out) as ActivityRollup;
          resolve(parsed);
          return;
        } catch {
          // fall through to the error paths below
        }
      }
      if (code !== 0) {
        reject(new Error(`ashlr pulse exited ${code ?? "?"}. ${stderr.trim()}`));
        return;
      }
      reject(new Error(`Failed to parse ashlr pulse output: ${out.slice(0, 200)}`));
    });

    child.on("error", (err) => {
      reject(new Error(`Could not run ashlr: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Actions for a project item. */
function ProjectActions({
  projectPath,
  editor,
}: {
  projectPath: string;
  editor: "cursor" | "vscode";
}) {
  const editorLabel = editor === "cursor" ? "Open in Cursor" : "Open in VS Code";
  const scheme = editor === "cursor" ? "cursor" : "vscode";
  const encoded = encodeURIComponent(projectPath).replace(/%2F/g, "/");
  const editorUrl = `${scheme}://file/${encoded}`;

  return (
    <ActionPanel>
      <ActionPanel.Section title="Open">
        <Action.OpenInBrowser
          title={editorLabel}
          url={editorUrl}
          icon={Icon.Code}
        />
        <Action.Open
          title="Reveal in Finder"
          target={projectPath}
          icon={Icon.Finder}
          shortcut={{ modifiers: ["cmd"], key: "f" }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Copy">
        <Action.CopyToClipboard
          title="Copy Path"
          content={projectPath}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Pulse() {
  const [window, setWindow] = useState<Window>("7d");
  const [rollup, setRollup] = useState<ActivityRollup | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const editor = getEditor();
  const runningRef = useRef(false);

  const load = useCallback(
    async (w: Window) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setIsLoading(true);
      setError(null);
      try {
        const data = await runPulse(w);
        setRollup(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        await showToast({
          style: Toast.Style.Failure,
          title: "Pulse failed",
          message: msg,
        });
      } finally {
        setIsLoading(false);
        runningRef.current = false;
      }
    },
    []
  );

  // Initial load
  useEffect(() => {
    load(window);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when window changes
  const handleWindowChange = (w: Window) => {
    setWindow(w);
    load(w);
  };

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <List
        isLoading
        navigationTitle="Pulse"
        searchBarPlaceholder="Computing usage…"
        searchBarAccessory={
          <List.Dropdown
            tooltip="Window"
            value={window}
            onChange={(v) => handleWindowChange(v as Window)}
          >
            {(Object.keys(WINDOW_LABELS) as Window[]).map((w) => (
              <List.Dropdown.Item key={w} value={w} title={WINDOW_LABELS[w]} />
            ))}
          </List.Dropdown>
        }
      />
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error || !rollup) {
    return (
      <List
        navigationTitle="Pulse"
        searchBarPlaceholder="Pulse unavailable"
        searchBarAccessory={
          <List.Dropdown
            tooltip="Window"
            value={window}
            onChange={(v) => handleWindowChange(v as Window)}
          >
            {(Object.keys(WINDOW_LABELS) as Window[]).map((w) => (
              <List.Dropdown.Item key={w} value={w} title={WINDOW_LABELS[w]} />
            ))}
          </List.Dropdown>
        }
      >
        <List.EmptyView
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title="Pulse unavailable"
          description={
            error ??
            "Run `ashlr pulse` in your terminal to check for errors.\n\nMake sure the hub is built and `ashlr` is on PATH."
          }
          actions={
            <ActionPanel>
              <Action
                title="Retry"
                icon={Icon.ArrowClockwise}
                onAction={() => load(window)}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  const { totals, byProject, byModel, budget } = rollup;
  const windowLabel = WINDOW_LABELS[window as Window] ?? window;
  const totalTokens = totals.tokensIn + totals.tokensOut;

  // Refresh action reused in every item's action panel
  const RefreshAction = (
    <Action
      title="Refresh"
      icon={Icon.ArrowClockwise}
      onAction={() => load(window)}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
    />
  );

  return (
    <List
      navigationTitle={`Pulse · ${windowLabel}`}
      searchBarPlaceholder="Filter…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Window"
          value={window}
          onChange={(v) => handleWindowChange(v as Window)}
        >
          {(Object.keys(WINDOW_LABELS) as Window[]).map((w) => (
            <List.Dropdown.Item key={w} value={w} title={WINDOW_LABELS[w]} />
          ))}
        </List.Dropdown>
      }
    >
      {/* ── Section 1: Budget Status ──────────────────────────────────────── */}
      <List.Section title="Budget">
        <List.Item
          icon={budgetIcon(budget.level)}
          title={budget.message}
          subtitle={
            budget.capUsd != null
              ? `Cap: ${fmtCost(budget.capUsd)}`
              : budget.capTokens != null
              ? `Cap: ${fmtTokens(budget.capTokens)} tokens`
              : "No cap set"
          }
          accessories={[
            {
              tag: {
                value: budget.level.toUpperCase(),
                color: budgetTagColor(budget.level),
              },
            },
            { text: `Spent: ${fmtCost(budget.spentUsd)}` },
          ]}
          actions={<ActionPanel>{RefreshAction}</ActionPanel>}
        />
      </List.Section>

      {/* ── Section 2: Totals ─────────────────────────────────────────────── */}
      <List.Section title={`Totals · ${windowLabel}`}>
        <List.Item
          icon={{ source: Icon.BarChart, tintColor: Color.Blue }}
          title="Tokens"
          subtitle={`${fmtTokens(totals.tokensIn)} in · ${fmtTokens(totals.tokensOut)} out`}
          accessories={[
            { text: fmtTokens(totalTokens), tooltip: "Total tokens" },
          ]}
          actions={<ActionPanel>{RefreshAction}</ActionPanel>}
        />
        <List.Item
          icon={{ source: Icon.BankNote, tintColor: Color.Green }}
          title="Estimated Cost"
          subtitle={`${totals.sessions} session${totals.sessions !== 1 ? "s" : ""} · ${totals.commits} commit${totals.commits !== 1 ? "s" : ""}`}
          accessories={[{ text: fmtCost(totals.estCostUsd) }]}
          actions={<ActionPanel>{RefreshAction}</ActionPanel>}
        />
      </List.Section>

      {/* ── Section 3: By Project ─────────────────────────────────────────── */}
      {byProject.length > 0 && (
        <List.Section
          title="By Project"
          subtitle={`${byProject.length} project${byProject.length !== 1 ? "s" : ""}`}
        >
          {byProject.map((proj) => {
            const name = projectName(proj.project);
            const lastSeen = relativeTime(proj.lastActive);
            return (
              <List.Item
                key={proj.project}
                icon={{ source: Icon.Folder, tintColor: Color.Purple }}
                title={name}
                subtitle={`${fmtTokens(proj.tokensIn + proj.tokensOut)} tokens · ${fmtCost(proj.estCostUsd)}`}
                accessories={[
                  {
                    tag: { value: `${proj.sessions}s`, color: Color.Blue },
                    tooltip: `${proj.sessions} session${proj.sessions !== 1 ? "s" : ""}`,
                  },
                  proj.commits > 0
                    ? {
                        tag: { value: `${proj.commits}c`, color: Color.SecondaryText },
                        tooltip: `${proj.commits} commit${proj.commits !== 1 ? "s" : ""}`,
                      }
                    : null,
                  lastSeen ? { text: lastSeen } : null,
                ].filter((a): a is NonNullable<typeof a> => a !== null)}
                actions={
                  <ActionPanel>
                    <ProjectActions projectPath={proj.project} editor={editor} />
                    <ActionPanel.Section>{RefreshAction}</ActionPanel.Section>
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {/* ── Section 4: Top Models ─────────────────────────────────────────── */}
      {byModel.length > 0 && (
        <List.Section
          title="Top Models"
          subtitle={`${byModel.length} model${byModel.length !== 1 ? "s" : ""}`}
        >
          {byModel.map((m) => (
            <List.Item
              key={m.model}
              icon={{ source: Icon.ComputerChip, tintColor: Color.Orange }}
              title={m.model}
              subtitle={`${fmtTokens(m.tokensIn)} in · ${fmtTokens(m.tokensOut)} out`}
              accessories={[
                {
                  tag: { value: `${m.calls} call${m.calls !== 1 ? "s" : ""}`, color: Color.SecondaryText },
                },
                { text: fmtCost(m.estCostUsd) },
              ]}
              actions={<ActionPanel>{RefreshAction}</ActionPanel>}
            />
          ))}
        </List.Section>
      )}

      {/* ── Empty state when all sections are empty ───────────────────────── */}
      {byProject.length === 0 && byModel.length === 0 && (
        <List.EmptyView
          icon={{ source: Icon.Clock, tintColor: Color.SecondaryText }}
          title={`No activity in the ${windowLabel.toLowerCase()}`}
          description="Run some Claude Code sessions or `ashlr run` tasks, then refresh."
          actions={
            <ActionPanel>
              {RefreshAction}
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
