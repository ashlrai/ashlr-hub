/**
 * ceo-dashboard.tsx
 *
 * Raycast command: CEO Dashboard
 *
 * A high-signal command-centre view for Mason's Desktop:
 *
 *  Section 1 — Client & Deliverables
 *    Items from category "Client-Work" and "Product-Docs"
 *
 *  Section 2 — Company Docs
 *    Items from category "Business" and "ASHLRAI"
 *
 *  Section 3 — Today / Focus
 *    Recently-modified repos (top 10) + all dirty repos
 *    (deduped; dirty ones appear first)
 *
 *  Optional footer — Pulse cost/activity note (best-effort read of
 *  ~/.ashlr/pulse-summary.json if it exists; silently omitted otherwise)
 *
 * Actions on every item:
 *   - Open in Editor (primary)   → cursor:// or vscode:// deep link
 *   - Reveal in Finder           → open <path>
 *   - Copy Path                  → clipboard
 */

import {
  List,
  Action,
  ActionPanel,
  Color,
  Icon,
  Clipboard,
  Detail,
  getPreferenceValues,
} from "@raycast/api";
import { useState, useEffect } from "react";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { loadIndex } from "./lib/index";
import { openInEditor, openInFinder } from "./lib/open";
import type { IndexedItem, AshlrIndex } from "./lib/types";

// ── Pulse summary (optional) ──────────────────────────────────────────────────

interface PulseSummary {
  /** Total spend today or for the period, formatted string e.g. "$1.23" */
  cost?: string;
  /** Short activity blurb e.g. "12 sessions · 48k tokens" */
  activity?: string;
  /** ISO timestamp this summary was written */
  updatedAt?: string;
}

const PULSE_PATH = path.join(os.homedir(), ".ashlr", "pulse-summary.json");

