/** Read-only, bounded metadata from this turn's reported calls. Never inspect payloads. */
import { baseToolName } from './tool-semantics.js';

export const MAX_RESOURCE_CALLS = 2048;
export const MAX_RESOURCE_SOURCES = 512;
export const MAX_RESOURCE_GROUPS = 12;
export const MAX_RESOURCE_CACHE = 2048;

export interface ReportedTool {
  label: string;
  mcp: boolean;
  state: 'completed' | 'pending' | 'failed' | 'unknown';
}
export interface ResourceToolGroup {
  label: string;
  calls: number;
  pending: number;
  failed: number;
  unknown: number;
}
export interface TurnResourceEvidence {
  calls: number;
  mcpCalls: number;
  pending: number;
  failed: number;
  unknown: number;
  sources: number;
  playbooks: number;
  partial: boolean;
  groups: ResourceToolGroup[];
}
export interface ResourceEvidenceCacheEntry {
  name: unknown;
  pending: boolean | null;
  failed: boolean | null;
  evidence: ReportedTool;
}

// Tool/server names are provider-controlled too. Only these fixed labels may
// leave the projection; arbitrary MCP names can contain secrets or local paths.
const TOOL_LABELS: Readonly<Record<string, string>> = {
  read: 'Read', read_file: 'Read', readfile: 'Read', view_file: 'Read',
  edit: 'Edit', multiedit: 'Edit', multi_edit: 'Edit', apply_patch: 'Edit',
  write: 'Write', write_file: 'Write', create_file: 'Write',
  bash: 'Command', shell: 'Command', exec_command: 'Command', run_command: 'Command',
  grep: 'Search', glob: 'Search', search: 'Search', tree: 'Search',
  webfetch: 'Web', web_fetch: 'Web', websearch: 'Web', web_search: 'Web',
  task: 'Delegate', agent: 'Delegate', subagent: 'Delegate',
};

function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}

function statusFlag(value: unknown, key: string): boolean | null {
  const flag = data(value, key);
  return typeof flag === 'boolean' ? flag : null;
}

function toolLabel(name: unknown): { label: string; mcp: boolean } {
  if (typeof name !== 'string' || name.length > 256) return { label: 'Unrecognized tool', mcp: false };
  const trimmed = name.trim();
  const mcp = /^mcp__[^\s]+__[^\s]+/i.test(trimmed) || /^mcp:[^\s.]+\.[^\s]+/i.test(trimmed);
  const base = baseToolName(trimmed);
  const tool = Object.hasOwn(TOOL_LABELS, base) ? TOOL_LABELS[base]! : 'Other tool';
  if (!mcp) return { label: tool, mcp: false };
  // Recognize the transport envelope, not an executable/plugin identity.
  const server = /^mcp:/i.test(trimmed) ? trimmed.slice(4, trimmed.indexOf('.')) : trimmed.split('__')[1];
  const family = server === 'ashlr' || server === 'plugin_ashlr_ashlr' ? 'Ashlr MCP'
    : server === 'ashlr-efficiency' ? 'Ashlr efficiency MCP'
      : server === 'ashlr-verse' ? 'Verse MCP' : 'Other MCP';
  return { label: `${family}: ${tool}`, mcp: true };
}

/** Facts are already derived/cached by turn-model; only status booleans are consumed. */
export function reportedTool(name: unknown, facts: unknown): ReportedTool {
  const pending = statusFlag(facts, 'pending');
  const failed = statusFlag(facts, 'failed');
  return { ...toolLabel(name), state: pending === true ? 'pending'
    : failed === true ? 'failed' : pending === false && failed === false ? 'completed' : 'unknown' };
}

export function cachedReportedTool(
  key: string, name: unknown, facts: unknown, cache: Map<string, ResourceEvidenceCacheEntry> | null,
): ReportedTool {
  const pending = statusFlag(facts, 'pending');
  const failed = statusFlag(facts, 'failed');
  const hit = cache?.get(key);
  if (hit && hit.name === name && hit.pending === pending && hit.failed === failed) return hit.evidence;
  const evidence = reportedTool(name, facts);
  if (cache) {
    if (!cache.has(key) && cache.size >= MAX_RESOURCE_CACHE) cache.delete(cache.keys().next().value!);
    // Do not retain an arbitrary object supplied as a malformed name.
    cache.set(key, { name: typeof name === 'string' && name.length <= 256 ? name : null, pending, failed, evidence });
  }
  return evidence;
}

export function emptyResourceEvidence(): TurnResourceEvidence {
  return { calls: 0, mcpCalls: 0, pending: 0, failed: 0, unknown: 0, sources: 0, playbooks: 0, partial: false, groups: [] };
}

/** Incremental projection piggybacks on the existing turn scan; no payload or extra log scan. */
export function addReportedTool(evidence: TurnResourceEvidence, tool: ReportedTool): void {
  if (evidence.calls >= MAX_RESOURCE_CALLS) { evidence.partial = true; return; }
  evidence.calls++;
  if (tool.mcp) evidence.mcpCalls++;
  if (tool.state !== 'completed') evidence[tool.state]++;
  let group = evidence.groups.find((entry) => entry.label === tool.label);
  if (!group && evidence.groups.length < MAX_RESOURCE_GROUPS) {
    group = { label: tool.label, calls: 0, pending: 0, failed: 0, unknown: 0 };
    evidence.groups.push(group);
  }
  if (!group) { evidence.partial = true; return; }
  group.calls++;
  if (tool.state !== 'completed') group[tool.state]++;
}

export function setResourceContext(evidence: TurnResourceEvidence, sourceCount: number, playbooks: number): void {
  evidence.sources = Number.isSafeInteger(sourceCount) && sourceCount >= 0 ? Math.min(sourceCount, MAX_RESOURCE_SOURCES) : 0;
  evidence.playbooks = Number.isSafeInteger(playbooks) && playbooks >= 0 ? Math.min(playbooks, MAX_RESOURCE_CALLS) : 0;
  if (sourceCount > MAX_RESOURCE_SOURCES || playbooks > MAX_RESOURCE_CALLS) evidence.partial = true;
}
