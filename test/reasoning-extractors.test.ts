import { describe, expect, it } from 'vitest';
import {
  LOOP_MIN,
  TurnAccumulator,
  classifyTool,
  claimsVerification,
  commandSignature,
  detectPhrases,
  extractTurnFeatures,
  repoLabel,
  type TraceAction,
  type TurnTrace,
} from '../src/core/reasoning/extractors.js';

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1_000).toISOString();

function trace(actions: TraceAction[], overrides: Partial<TurnTrace> = {}): TurnTrace {
  return {
    id: 'verse:s1:t1',
    source: 'verse',
    sessionId: 's1',
    runId: null,
    repo: '~/src/app',
    engine: 'claude',
    model: 'claude-opus',
    turnId: 't1',
    startedAt: at(0),
    endedAt: at(600),
    outcome: 'ok',
    actions,
    ...overrides,
  };
}

let seq = 0;
const think = (text: string, s = seq): TraceAction => ({ kind: 'thinking', ref: `verse:s1:${++seq}`, at: at(s), text });
const bash = (command: string, ok: boolean | null, s = seq): TraceAction =>
  ({ kind: 'tool', ref: `session:s1#${++seq}`, at: at(s), name: 'Bash', input: { command }, ok });
const edit = (file: string, s = seq): TraceAction =>
  ({ kind: 'tool', ref: `session:s1#${++seq}`, at: at(s), name: 'Edit', input: { file_path: `/repo/src/${file}`, old_string: 'a', new_string: 'b' }, ok: true });
const read = (file: string, s = seq): TraceAction =>
  ({ kind: 'tool', ref: `session:s1#${++seq}`, at: at(s), name: 'Read', input: { file_path: `/repo/src/${file}` }, ok: true });
const say = (text: string, s = seq): TraceAction => ({ kind: 'message', ref: `session:s1#${++seq}`, at: at(s), text });

/** Signature/count pairs (each also carries its newest evidence ref). */
const sigs = (list: { signature: string; count: number }[] | undefined) => (list ?? []).map(({ signature, count }) => ({ signature, count }));

describe('classifyTool', () => {
  it('classifies claude, codex, grok and MCP tool names', () => {
    expect(classifyTool('Edit', { file_path: '/a/b/store.ts' })).toEqual({ category: 'edit', signature: 'edit store.ts', target: 'store.ts' });
    expect(classifyTool('file_change', { changes: [{ path: '/x/y.ts', kind: 'update' }] }).category).toBe('edit');
    expect(classifyTool('search_replace', { file_path: 'z.ts' }).category).toBe('edit');
    expect(classifyTool('mcp__plugin_ashlr_ashlr__ashlr__edit', { path: 'q.ts' }).category).toBe('edit');
    expect(classifyTool('read_file', { target_file: '/p/r.ts' })).toEqual({ category: 'read', signature: 'read r.ts', target: 'r.ts' });
    expect(classifyTool('Grep', { pattern: 'x' }).category).toBe('search');
    expect(classifyTool('wait', {}).category).toBe('agent');
    expect(classifyTool('write_stdin', {}).category).toBe('agent');
    expect(classifyTool('KillShell', {}).category).toBe('agent');
    expect(classifyTool('WebFetch', {}).category).toBe('search');
    expect(classifyTool('mystery_tool', {}).category).toBe('other');
  });

  it('classifies shell commands by what they run', () => {
    expect(classifyTool('Bash', { command: 'cd /repo && npx vitest run test/a.test.ts' })).toMatchObject({ category: 'test', signature: 'npx vitest run' });
    expect(classifyTool('Bash', { command: 'npm test' }).category).toBe('test');
    expect(classifyTool('Bash', { command: 'pytest -q tests/' }).category).toBe('test');
    expect(classifyTool('Bash', { command: 'cargo test --all' }).category).toBe('test');
    expect(classifyTool('Bash', { command: 'npx tsc --noEmit -p tsconfig.json' }).category).toBe('build');
    expect(classifyTool('Bash', { command: 'npm run lint' }).category).toBe('build');
    expect(classifyTool('Bash', { command: 'rg foo src' }).category).toBe('search');
    expect(classifyTool('Bash', { command: 'cat package.json' }).category).toBe('read');
    expect(classifyTool('Bash', { command: "sed -i '' s/a/b/ f.ts" }).category).toBe('edit');
    expect(classifyTool('Bash', { command: 'git status' }).category).toBe('shell');
    // codex argv form: [shell, -lc, script]
    expect(classifyTool('command_execution', { command: ['/bin/zsh', '-lc', 'npm test'] }).category).toBe('test');
    expect(classifyTool('exec_command', { cmd: 'go test ./...' }).category).toBe('test');
  });

  it('builds signatures that never keep secret-bearing arguments or full paths', () => {
    expect(commandSignature('FOO=bar TOKEN=abc npm run build')).toBe('npm run build');
    expect(commandSignature('timeout 60 node /Users/me/private/script.mjs --flag')).toBe('node script.mjs');
    expect(commandSignature('curl "https://x/?key=secret" -H x')).toBe('curl');
    expect(commandSignature('export API_KEY=zzz; ls -la')).toBe('ls');
    expect(commandSignature('')).toBe('shell');
    expect(commandSignature('curl -H "Authorization: Bearer abc" https://x')).toBe('curl');
    expect(commandSignature("/bin/zsh -lc 'cd /r && npm test -- --run'")).toBe('npm test');
    expect(commandSignature('/bin/bash -lc "rg \\"needle\\" src/core"')).toBe('rg core');
    expect(commandSignature('git commit -m "fix: the thing"')).toBe('git commit');
    expect(commandSignature('echo "hello world" > out.txt')).toBe('echo');
    const sig = classifyTool('Bash', { command: 'gh auth login ghp_' + 'a'.repeat(36) }).signature;
    expect(sig).toBe('gh auth login');
  });
});