function loadPulseSummary(): PulseSummary | null {
  try {
    if (!fs.existsSync(PULSE_PATH)) return null;
    const raw = fs.readFileSync(PULSE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PulseSummary;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Config reader (best-effort; determines editor preference) ─────────────────

interface AshlrConfigMinimal {
  editor?: "cursor" | "vscode";
}

const CONFIG_PATH = path.join(os.homedir(), ".ashlr", "config.json");

interface Prefs {
  editor?: "cursor" | "vscode";
}

/**
 * Resolve the editor preference. Source of truth order:
 *  1. The shared Raycast extension preference (set in Extension Preferences).
 *  2. Fallback: ~/.ashlr/config.json `editor` (the CLI's config) so the
 *     dashboard honours the terminal default when the Raycast pref is unset.
 *  3. Default: "cursor".
 */
function loadEditorPref(): "cursor" | "vscode" {
  try {
    const prefs = getPreferenceValues<Prefs>();
    if (prefs.editor === "vscode" || prefs.editor === "cursor") return prefs.editor;
  } catch {
    // preferences unavailable — fall through to config.json
  }
  try {
    if (!fs.existsSync(CONFIG_PATH)) return "cursor";
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw) as AshlrConfigMinimal;
    return cfg?.editor === "vscode" ? "vscode" : "cursor";
  } catch {
    return "cursor";
  }
}

// ── Category helpers ──────────────────────────────────────────────────────────

/**
 * Case-insensitive match: the item's category starts with one of `prefixes`.
 */
function matchesAnyCategory(item: IndexedItem, prefixes: string[]): boolean {
  if (item.category == null) return false;
  const lower = item.category.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

/**
 * Filter index items by category prefix list, skip symlinks.
 */
function byCategory(idx: AshlrIndex, prefixes: string[]): IndexedItem[] {
  return idx.items.filter(
    (item) => item.kind !== "symlink" && matchesAnyCategory(item, prefixes)
  );
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Relative age label: "just now", "3h ago", "2d ago", etc. */
function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Subtitle for an item: description if present, else relative age. */
function itemSubtitle(item: IndexedItem): string {
  const parts: string[] = [];
  if (item.description) parts.push(item.description);
  parts.push(relativeAge(item.lastModified));
  return parts.join(" · ");
}

/** Accessory tags for an item. */
function itemAccessories(
  item: IndexedItem
): { text: string; icon?: Icon; tooltip?: string }[] {
  const accessories: { text: string; icon?: Icon; tooltip?: string }[] = [];

  if (item.kind === "repo" && item.git) {
    const { dirty, ahead, behind, branch } = item.git;
    if (dirty > 0) {
      accessories.push({
        text: `✎ ${dirty}`,
        tooltip: `${dirty} dirty file${dirty !== 1 ? "s" : ""}`,
      });
    }
    if (ahead > 0) {
      accessories.push({ text: `↑${ahead}`, tooltip: `${ahead} ahead` });
    }
    if (behind > 0) {
      accessories.push({ text: `↓${behind}`, tooltip: `${behind} behind` });
    }
    if (branch && branch !== "main" && branch !== "master") {
      accessories.push({ text: branch, tooltip: "current branch" });
    }
  }

  if (item.language) {
    accessories.push({ text: item.language });
  }

  if (!item.active) {
    accessories.push({ text: "stale" });
  }

  return accessories;
}

/** Icon for an item kind. */
function kindIcon(item: IndexedItem): { source: Icon; tintColor?: Color } {
  if (item.kind === "repo") {
    if (item.git?.dirty && item.git.dirty > 0) {
      return { source: Icon.Dot, tintColor: Color.Yellow };
    }
    return { source: Icon.Code, tintColor: Color.Blue };
  }
  if (item.kind === "doc-folder") return { source: Icon.Folder, tintColor: Color.Purple };
  if (item.kind === "doc") return { source: Icon.Document, tintColor: Color.SecondaryText };
  if (item.kind === "asset") return { source: Icon.Image };
  if (item.kind === "symlink") return { source: Icon.Link, tintColor: Color.SecondaryText };
  return { source: Icon.Circle };
}

// ── Item actions ──────────────────────────────────────────────────────────────

function ItemActions({
  item,
  editor,
}: {
  item: IndexedItem;
  editor: "cursor" | "vscode";
}) {
  const editorLabel = editor === "cursor" ? "Open in Cursor" : "Open in VSCode";
  return (
    <ActionPanel>
      <ActionPanel.Section title="Open">
        <Action
          title={editorLabel}
          icon={Icon.Code}
          onAction={() => openInEditor(item.path, editor)}
        />
        <Action
          title="Reveal in Finder"
          icon={Icon.Finder}
          onAction={() => openInFinder(item.path)}
          shortcut={{ modifiers: ["cmd"], key: "f" }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Copy">
        <Action
          title="Copy Path"
          icon={Icon.Clipboard}
          onAction={() => Clipboard.copy(item.path)}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        />
        {item.remote && (
          <Action
            title="Copy Remote URL"
            icon={Icon.Link}
            onAction={() => Clipboard.copy(item.remote!)}
            shortcut={{ modifiers: ["cmd", "shift"], key: "u" }}
          />
        )}
      </ActionPanel.Section>
    </ActionPanel>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <Detail
      markdown={`## No index found\n\nRun \`ashlr index\` in your terminal to build the index, then reopen this command.\n\n\`\`\`\nashlr index\n\`\`\``}
    />
  );
}

// ── Pulse footer ──────────────────────────────────────────────────────────────

function pulseFooter(pulse: PulseSummary | null): string | undefined {
  if (!pulse) return undefined;
  const parts: string[] = [];
  if (pulse.cost) parts.push(`Cost: ${pulse.cost}`);
  if (pulse.activity) parts.push(pulse.activity);
  if (pulse.updatedAt) {
    parts.push(`as of ${relativeAge(pulse.updatedAt)}`);
  }
  return parts.length > 0 ? `Pulse · ${parts.join(" · ")}` : undefined;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CeoDashboard() {
  const [index, setIndex] = useState<AshlrIndex | null | undefined>(undefined);
  const [editor, setEditor] = useState<"cursor" | "vscode">("cursor");
  const [pulse, setPulse] = useState<PulseSummary | null>(null);

  // Load data synchronously on mount (all reads are local, tiny JSON files —
  // blocking is negligible and simpler than async state juggling).
  useEffect(() => {
    setEditor(loadEditorPref());
    setPulse(loadPulseSummary());
    setIndex(loadIndex());
  }, []);

  // Still loading
  if (index === undefined) {
    return <List isLoading={true} navigationTitle="CEO Dashboard" />;
  }

  // Index missing — prompt the user to run ashlr index
  if (index === null) {
    return <EmptyState />;
  }

  // ── Derive sections ──────────────────────────────────────────────────────

  // Section 1: Client & Deliverables
  const clientItems = byCategory(index, ["client-work", "product-docs"]);

  // Section 2: Company Docs
  const companyItems = byCategory(index, ["business", "ashlrai"]);

  // Section 3: Today / Focus — dirty repos + recently modified repos (top 10), deduped
  const dirtyRepos = index.items.filter(
    (item) =>
      item.kind === "repo" &&
      item.git != null &&
      item.git.dirty > 0
  );

  const dirtyIds = new Set(dirtyRepos.map((r) => r.id));

  const recentRepos = [...index.items]
    .filter(
      (item) =>
        item.kind === "repo" &&
        !dirtyIds.has(item.id)
    )
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    .slice(0, 10);

  const focusItems: IndexedItem[] = [...dirtyRepos, ...recentRepos];

  // ── Pulse footer text ────────────────────────────────────────────────────
  const footer = pulseFooter(pulse);

  // ── Age of index ─────────────────────────────────────────────────────────
  const indexAgeLabel = `Index built ${relativeAge(index.generatedAt)} · ${index.items.length} items`;

  return (
    <List
      navigationTitle="CEO Dashboard"
      searchBarPlaceholder="Filter items…"
    >
      {/* ── Section 1: Client & Deliverables ──────────────────────────── */}
      <List.Section
        title="Client & Deliverables"
        subtitle={`${clientItems.length} item${clientItems.length !== 1 ? "s" : ""}`}
      >
        {clientItems.length === 0 ? (
          <List.Item
            title="No items indexed in Client-Work or Product-Docs"
            icon={{ source: Icon.Info, tintColor: Color.SecondaryText }}
          />
        ) : (
          clientItems.map((item) => (
            <List.Item
              key={item.id}
              icon={kindIcon(item)}
              title={item.name}
              subtitle={itemSubtitle(item)}
              accessories={itemAccessories(item)}
              actions={<ItemActions item={item} editor={editor} />}
            />
          ))
        )}
      </List.Section>

      {/* ── Section 2: Company Docs ───────────────────────────────────── */}
      <List.Section
        title="Company Docs"
        subtitle={`${companyItems.length} item${companyItems.length !== 1 ? "s" : ""}`}
      >
        {companyItems.length === 0 ? (
          <List.Item
            title="No items indexed in Business or ASHLRAI"
            icon={{ source: Icon.Info, tintColor: Color.SecondaryText }}
          />
        ) : (
          companyItems.map((item) => (
            <List.Item
              key={item.id}
              icon={kindIcon(item)}
              title={item.name}
              subtitle={itemSubtitle(item)}
              accessories={itemAccessories(item)}
              actions={<ItemActions item={item} editor={editor} />}
            />
          ))
        )}
      </List.Section>

      {/* ── Section 3: Today / Focus ──────────────────────────────────── */}
      <List.Section
        title="Today / Focus"
        subtitle={
          dirtyRepos.length > 0
            ? `${dirtyRepos.length} dirty · ${recentRepos.length} recent`
            : `${recentRepos.length} recently modified`
        }
      >
        {focusItems.length === 0 ? (
          <List.Item
            title="No active repos found"
            icon={{ source: Icon.Info, tintColor: Color.SecondaryText }}
          />
        ) : (
          focusItems.map((item) => (
            <List.Item
              key={item.id}
              icon={kindIcon(item)}
              title={item.name}
              subtitle={itemSubtitle(item)}
              accessories={itemAccessories(item)}
              actions={<ItemActions item={item} editor={editor} />}
            />
          ))
        )}
      </List.Section>

      {/* ── Footer: index age + optional Pulse note ───────────────────── */}
      <List.Section title={footer ?? indexAgeLabel}>
        {footer && (
          <List.Item
            title={indexAgeLabel}
            icon={{ source: Icon.Clock, tintColor: Color.SecondaryText }}
          />
        )}
      </List.Section>
    </List>
  );
}
