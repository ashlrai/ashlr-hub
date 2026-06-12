/**
 * core/plugins/wrappers.ts — M33 plugin contribution safety wrappers.
 *
 * CONTRACT RULES (non-negotiable):
 *  - wrapScanner: 15s AbortSignal timeout, never-throws (→ []), cap 100 items,
 *    clamp value/effort to 1..5 integers, recompute score via scoreItem,
 *    scrub title+detail with scrubSecrets, force source:'plugin', tags include
 *    ['plugin', pluginName, s.id], ids namespaced plugin:<name>:<s.id>:<orig|index>.
 *  - validateTemplate: id prefixed <pluginName>: unless already, reject any
 *    template file path that is absolute, contains '..', or starts with '.git/'.
 *    Returns validated template or null (audited on rejection).
 *  - wrapCommand: run wrapped with audit of invocation + exit code, catches
 *    throws → exit 1.
 *  - All wrappers NEVER throw themselves.
 */

import { audit } from '../sandbox/audit.js';
import { scoreItem } from '../portfolio/backlog.js';
import { scrubSecrets } from '../knowledge/index.js';
import type { WorkItem, ProjectTemplate, TemplateFile } from '../types.js';
import type { PluginScanner, PluginCommandSpec, PluginHost } from './types.js';

// ---------------------------------------------------------------------------
// wrapScanner
// ---------------------------------------------------------------------------

/** Maximum items returned by a plugin scanner. */
const SCANNER_CAP = 100;

/** Scanner timeout in milliseconds. */
const SCANNER_TIMEOUT_MS = 15_000;

/**
 * Wrap a PluginScanner for safety:
 *  - 15-second AbortSignal timeout (signal passed to scanner.scan).
 *  - Never throws → [] on any error or timeout.
 *  - Caps results at 100 items.
 *  - Clamps value/effort to integers in 1..5.
 *  - Recomputes score via scoreItem.
 *  - Scrubs title + detail with scrubSecrets.
 *  - Forces source: 'plugin'.
 *  - Forces tags to include ['plugin', pluginName, s.id].
 *  - Namespaces id as "plugin:<name>:<s.id>:<orig-id-or-index>".
 */
export function wrapScanner(
  pluginName: string,
  s: PluginScanner,
): (repo: string) => Promise<WorkItem[]> {
  return async (repo: string): Promise<WorkItem[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCANNER_TIMEOUT_MS);

    let raw: WorkItem[];
    try {
      raw = await s.scan(repo, { signal: controller.signal });
    } catch {
      // never-throws contract: scanner timeout or error → []
      return [];
    } finally {
      clearTimeout(timer);
    }

    if (!Array.isArray(raw)) return [];

    const result: WorkItem[] = [];
    const capped = raw.slice(0, SCANNER_CAP);

    for (let i = 0; i < capped.length; i++) {
      const item = capped[i];
      if (item === null || typeof item !== 'object') continue;

      // Clamp value/effort to integers in 1..5
      const rawValue = typeof item.value === 'number' ? item.value : 3;
      const rawEffort = typeof item.effort === 'number' ? item.effort : 2;
      const value = Math.max(1, Math.min(5, Math.round(rawValue)));
      const effort = Math.max(1, Math.min(5, Math.round(rawEffort)));

      // Recompute score via scoreItem (deterministic, pure)
      const score = scoreItem(value, effort);

      // Scrub secrets from title + detail
      const rawTitle = typeof item.title === 'string' ? item.title : '';
      const rawDetail = typeof item.detail === 'string' ? item.detail : '';
      const title = scrubSecrets(rawTitle);
      const detail = scrubSecrets(rawDetail);

      // Namespace id: plugin:<name>:<s.id>:<orig-or-index>
      const origId = typeof item.id === 'string' && item.id.length > 0 ? item.id : String(i);
      const id = `plugin:${pluginName}:${s.id}:${origId}`;

      // Force tags to include ['plugin', pluginName, s.id]
      const baseTags: string[] = Array.isArray(item.tags)
        ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      const requiredTags = ['plugin', pluginName, s.id];
      const tags = [
        ...requiredTags,
        ...baseTags.filter((t) => !requiredTags.includes(t)),
      ];

      const wrapped: WorkItem = {
        id,
        repo: typeof item.repo === 'string' ? item.repo : repo,
        source: 'plugin',
        title,
        detail,
        value,
        effort,
        score,
        tags,
        ts: typeof item.ts === 'string' ? item.ts : new Date().toISOString(),
      };

      result.push(wrapped);
    }

    return result;
  };
}