describe('phrase detection', () => {
  it('scores strong uncertainty above ordinary hedging', () => {
    expect(detectPhrases("I'm not sure why this fails. It's unclear.").uncertaintyScore).toBe(4);
    expect(detectPhrases('Maybe use a map.').uncertaintyScore).toBe(1);
    expect(detectPhrases('Straightforward: add the field.').uncertaintyScore).toBe(0);
    expect(detectPhrases("I'm sure this is right").uncertaintyScore).toBe(0);
  });

  it('detects backtracking without matching await/wait()', () => {
    expect(detectPhrases('Actually, that is the wrong file. Wait, let me revert the change.').backtrack).toBe(3);
    expect(detectPhrases('await wait(100); waitFor(x)').backtrack).toBe(0);
  });

  it('detects give-up language', () => {
    expect(detectPhrases("I can't figure out the root cause; I'll stop here.").giveUp).toBe(2);
  });

  it('recognises verification claims', () => {
    expect(claimsVerification('Done — all tests pass and typecheck is clean.')).toBe(true);
    expect(claimsVerification('I updated the README.')).toBe(false);
  });
});

describe('turn features', () => {
  it('flags a win: edit, then a passing test', () => {
    const f = extractTurnFeatures(trace([think('Plan: fix the parser'), edit('parser.ts', 30), bash('npm test', true, 60)]));
    expect(f.win).toBe(true);
    expect(f.verifiedAfterEdit).toBe(true);
    expect(f.verificationGap).toBe(false);
    expect(f.edits).toBe(1);
    expect(f.testsPassed).toBe(1);
    expect(f.firstEditMs).toBe(30_000);
    expect(f.evidence.win).toHaveLength(1);
    expect(f.struggle).toBe(false);
  });

  it('flags a win when a failing test later passes (fix via shell)', () => {
    const f = extractTurnFeatures(trace([bash('npm test', false), bash("sed -i '' s/a/b/ x.ts", true), bash('npm test', true)]));
    expect(f.win).toBe(true);
  });

  it('flags repeated failures as a struggle, with evidence', () => {
    const f = extractTurnFeatures(trace([
      edit('a.ts'), bash('npm test', false), edit('a.ts'), bash('npm test', false), edit('a.ts'), bash('npm test', false),
    ], { outcome: 'ok' }));
    expect(sigs(f.failures)).toEqual([{ signature: 'npm test', count: 3 }]);
    expect(f.failures[0]?.evidence?.ref).toMatch(/^session:s1#\d+$/);
    expect(f.struggle).toBe(true);
    expect(f.win).toBe(false);
    expect(f.evidence.struggle?.length).toBeGreaterThan(0);
    // re-running a test after each edit is progress, not a loop
    expect(f.loops).toEqual([]);
    expect(f.reEditedFiles).toBe(1);
  });

  it('flags a loop: the same call repeated with no edit in between', () => {
    const f = extractTurnFeatures(trace([read('a.ts'), read('a.ts'), read('a.ts'), read('a.ts')]));
    expect(sigs(f.loops)).toEqual([{ signature: 'read a.ts', count: 4 }]);
    expect(f.evidence.loop).toHaveLength(1);
    expect(LOOP_MIN).toBe(3);
  });

  it('paging through a file with different inputs is not a loop; the identical call is', () => {
    const page = (range: string): TraceAction =>
      ({ kind: 'tool', ref: `r${++seq}`, at: at(1), name: 'command_execution', input: { command: ['/bin/zsh', '-lc', `sed -n '${range}p' src/a.ts`] }, ok: true });
    expect(extractTurnFeatures(trace([page('1,80'), page('80,160'), page('160,240')])).loops).toEqual([]);
    const same = extractTurnFeatures(trace([page('1,80'), page('1,80'), page('1,80')]));
    expect(sigs(same.loops)).toEqual([{ signature: 'sed', count: 3 }]);
  });

  it('points a failed turn with no finer evidence at the conversation', () => {
    const f = extractTurnFeatures(trace([], { outcome: 'error' }));
    expect(f.evidence.struggle).toEqual([{ ref: 'session:s1', at: at(600) }]);
  });

  it('never counts polling calls as loops', () => {
    const polls: TraceAction[] = Array.from({ length: 10 }, () =>
      ({ kind: 'tool' as const, ref: `r${++seq}`, at: at(1), name: 'wait', input: {}, ok: true }));
    expect(extractTurnFeatures(trace(polls)).loops).toEqual([]);
  });

  it('flags a verification gap: edits with nothing run after the last one', () => {
    const f = extractTurnFeatures(trace([bash('npm test', true), edit('a.ts')]));
    expect(f.verificationGap).toBe(true);
    expect(f.evidence['verification-gap']).toHaveLength(1);
    expect(f.win).toBe(false);
  });

  it('a cancelled turn is not a verification gap', () => {
    expect(extractTurnFeatures(trace([edit('a.ts')], { outcome: 'cancelled' })).verificationGap).toBe(false);
  });

  it('flags a claim of success with no passing test/build', () => {
    const f = extractTurnFeatures(trace([edit('a.ts'), say('Fixed it — all tests pass.')]));
    expect(f.claimUnverified).toBe(true);
    const verified = extractTurnFeatures(trace([edit('a.ts'), bash('npm test', true), say('All tests pass.')]));
    expect(verified.claimUnverified).toBe(false);
  });

  it('only the LAST message counts as the claim', () => {
    const f = extractTurnFeatures(trace([say('tests pass'), edit('a.ts'), bash('npx tsc', true), say('Updated docs.')]));
    expect(f.claimUnverified).toBe(false);
  });

  it('accumulates uncertainty, backtracking and give-up from reasoning text only', () => {
    const f = extractTurnFeatures(trace([
      think("I'm not sure what the bug is. It's unclear."),
      think('Actually, wait, that is wrong. Let me reconsider.'),
      think("I can't figure out the cause."),
    ], { outcome: 'error' }));
    expect(f.uncertaintyScore).toBe(4);
    expect(f.uncertaintyKeys).toEqual(['not-sure', 'unclear']);
    expect(f.backtrackHits).toBeGreaterThanOrEqual(3);
    expect(f.giveUpHits).toBe(1);
    expect(f.gaveUp).toBe(true);
    expect(f.struggle).toBe(true);
    expect(f.thinkingSteps).toBe(3);
    // features are text-free
    expect(JSON.stringify(f)).not.toContain('not sure');
  });

  it('counts redacted thinking without analysing it', () => {
    const acc = new TurnAccumulator(trace([]));
    acc.addThinking('r1', at(1), '', true);
    const f = acc.finish('ok', at(2));
    expect(f.thinkingSteps).toBe(1);
    expect(f.redactedThinking).toBe(1);
  });

  it('resolves tool outcomes after the fact and computes duration', () => {
    const acc = new TurnAccumulator(trace([]));
    const h = acc.addTool('x', at(5), 'Bash', { command: 'npm test' });
    acc.resolveTool(h, false, at(9));
    const f = acc.finish('error', at(10), 'rate-limit');
    expect(f.testsFailed).toBe(1);
    expect(f.toolErrors).toBe(1);
    expect(f.durationMs).toBe(10_000);
    expect(f.errorClass).toBe('rate-limit');
    expect(f.struggle).toBe(true);
  });

  it('bounds per-turn tracking and reports truncation', () => {
    const acc = new TurnAccumulator(trace([]));
    for (let i = 0; i < 2_050; i += 1) acc.addTool(`t${i}`, at(1), 'Grep', { pattern: String(i) }, i % 2 === 0);
    const f = acc.finish('ok', at(2));
    expect(f.toolCalls).toBe(2_050);
    expect(f.truncated).toBe(true);
  });
});

describe('repoLabel', () => {
  it('uses the last path segment', () => {
    expect(repoLabel('~/Desktop/github/dev-tools/ashlr-hub')).toBe('ashlr-hub');
    expect(repoLabel('ashlrai/ashlr-hub/')).toBe('ashlr-hub');
    expect(repoLabel(null)).toBeNull();
  });
});
