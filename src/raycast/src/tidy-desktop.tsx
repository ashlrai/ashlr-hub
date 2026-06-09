/**
 * tidy-desktop.tsx — Raycast command: "Tidy Desktop"
 *
 * Shows the proposed tidy moves (dry-run) by invoking `ashlr tidy --json`.
 * Parses the TidyPlan JSON emitted on stdout. Offers:
 *   - "Apply All" action (with confirmation) → `ashlr tidy --apply`
 *   - Per-item "Copy Source Path" and "Copy Destination Path" actions
 *
 * The `ashlr` binary is resolved in priority order:
 *   1. ~/.local/bin/ashlr  (standard install target)
 *   2. /usr/local/bin/ashlr
 *   3. plain `ashlr` on PATH via env
 */

import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Detail,
  Icon,
  List,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types (inlined from core/types.ts — Raycast package has its own tsconfig)
// ---------------------------------------------------------------------------

interface TidyMove {
  from: string;
  to: string;
  rule: string;
}

interface TidyPlan {
  moves: TidyMove[];
  skipped: { path: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Resolve `ashlr` binary
// ---------------------------------------------------------------------------

function resolveAshlr(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "ashlr"),
    "/usr/local/bin/ashlr",
    "/opt/homebrew/bin/ashlr",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back to bare name; will fail with a clear error if not on PATH
  return "ashlr";
}

const ASHLR = resolveAshlr();

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

type FetchState =
  | { status: "loading" }
  | { status: "ok"; plan: TidyPlan }
  | { status: "error"; message: string };

/**
 * Run `ashlr tidy --json` synchronously and parse stdout as TidyPlan.
 * Returns an error state if the binary is missing, exits non-zero, or the
 * output is not valid JSON shaped like a TidyPlan.
 */
function fetchTidyPlan(): FetchState {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(ASHLR, ["tidy", "--json"], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${join(homedir(), ".local", "bin")}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      },
    });
  } catch (err) {
    return {
      status: "error",
      message: `Failed to spawn ashlr: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.error) {
    return {
      status: "error",
      message: `ashlr not found or could not be executed: ${result.error.message}\n\nMake sure the ashlr CLI is installed at ~/.local/bin/ashlr.`,
    };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr as string | null) ?? "";
    const stdout = (result.stdout as string | null) ?? "";
    return {
      status: "error",
      message: `ashlr tidy --json exited with code ${result.status}.\n\nstdout: ${stdout}\nstderr: ${stderr}`,
    };
  }

  const raw = ((result.stdout as string | null) ?? "").trim();
  if (!raw) {
    return {
      status: "error",
      message:
        "ashlr tidy --json produced no output. The CLI may not yet support the --json flag.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "error",
      message: `ashlr tidy --json returned non-JSON output:\n\n${raw.slice(0, 500)}`,
    };
  }

  if (!isPlanShape(parsed)) {
    return {
      status: "error",
      message: `ashlr tidy --json returned unexpected JSON shape:\n\n${raw.slice(0, 500)}`,
    };
  }

  return { status: "ok", plan: parsed };
}

function isPlanShape(v: unknown): v is TidyPlan {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return Array.isArray(obj.moves) && Array.isArray(obj.skipped);
}

// ---------------------------------------------------------------------------
// Apply helper
// ---------------------------------------------------------------------------

/**
 * Run `ashlr tidy --apply` synchronously.
 * Returns null on success, or an error message string.
 */
function runApplyTidy(): string | null {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(ASHLR, ["tidy", "--apply"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${join(homedir(), ".local", "bin")}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      },
    });
  } catch (err) {
    return `Failed to spawn ashlr: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (result.error) {
    return `ashlr not found: ${result.error.message}`;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr as string | null) ?? "";
    return `ashlr tidy --apply exited ${result.status}. ${stderr}`.trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Shorten a long absolute path to at most ~60 chars with leading ellipsis. */
function shortPath(p: string, maxLen = 60): string {
  if (p.length <= maxLen) return p;
  return "…" + p.slice(p.length - (maxLen - 1));
}

/** Extract the basename of a path. */
function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}

// ---------------------------------------------------------------------------
// Main command component
// ---------------------------------------------------------------------------

export default function TidyDesktop() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // Track whether we should reload after apply
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // Fetch on mount and whenever reloadKey changes
    const s = fetchTidyPlan();
    setState(s);
  }, [reloadKey]);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (state.status === "loading") {
    return (
      <List isLoading={true} searchBarPlaceholder="Computing tidy plan…" />
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (state.status === "error") {
    return (
      <Detail
        markdown={`## Tidy Desktop — Error\n\n\`\`\`\n${state.message}\n\`\`\``}
        actions={
          <ActionPanel>
            <Action
              title="Retry"
              icon={Icon.ArrowClockwise}
              onAction={() => {
                setState({ status: "loading" });
                setReloadKey((k) => k + 1);
              }}
            />
          </ActionPanel>
        }
      />
    );
  }

  // ── OK ───────────────────────────────────────────────────────────────────
  const { plan } = state;
  const moveCount = plan.moves.length;
  const skipCount = plan.skipped.length;

  async function handleApplyAll() {
    const confirmed = await confirmAlert({
      title: "Apply Tidy Moves?",
      message: `This will move ${moveCount} item${moveCount !== 1 ? "s" : ""} on your Desktop. This cannot be undone automatically.`,
      primaryAction: {
        title: "Apply",
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (!confirmed) return;

    await showToast({ style: Toast.Style.Animated, title: "Applying tidy…" });

    const err = runApplyTidy();
    if (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Tidy failed",
        message: err,
      });
    } else {
      await showHUD(
        `Moved ${moveCount} item${moveCount !== 1 ? "s" : ""}. Desktop is tidy.`,
      );
      // Reload to show empty/updated plan
      setState({ status: "loading" });
      setReloadKey((k) => k + 1);
    }
  }

  const emptyContent =
    moveCount === 0 ? (
      <List.EmptyView
        icon={Icon.Checkmark}
        title="Desktop is already tidy"
        description={`${skipCount} item${skipCount !== 1 ? "s" : ""} skipped (keepers, repos, symlinks).`}
      />
    ) : undefined;

  return (
    <List
      isLoading={false}
      searchBarPlaceholder="Filter moves…"
      navigationTitle={
        moveCount === 0
          ? "Tidy Desktop — nothing to move"
          : `Tidy Desktop — ${moveCount} move${moveCount !== 1 ? "s" : ""} planned`
      }
    >
      {emptyContent}

      {/* ── Planned Moves ── */}
      {moveCount > 0 && (
        <List.Section
          title="Planned Moves"
          subtitle={`${moveCount} item${moveCount !== 1 ? "s" : ""}`}
        >
          {plan.moves.map((move, idx) => (
            <MoveItem
              key={`${move.from}-${idx}`}
              move={move}
              onApplyAll={handleApplyAll}
            />
          ))}
        </List.Section>
      )}

      {/* ── Skipped ── */}
      {skipCount > 0 && (
        <List.Section
          title="Skipped"
          subtitle={`${skipCount} item${skipCount !== 1 ? "s" : ""} (keepers, repos, symlinks)`}
        >
          {plan.skipped.map((s, idx) => (
            <List.Item
              key={`skip-${s.path}-${idx}`}
              icon={{
                source: Icon.MinusCircle,
                tintColor: Color.SecondaryText,
              }}
              title={basename(s.path)}
              subtitle={shortPath(s.path)}
              accessories={[{ text: s.reason, tooltip: s.reason }]}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}

// ---------------------------------------------------------------------------
// MoveItem sub-component
// ---------------------------------------------------------------------------

interface MoveItemProps {
  move: TidyMove;
  onApplyAll: () => Promise<void>;
}

function MoveItem({ move, onApplyAll }: MoveItemProps) {
  const fromName = basename(move.from);
  const toDir = basename(
    move.to.endsWith(fromName)
      ? move.to.slice(0, move.to.length - fromName.length - 1)
      : move.to,
  );

  return (
    <List.Item
      icon={{ source: Icon.ArrowRight, tintColor: Color.Blue }}
      title={fromName}
      subtitle={`→ ${toDir}`}
      accessories={[
        {
          tag: { value: move.rule, color: Color.Purple },
          tooltip: `Rule: ${move.rule}`,
        },
        {
          text: shortPath(move.from, 45),
          tooltip: move.from,
        },
      ]}
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="From" text={move.from} />
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.Label title="To" text={move.to} />
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.Label title="Rule" text={move.rule} />
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Apply">
            <Action
              title="Apply All Moves"
              icon={Icon.Checkmark}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["cmd"], key: "return" }}
              onAction={onApplyAll}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Copy">
            <Action.CopyToClipboard
              title="Copy Source Path"
              content={move.from}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
            <Action.CopyToClipboard
              title="Copy Destination Path"
              content={move.to}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Reveal">
            <Action.ShowInFinder
              title="Reveal Source in Finder"
              path={move.from}
              shortcut={{ modifiers: ["cmd"], key: "f" }}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