// ---------------------------------------------------------------------------
// validateTemplate
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize a plugin-contributed template.
 *
 * - Prefixes id with "<pluginName>:" unless it already starts with that prefix.
 * - Rejects any template whose files() function (called with probe ctx) returns
 *   a path that is absolute, contains '..', or starts with '.git/'.
 * - The files() function is wrapped: the path guard also runs on every future
 *   call so a template cannot sneak bad paths in via a closure.
 * - Returns the sanitized template or null (rejection is audited).
 *
 * NEVER throws.
 */
function checkFilePath(
  pluginName: string,
  templateId: string,
  p: string,
): string | null {
  if (p.startsWith('/')) {
    return `plugin "${pluginName}" template "${templateId}" rejected: absolute path "${p}"`;
  }
  if (p.includes('..')) {
    return `plugin "${pluginName}" template "${templateId}" rejected: traversal path "${p}"`;
  }
  if (p.startsWith('.git/')) {
    return `plugin "${pluginName}" template "${templateId}" rejected: .git path "${p}"`;
  }
  return null;
}

export function validateTemplate(
  pluginName: string,
  t: ProjectTemplate,
): ProjectTemplate | null {
  try {
    const prefix = `${pluginName}:`;

    // Probe the files function with empty-string ctx to catch static bad paths.
    let probeFiles: TemplateFile[];
    try {
      probeFiles = t.files({ name: '', category: '' });
    } catch {
      // files() threw on probe — reject.
      audit({
        action: `plugin:${pluginName}:template-rejected`,
        repo: null,
        sandboxId: null,
        summary: `plugin "${pluginName}" template "${t.id}" rejected: files() threw on probe`,
        result: 'refused',
      });
      return null;
    }

    for (const f of probeFiles) {
      const reason = checkFilePath(pluginName, t.id, f.path);
      if (reason !== null) {
        audit({
          action: `plugin:${pluginName}:template-rejected`,
          repo: null,
          sandboxId: null,
          summary: reason,
          result: 'refused',
        });
        return null;
      }
    }

    // Prefix id if not already prefixed.
    const id = t.id.startsWith(prefix) ? t.id : `${prefix}${t.id}`;

    // Wrap files() to enforce path guard on every call.
    const safeFiles = (ctx: { name: string; category: string }): TemplateFile[] => {
      let result: TemplateFile[];
      try {
        result = t.files(ctx);
      } catch {
        return [];
      }
      return result.filter((f) => checkFilePath(pluginName, id, f.path) === null);
    };

    return { ...t, id, files: safeFiles };
  } catch {
    // Belt-and-suspenders: validateTemplate must never throw.
    return null;
  }
}

// ---------------------------------------------------------------------------
// wrapCommand
// ---------------------------------------------------------------------------

/**
 * Wrap a PluginCommandSpec for safety:
 *  - Audits invocation (action: "plugin:<name>:command:<cmd.name>").
 *  - Catches throws → returns exit code 1.
 *  - Audits the exit code (ok when 0, error otherwise).
 *
 * NEVER throws from the wrapper itself.
 */
export function wrapCommand(pluginName: string, c: PluginCommandSpec): PluginCommandSpec {
  return {
    ...c,
    async run(args: string[], host: PluginHost): Promise<number> {
      audit({
        action: `plugin:${pluginName}:command:${c.name}`,
        repo: null,
        sandboxId: null,
        summary: `plugin "${pluginName}" command "${c.name}" invoked (${args.length} arg(s))`,
        result: 'ok',
      });

      let exitCode: number;
      try {
        exitCode = await c.run(args, host);
      } catch (err) {
        audit({
          action: `plugin:${pluginName}:command:${c.name}:exit`,
          repo: null,
          sandboxId: null,
          summary: `plugin "${pluginName}" command "${c.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
          result: 'error',
        });
        return 1;
      }

      const code = typeof exitCode === 'number' && Number.isFinite(exitCode) ? exitCode : 1;
      audit({
        action: `plugin:${pluginName}:command:${c.name}:exit`,
        repo: null,
        sandboxId: null,
        summary: `plugin "${pluginName}" command "${c.name}" exited with code ${code}`,
        result: code === 0 ? 'ok' : 'error',
      });

      return code;
    },
  };
}
