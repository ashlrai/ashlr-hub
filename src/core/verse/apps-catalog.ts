/**
 * The Apps & Accounts catalog — the FIXED list C6's `apps.ts` probes and
 * renders (SPEC-310C §4; contract unit C0).
 *
 * Static data only: which binaries to look for, the zero-cost version command,
 * each agent's OWN launch command, and the id `ollama launch` knows it by.
 * Detection (is it installed, which version, is Ollama's integration present)
 * is C6's, against the login-shell PATH from login-path.ts — a sidecar started
 * by launchd has a PATH where /opt/homebrew/bin, ~/.local/bin and ~/.grok/bin
 * do not exist, and every row would lie "not installed".
 *
 * Nothing here runs anything. Every command is an argv (never a shell string)
 * and none carries a secret. Rows never show a vendor logo: a monogram tile.
 *
 * BROWSER-SAFE: plain data plus one pure parser.
 */
import type { VerseEngine } from './types.js';

export type AppCatalogGroup = 'desktop' | 'terminal-agents' | 'local-models';

/**
 * A desktop integration `ollama launch <id>` switches on, and `--restore`
 * switches back. These change ANOTHER app's settings, so C6 confirms both
 * directions and shows both commands (VerseAppToggle).
 */
export interface AppDesktopToggle {
  onCommand: readonly string[];
  restoreCommand: readonly string[];
  /**
   * Off by default. Claude Desktop's switch REPLACES its own models with local
   * ones — the wrong trade for the app Mason directs this work from, and Verse's
   * local seat already routes to Ollama (SPEC-310C §0.5). Shown off, with Restore.
   */
  defaultEnabled: false;
  /** One sentence the confirmation shows under the command. */
  note: string;
}

/** A zero-cost liveness probe for a local model runtime. */
export interface AppRuntimeProbe {
  /** GET this; a 2xx within the timeout = up. Loopback only. */
  url: string;
  /** What a good answer lists, for the row's detail line. */
  reads: 'version' | 'health' | 'models';
}

export interface AppCatalogEntry {
  id: string;
  name: string;
  /** Tile letter(s). Engine-backed rows use ENGINE_MONOGRAM's letter. */
  monogram: string;
  /** Tints the tile; null = neutral. */
  engine: VerseEngine | null;
  group: AppCatalogGroup;
  /** One line, neutral — what it is, not a sales pitch. */
  description: string;
  /** Binary names looked up on the login-shell PATH, first hit wins. Empty = not a CLI. */
  binaries: readonly string[];
  /** argv AFTER the binary that prints its version. Zero-cost: never a model call. */
  versionArgs: readonly string[];
  /** The agent's own launch command (the copy pill and [Launch ▸]); null when it has none. */
  launch: readonly string[] | null;
  /**
   * The id `ollama launch <id>` uses. The ⧉ pill appears ONLY when the
   * INSTALLED ollama lists it (parseOllamaLaunchIntegrations) — a version bump
   * that drops an integration must not leave a command that no longer works.
   */
  ollamaLaunchId: string | null;
  desktopToggle: AppDesktopToggle | null;
  probe: AppRuntimeProbe | null;
}

/**
 * SPEC-310C §4 order within each group. Observed on this machine 2026-09-23:
 * installed — ollama 0.33.3, claude, codex, hermes, grok, aider, goose,
 * llama-server; missing — opencode, droid, pi, cline, lms.
 */
