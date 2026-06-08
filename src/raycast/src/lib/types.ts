/**
 * Re-exports of the canonical ashlr-hub types for use inside the Raycast
 * extension package. The Raycast extension lives in its own package.json and
 * is excluded from the root tsconfig, so it cannot import from ../../core/.
 *
 * These are IDENTICAL copies of the types in src/core/types.ts — update both
 * if the contract changes.
 */

export interface TidyRule {
  match: string;
  matchType: "glob" | "regex" | "ext";
  dest: string;
  description?: string;
}

export interface AshlrConfig {
  version: number;
  roots: string[];
  editor: "cursor" | "vscode";
  staleDays: number;
  categories: Record<string, string>;
  tidyRules: TidyRule[];
  keepers: string[];
  models: { lmstudio: string; ollama: string; providerChain: string[] };
  telemetry: { pulse?: string };
  tools: Record<string, string>;
}

export type ItemKind = "repo" | "doc-folder" | "doc" | "asset" | "symlink" | "other";

export interface GitStatus {
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
}

export interface IndexedItem {
  id: string;
  name: string;
  path: string;
  kind: ItemKind;
  category: string | null;
  description: string | null;
  org: string | null;
  remote: string | null;
  language: string | null;
  lastModified: string;
  active: boolean;
  sizeBytes?: number;
  git?: GitStatus;
  linkTarget?: string;
}

export interface AshlrIndex {
  version: number;
  generatedAt: string;
  root: string;
  items: IndexedItem[];
}

export interface TidyMove {
  from: string;
  to: string;
  rule: string;
}

export interface TidyPlan {
  moves: TidyMove[];
  skipped: { path: string; reason: string }[];
}
