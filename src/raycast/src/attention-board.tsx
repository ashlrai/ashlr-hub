/**
 * attention-board.tsx — the "Attention Board" Raycast command.
 *
 * Surfaces repos that need the developer's attention: uncommitted changes,
 * commits ahead of upstream, and stale repos that still have git state.
 *
 * Reads the pre-built ~/.ashlr/index.json (never re-scans the filesystem) and
 * derives the attention view via attentionItems() in ./lib/index-reader.
 *
 * Auto-revalidates every 2 s via useAutoRevalidate (M13).
 */
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  List,
  getPreferenceValues,
  showHUD,
} from "@raycast/api";
import { useEffect, useState } from "react";
import * as os from "os";

import { loadIndex } from "./lib/index";
import { attentionItems } from "./lib/index-reader";
import { openInEditor, openInFinder } from "./lib/open";
import type { AshlrIndex, IndexedItem } from "./lib/types";
import { useAutoRevalidate } from "./lib/ashlr-runner";

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

/** Compact relative-time label from an ISO timestamp. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Build the right-aligned accessories for an attention item. */
function buildAccessories(item: IndexedItem): List.Item.Accessory[] {
  const acc: List.Item.Accessory[] = [];

  if (item.category) {
    acc.push({ tag: { value: item.category, color: Color.Blue } });
  }

  const git = item.git;
  if (git) {
    if (git.dirty > 0) {
      acc.push({ tag: { value: `${git.dirty} dirty`, color: Color.Red } });
    }
    if (git.ahead > 0) {
      acc.push({ tag: { value: `↑${git.ahead}`, color: Color.Yellow } });
    }
    if (git.behind > 0) {
      acc.push({ tag: { value: `↓${git.behind}`, color: Color.Orange } });
    }
    acc.push({ text: git.branch });
  }

  if (!item.active) {
    acc.push({ icon: Icon.Clock, tooltip: "Stale" });
  }

  acc.push({ text: relativeTime(item.lastModified) });
  return acc;
}

type IndexState = "loading" | AshlrIndex | null;

export default function AttentionBoard() {
  const [indexState, setIndexState] = useState<IndexState>("loading");
  const editor = getEditor();

  /** Re-reads the index from disk. Safe to call on any tick. */
  function refresh() {
    setIndexState(loadIndex());
  }

  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, []);

  // Auto-revalidate every 2 s — reads the pre-built JSON file, never re-scans (M13)
  useAutoRevalidate(refresh, 2_000, indexState !== "loading");

  if (indexState === "loading") {
    return (
      <List
        isLoading
        navigationTitle="Attention Board"
        searchBarPlaceholder="Loading index…"
      />
    );
  }

  if (indexState === null) {
    return (
      <List
        navigationTitle="Attention Board"
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

  const index = indexState;
  const items = attentionItems(index);
  const editorLabel = editor === "cursor" ? "Cursor" : "VS Code";

  return (
    <List
      navigationTitle="Attention Board"
      searchBarPlaceholder="Filter repos needing attention…"
    >
      {items.length === 0 ? (
        <List.EmptyView
          icon={Icon.CheckCircle}
          title="All clear"
          description="No dirty, ahead, or stale repos right now."
        />
      ) : (
        <List.Section title="Needs attention" subtitle={String(items.length)}>
          {items.map((item) => {
            const targetPath = item.linkTarget ?? item.path;
            return (
              <List.Item
                key={item.id}
                icon={{ source: Icon.HardDrive, tintColor: Color.PrimaryText }}
                title={item.name}
                subtitle={item.description ?? undefined}
                accessories={buildAccessories(item)}
                actions={
                  <ActionPanel>
                    <Action
                      title={`Open in ${editorLabel}`}
                      icon={Icon.Code}
                      onAction={() => openInEditor(targetPath, editor)}
                    />
                    <Action
                      title="Reveal in Finder"
                      icon={Icon.Finder}
                      onAction={() => openInFinder(targetPath)}
                    />
                    <Action.CopyToClipboard
                      title="Copy Path"
                      content={targetPath}
                      shortcut={{ modifiers: ["cmd"], key: "." }}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