export const APPS_CATALOG: readonly AppCatalogEntry[] = [
  // ── DESKTOP ─────────────────────────────────────────────────────────────
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    monogram: 'C',
    engine: 'claude',
    group: 'desktop',
    description: 'Use Ollama models in Claude Desktop',
    binaries: [],
    versionArgs: [],
    launch: null,
    ollamaLaunchId: 'claude-desktop',
    desktopToggle: {
      onCommand: ['ollama', 'launch', 'claude-desktop'],
      restoreCommand: ['ollama', 'launch', 'claude-desktop', '--restore'],
      defaultEnabled: false,
      note: "Replaces Claude Desktop's own models with local ones until restored. Verse's local seat already uses Ollama.",
    },
    probe: null,
  },
  {
    id: 'hermes-desktop',
    name: 'Hermes Desktop',
    monogram: 'H',
    engine: null,
    group: 'desktop',
    description: 'Use Ollama models in Hermes Desktop',
    binaries: [],
    versionArgs: [],
    launch: null,
    ollamaLaunchId: 'hermes-desktop',
    desktopToggle: {
      onCommand: ['ollama', 'launch', 'hermes-desktop'],
      restoreCommand: ['ollama', 'launch', 'hermes-desktop', '--restore'],
      defaultEnabled: false,
      note: "Points Hermes Desktop at local Ollama models until restored.",
    },
    probe: null,
  },
  // ── TERMINAL AGENTS ─────────────────────────────────────────────────────
  agent('claude-code', 'Claude Code', 'C', 'claude', 'Anthropic coding agent CLI', ['claude'], ['claude'], 'claude'),
  agent('codex', 'Codex', 'X', 'codex', 'OpenAI coding agent CLI', ['codex'], ['codex'], 'codex'),
  agent('grok', 'Grok', 'G', 'grok', 'xAI Grok coding agent CLI', ['grok'], ['grok'], null),
  agent('hermes', 'Hermes', 'H', null, 'Hermes agent CLI', ['hermes'], ['hermes'], 'hermes'),
  agent('aider', 'Aider', 'A', null, 'Pair programming in the terminal', ['aider'], ['aider'], null),
  agent('goose', 'Goose', 'G', null, 'Open-source on-machine agent', ['goose'], ['goose'], null),
  agent('opencode', 'OpenCode', 'O', null, 'Open-source terminal coding agent', ['opencode'], ['opencode'], 'opencode'),
  agent('droid', 'Droid', 'D', null, 'Factory coding agent CLI', ['droid'], ['droid'], 'droid'),
  agent('pi', 'Pi', 'P', null, 'Minimal terminal coding agent', ['pi'], ['pi'], 'pi'),
  agent('cline', 'Cline', 'C', null, 'Cline coding agent CLI', ['cline'], ['cline'], 'cline'),
  // ── LOCAL MODELS ────────────────────────────────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    monogram: 'L',
    engine: 'local',
    group: 'local-models',
    description: 'Local model runtime — serves the local seats',
    binaries: ['ollama'],
    versionArgs: ['--version'],
    launch: null,
    ollamaLaunchId: null,
    desktopToggle: null,
    probe: { url: 'http://127.0.0.1:11434/api/version', reads: 'version' },
  },
  {
    id: 'llama-server',
    name: 'llama-server',
    monogram: 'L',
    engine: 'local',
    group: 'local-models',
    description: 'llama.cpp server — parallel local slots behind the Verse proxy',
    binaries: ['llama-server'],
    versionArgs: ['--version'],
    launch: null,
    ollamaLaunchId: null,
    desktopToggle: null,
    probe: { url: 'http://127.0.0.1:8080/health', reads: 'health' },
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    monogram: 'L',
    engine: 'local',
    group: 'local-models',
    description: 'Local model app with an OpenAI-compatible server',
    binaries: ['lms'],
    versionArgs: ['version'],
    launch: null,
    ollamaLaunchId: null,
    desktopToggle: null,
    probe: { url: 'http://127.0.0.1:1234/v1/models', reads: 'models' },
  },
];

function agent(
  id: string,
  name: string,
  monogram: string,
  engine: VerseEngine | null,
  description: string,
  binaries: readonly string[],
  launch: readonly string[],
  ollamaLaunchId: string | null,
): AppCatalogEntry {
  return {
    id,
    name,
    monogram,
    engine,
    group: 'terminal-agents',
    description,
    binaries,
    versionArgs: ['--version'],
    launch,
    ollamaLaunchId,
    desktopToggle: null,
    probe: null,
  };
}

export function appCatalogEntry(id: string): AppCatalogEntry | null {
  return APPS_CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * The integration ids an installed `ollama launch --help` accepts: the
 * "Supported integrations:" list (with its aliases) PLUS every id an
 * "Examples:" line launches. The second half matters: 0.33.3 documents
 * `claude-desktop` only in its examples (`ollama launch claude-desktop
 * --restore`), and a parser reading the list alone would hide a toggle that
 * works. Pure, so C6 can test it against captured help text.
 */
export function parseOllamaLaunchIntegrations(helpText: string): Set<string> {
  const ids = new Set<string>();
  let section: 'none' | 'integrations' | 'examples' = 'none';
  for (const rawLine of helpText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const header = line.trim().toLowerCase();
    if (header.startsWith('supported integrations')) {
      section = 'integrations';
      continue;
    }
    if (header.startsWith('examples')) {
      section = 'examples';
      continue;
    }
    // Any other unindented "Title:" line (Usage:, Flags:) ends the section.
    if (/^\S.*:\s*$/.test(line)) {
      section = 'none';
      continue;
    }
    if (section === 'integrations') {
      const m = /^\s+([a-z0-9][a-z0-9-]*)\s+(.*)$/.exec(line);
      if (!m) continue;
      ids.add(m[1]!);
      // Both spellings occur in 0.33.3: "(aliases: a, b)" and "(alias: deepseek-harness)".
      const aliases = /\(alias(?:es)?:\s*([^)]*)\)/i.exec(m[2] ?? '');
      if (aliases) {
        for (const alias of aliases[1]!.split(',')) {
          const clean = alias.trim();
          if (/^[a-z0-9][a-z0-9-]*$/.test(clean)) ids.add(clean);
        }
      }
    } else if (section === 'examples') {
      const m = /^\s+ollama\s+launch\s+([a-z0-9][a-z0-9-]*)\b/.exec(line);
      if (m) ids.add(m[1]!);
    }
  }
  return ids;
}
