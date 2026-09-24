/**
 * routes/verse/sections/McpSection.tsx — the legacy MCP entry point, folded
 * into Apps & Accounts (SPEC-310C §0.1 "MCP moves into Apps", §4).
 *
 * MCP is no longer a section of its own: its per-seat view, the standing
 * caveat (Claude and local seats load none), the drift alert and — new — the
 * Add flow all live in the MCP SERVERS group of the Apps page. This file stays
 * only so a shell that still routes `mcp` (a stored v2 `section: 'mcp'`, or
 * C1's `fallbackModules: ['McpSection']` while AppsSection is loading) lands
 * on that group instead of on a "missing section" notice. It renders the same
 * page — one implementation, never two MCP views that could drift.
 */
import { AppsSection } from './AppsSection.js';

export function McpSection() {
  return <AppsSection focusGroup="mcp-servers" />;
}
