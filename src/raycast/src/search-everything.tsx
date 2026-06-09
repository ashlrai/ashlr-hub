/**
 * search-everything.tsx
 *
 * Raycast "Search Everything" command.
 *
 * Shows every item in ~/.ashlr/index.json as a searchable List.
 * Uses the canonical lib/index-reader for data and lib/open for deep-links
 * so all commands share one implementation.
 *
 * Actions per item:
 *   ⌘ Enter       — Open in Editor (cursor:// or vscode://)
 *   ⌘ F           — Open in Finder
 *   ⌘ T           — Open in Terminal  (repos / folders)
 *   ⌘ .           — Copy Path
 *   ⌘⇧ R          — Resume Session  (`entire resume <branch>`)
 *   ⌘⇧ A          — Launch Agent    (`aw` in that dir)
 *   ⌘⇧ C          — Launch Claude   (`claude` in that dir)
 */

import {
  List,
  Action,
  ActionPanel,
  Icon,
  Color,
  showHUD,
  closeMainWindow,
  Clipboard,
  getPreferenceValues,
  openExtensionPreferences,
} from "@raycast/api";
import { spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import { useEffect, useState } from "react";

import { loadIndex } from "./lib/index";
import type { AshlrIndex, IndexedItem, ItemKind } from "./lib/types";
import { openInEditor, openInFinder } from "./lib/open";

// ---------------------------------------------------------------------------
// Preferences (declared in package.json commands[0].preferences)
// ---------------------------------------------------------------------------

interface Prefs {
  editor: "cursor" | "vscode";
}

function getPrefs(): Prefs {
  try {
    return getPreferenceValues<Prefs>();
  } catch {
    // Safe fallback if preferences haven't been configured yet.
    return { editor: "cursor" };
  }
}

// ---------------------------------------------------------------------------
// Helpers — kind → Raycast icon
// ---------------------------------------------------------------------------

const KIND_ICON: Record<ItemKind, Icon> = {
  repo: Icon.Code,
  "doc-folder": Icon.Folder,
  doc: Icon.Document,
  asset: Icon.Image,
  symlink: Icon.Link,
  other: Icon.Circle,
};

// ---------------------------------------------------------------------------
// Helpers — relative time label
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ---------------------------------------------------------------------------
// Helpers — run a CLI tool in a directory, fire-and-forget
// ---------------------------------------------------------------------------

function runInDir(
  cmd: string,
  args: string[],
  cwd: string,
  hudMsg: string,
): void {
  // Close Raycast first, then launch after a short delay so the window is gone.
  closeMainWindow({ clearRootSearch: false });
  setTimeout(() => {
    try {
      // Raycast's Node host runs with a minimal PATH that usually omits
      // ~/.local/bin (where entire/aw/claude live), so set an explicit PATH
      // that includes the standard tool install locations.
      const toolPath = `${path.join(os.homedir(), ".local", "bin")}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`;
      const child = spawn("/usr/bin/env", [cmd, ...args], {
        cwd,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PATH: toolPath },
      });
      child.on("error", (err: Error) => {
        showHUD(`Failed to run ${cmd}: ${err.message}`);
      });
      child.unref();
      showHUD(hudMsg);
    } catch (err) {
      showHUD(`Failed to run ${cmd}: ${(err as Error).message}`);
    }
  }, 150);
}

// ---------------------------------------------------------------------------
// Helpers — open in macOS Terminal.app via AppleScript
// ---------------------------------------------------------------------------

