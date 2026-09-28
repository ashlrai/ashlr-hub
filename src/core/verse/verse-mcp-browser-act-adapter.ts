/** Bind the Browser act registry to the unified bearer-per-turn MCP context. */
import {
  addBrowserAllowances,
  browserAllowanceRevision,
  browserAllowances,
  browserScopes,
  browserShot,
  browserSnapshotLoad,
  markBrowserTaint,
  requestBrowserConfirmation,
  setBrowserShot,
  setBrowserSnapshotLoad,
} from './browser-bridge.js';
import { browserActReach, hasAgentScope } from './verse-mcp-grants.js';
import { defaultNonce, tools as browserTools, type BrowserToolDeps } from './verse-mcp-browser-act.js';
import { toolError, type VerseMcpTool, type VerseMcpToolContext } from './verse-mcp.js';

function live(ctx: VerseMcpToolContext, scope: VerseMcpTool['scope']): boolean {
  if (ctx.signal.aborted || !hasAgentScope(ctx.sessionId, scope)) return false;
  const pane = browserScopes(ctx.sessionId);
  return pane.access && (scope !== 'browser_act' || pane.act) && (scope !== 'browser_script' || pane.script);
}

function effectiveScope(tool: (typeof browserTools)[number], args: Record<string, unknown>): VerseMcpTool['scope'] {
  return tool.name === 'browser_tabs' && args['action'] !== 'list' ? 'browser_act' : tool.scope;
}

function scopedDeps(ctx: VerseMcpToolContext, scope: VerseMcpTool['scope']): BrowserToolDeps {
  const authorized = (sid: string) => sid === ctx.sessionId && live(ctx, scope);
  return {
    run: async (sid, op, args, timeouts) => {
      if (!authorized(sid)) return { ok: false, code: 'access-off', message: 'This browser turn or scope has ended.' };
      const result = await ctx.browser.run(sid, op, args, {
        ...timeouts,
        signal: ctx.signal,
        authorize: () => authorized(sid),
        // The pane must see the action's narrower reach too. In particular,
        // selecting/closing a remote tab cannot use an origin granted only
        // for reading in act-localhost mode.
        ...(scope !== 'browser' && browserActReach(sid) === 'localhost' ? { allowedOrigins: [] } : {}),
      });
      return authorized(sid) ? result : { ok: false, code: 'access-off', message: 'This browser turn or scope has ended.' };
    },
    versePort: ctx.versePort,
    allowedOrigins: (sid) => {
      if (!authorized(sid)) return [];
      // An act-localhost grant may read an allowed remote page, but may not
      // act there even with a confirmation from the Browser pane.
      if (scope !== 'browser' && browserActReach(sid) === 'localhost') return [];
      return ctx.browser.allowedOrigins(sid);
    },
    recordBlocked: (sid, url, origin) => { if (authorized(sid)) ctx.browser.recordBlocked(sid, url, origin); },
    scopes: (sid) => ({
      access: authorized(sid),
      act: sid === ctx.sessionId && live(ctx, 'browser_act'),
      script: sid === ctx.sessionId && live(ctx, 'browser_script'),
    }),
    confirm: async (sid, request) => {
      if (!authorized(sid)) return 'unavailable';
      const answer = await requestBrowserConfirmation(sid, request, undefined, ctx.signal, () => authorized(sid));
      return authorized(sid) ? answer : 'unavailable';
    },
    taint: (sid) => authorized(sid) && ctx.remoteRead() ? { origin: 'a remote page', at: Date.now() } : null,
    markTaint: (sid, origin) => {
      if (!authorized(sid)) return;
      ctx.markRemoteRead();
      markBrowserTaint(sid, origin);
    },
    allowances: (sid) => authorized(sid) ? browserAllowances(sid) : [],
    allowanceRevision: (sid) => browserAllowanceRevision(sid),
    addAllowances: (sid, keys) => { if (authorized(sid)) addBrowserAllowances(sid, keys); },
    snapshotLoad: (sid) => authorized(sid) ? browserSnapshotLoad(sid) : null,
    setSnapshotLoad: (sid, loadId) => { if (authorized(sid)) setBrowserSnapshotLoad(sid, loadId); },
    shot: (sid) => authorized(sid) ? browserShot(sid) : null,
    setShot: (sid, shot) => { if (authorized(sid)) setBrowserShot(sid, shot); },
    nonce: defaultNonce,
    sleep: (ms) => new Promise((resolve) => {
      if (ctx.signal.aborted) { resolve(); return; }
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); ctx.signal.removeEventListener('abort', done); resolve(); }
      ctx.signal.addEventListener('abort', done, { once: true });
    }),
    now: Date.now,
  };
}

/** Rich screenshot wins over the older observe-only screenshot in the registry. */
export const tools: VerseMcpTool[] = browserTools.map((tool) => ({
  name: tool.name,
  scope: tool.scope,
  description: tool.description,
  annotations: {
    title: tool.annotations.title ?? tool.name,
    readOnlyHint: tool.annotations.readOnlyHint ?? false,
    destructiveHint: tool.annotations.destructiveHint ?? false,
    idempotentHint: tool.annotations.idempotentHint ?? false,
    openWorldHint: tool.annotations.openWorldHint ?? false,
  },
  inputSchema: tool.inputSchema,
  desktopOnly: true,
  async handler(args, ctx) {
    const scope = effectiveScope(tool, args);
    if (!live(ctx, scope)) return toolError('This browser turn or scope has ended.');
    const result = await tool.handler(args, { sessionId: ctx.sessionId, deps: scopedDeps(ctx, scope) });
    return live(ctx, scope) ? result : toolError('This browser turn or scope has ended.');
  },
}));