function openInTerminal(itemPath: string): void {
  // Use the directory for directories, parent dir for plain files.
  const dir = path.extname(itemPath) ? path.dirname(itemPath) : itemPath;
  // Escape backslashes and single quotes in the path for AppleScript.
  const safe = dir.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const script = [
    'tell application "Terminal"',
    `  do script "cd '${safe}'; clear"`,
    "  activate",
    "end tell",
  ].join("\n");
  const child = spawn("/usr/bin/osascript", ["-e", script], {
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

// ---------------------------------------------------------------------------
// Accessories builder
// ---------------------------------------------------------------------------

function buildAccessories(item: IndexedItem): List.Item.Accessory[] {
  const acc: List.Item.Accessory[] = [];

  // Category label
  if (item.category) {
    acc.push({ tag: { value: item.category, color: Color.Blue } });
  }

  // Dirty files badge (orange dot + count)
  if (item.git && item.git.dirty > 0) {
    acc.push({
      tag: { value: `●${item.git.dirty}`, color: Color.Orange },
      tooltip: `${item.git.dirty} dirty file(s)`,
    });
  }

  // Ahead / behind upstream
  if (item.git) {
    if (item.git.ahead > 0) {
      acc.push({
        tag: { value: `↑${item.git.ahead}`, color: Color.Yellow },
        tooltip: `${item.git.ahead} commit(s) ahead of upstream`,
      });
    }
    if (item.git.behind > 0) {
      acc.push({
        tag: { value: `↓${item.git.behind}`, color: Color.Red },
        tooltip: `${item.git.behind} commit(s) behind upstream`,
      });
    }
  }

  // Active / stale badge for repos and doc-folders
  if (item.kind === "repo" || item.kind === "doc-folder") {
    acc.push({
      tag: {
        value: item.active ? "active" : "stale",
        color: item.active ? Color.Green : Color.SecondaryText,
      },
    });
  }

  // Last-touched timestamp (always shown)
  acc.push({
    text: relativeTime(item.lastModified),
    tooltip: `Last modified: ${new Date(item.lastModified).toLocaleString()}`,
  });

  return acc;
}

// ---------------------------------------------------------------------------
// Actions — per-item ActionPanel
// ---------------------------------------------------------------------------

function ItemActions({
  item,
  editor,
}: {
  item: IndexedItem;
  editor: "cursor" | "vscode";
}) {
  // Symlinks resolve to their target for open actions.
  const targetPath = item.linkTarget ?? item.path;
  const isDir = item.kind !== "doc" && item.kind !== "asset";
  const editorLabel = editor === "cursor" ? "Cursor" : "VS Code";

  return (
    <ActionPanel>
      {/* ── Primary opens ─────────────────────────────────────────────── */}
      <ActionPanel.Section title="Open">
        <Action
          title={`Open in ${editorLabel}`}
          icon={Icon.Code}
          onAction={() => {
            closeMainWindow({ clearRootSearch: false });
            openInEditor(targetPath, editor);
          }}
        />

        <Action
          title="Open in Finder"
          icon={Icon.Finder}
          shortcut={{ modifiers: ["cmd"], key: "f" }}
          onAction={() => {
            closeMainWindow({ clearRootSearch: false });
            openInFinder(targetPath);
          }}
        />

        {isDir && (
          <Action
            title="Open in Terminal"
            icon={Icon.Terminal}
            shortcut={{ modifiers: ["cmd"], key: "t" }}
            onAction={() => {
              closeMainWindow({ clearRootSearch: false });
              openInTerminal(targetPath);
            }}
          />
        )}
      </ActionPanel.Section>

      {/* ── Clipboard ─────────────────────────────────────────────────── */}
      <ActionPanel.Section title="Clipboard">
        <Action
          title="Copy Path"
          icon={Icon.Clipboard}
          shortcut={{ modifiers: ["cmd"], key: "." }}
          onAction={async () => {
            await Clipboard.copy(targetPath);
            await showHUD("Path copied");
          }}
        />
        {item.remote && (
          <Action
            title="Copy Remote URL"
            icon={Icon.Link}
            onAction={async () => {
              await Clipboard.copy(item.remote!);
              await showHUD("Remote URL copied");
            }}
          />
        )}
      </ActionPanel.Section>

      {/* ── Agent actions (repos only) ────────────────────────────────── */}
      {item.kind === "repo" && (
        <ActionPanel.Section title="Agents">
          <Action
            title="Resume Session"
            icon={Icon.Play}
            shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            onAction={() => {
              const branch = item.git?.branch ?? "main";
              runInDir(
                "entire",
                ["resume", branch],
                targetPath,
                `Resumed "${branch}" in ${item.name}`,
              );
            }}
          />
          <Action
            title="Launch Agent (aw)"
            icon={Icon.Bolt}
            shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
            onAction={() => {
              runInDir("aw", [], targetPath, `Agent launched in ${item.name}`);
            }}
          />
          <Action
            title="Launch Claude"
            icon={Icon.Person}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            onAction={() => {
              runInDir(
                "claude",
                [],
                targetPath,
                `Claude launched in ${item.name}`,
              );
            }}
          />
        </ActionPanel.Section>
      )}

      {/* ── Settings ──────────────────────────────────────────────────── */}
      <ActionPanel.Section>
        <Action
          title="Extension Preferences"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Section grouping — group by category; "Other" always last
// ---------------------------------------------------------------------------

interface Section {
  title: string;
  items: IndexedItem[];
}

function groupByCategory(items: IndexedItem[]): Section[] {
  const map = new Map<string, IndexedItem[]>();
  for (const item of items) {
    const key = item.category ?? "Other";
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }
  return [...map.keys()]
    .sort((a, b) => {
      if (a === "Other") return 1;
      if (b === "Other") return -1;
      return a.localeCompare(b);
    })
    .map((title) => ({ title, items: map.get(title)! }));
}

// ---------------------------------------------------------------------------
// Root command component
// ---------------------------------------------------------------------------

/**
 * Three render states:
 *   "loading"  — index read has not completed yet (shows spinner)
 *   null       — index is missing / never built (shows empty-state + hint)
 *   AshlrIndex — normal searchable list grouped by category
 */
type IndexState = "loading" | AshlrIndex | null;

export default function SearchEverything() {
  const [indexState, setIndexState] = useState<IndexState>("loading");
  const prefs = getPrefs();

  useEffect(() => {
    // loadIndex is synchronous; defer one tick so Raycast paints the spinner.
    const id = setTimeout(() => setIndexState(loadIndex()), 0);
    return () => clearTimeout(id);
  }, []);

  // ── Loading ────────────────────────────────────────────────────────────
  if (indexState === "loading") {
    return (
      <List
        isLoading
        navigationTitle="Search Everything"
        searchBarPlaceholder="Loading index…"
      />
    );
  }

  // ── Index missing ──────────────────────────────────────────────────────
  if (indexState === null) {
    return (
      <List
        navigationTitle="Search Everything"
        searchBarPlaceholder="Run `ashlr index` to build the index…"
      >
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Index not found"
          description={
            `${os.homedir()}/.ashlr/index.json does not exist.\n` +
            "Run `ashlr index` in your terminal, then reopen this command."
          }
          actions={
            <ActionPanel>
              <Action
                title="Copy Build Command"
                icon={Icon.Clipboard}
                onAction={async () => {
                  await Clipboard.copy("ashlr index");
                  await showHUD("Copied: ashlr index");
                }}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  // ── Normal list ────────────────────────────────────────────────────────
  const index = indexState;
  const sections = groupByCategory(index.items);
  const builtLabel = `${index.items.length} items · built ${relativeTime(index.generatedAt)}`;

  return (
    <List
      navigationTitle="Search Everything"
      searchBarPlaceholder="Search repos, docs, assets…"
      throttle
    >
      {sections.map((section) => (
        <List.Section
          key={section.title}
          title={section.title}
          subtitle={String(section.items.length)}
        >
          {section.items.map((item) => (
            <List.Item
              key={item.id}
              icon={{
                source: KIND_ICON[item.kind],
                tintColor: Color.PrimaryText,
              }}
              title={item.name}
              subtitle={item.description ?? undefined}
              keywords={[
                item.kind,
                item.category ?? "",
                item.org ?? "",
                item.language ?? "",
                item.git?.branch ?? "",
              ].filter(Boolean)}
              accessories={buildAccessories(item)}
              actions={<ItemActions item={item} editor={prefs.editor} />}
            />
          ))}
        </List.Section>
      ))}

      {/* Index metadata footer */}
      {index.items.length > 0 && (
        <List.Section title="" subtitle={builtLabel} />
      )}
    </List>
  );
}
