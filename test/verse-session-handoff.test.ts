/**
 * test/verse-session-handoff.test.ts — the deterministic, zero-spend handoff
 * note (POST /api/verse/sessions/:id/handoff-preview).
 *
 * Defended here:
 *  1. CONTENT. Goal, latest asks, where it stood, files (read vs edited, across
 *     claude / codex / grok tool vocabularies), commands, errors, roots with
 *     `git diff --stat`, compactions — each bounded.
 *  2. THE CAP. ≤ VERSE_HANDOFF_MAX_CHARS; the LOWEST-priority sections go
 *     first, whole, and are named in `stats.truncated`.
 *  3. DETERMINISM. Same log + same git output → byte-identical note.
 *  4. SAFETY. Secrets scrubbed; the default git call runs no external diff
 *     driver, textconv filter or fsmonitor hook from the repository.
 *  5. NO SPEND. The module has no model path at all — asserted structurally.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_GIT_MAX_BYTES,
  HANDOFF_MAX_COMMANDS,
  HANDOFF_MAX_ERRORS,
  HANDOFF_MAX_FILES,
  VERSE_HANDOFF_HEADER,
  buildHandoffPreview,
  defaultGitDiffStat,
  isControlCommandTurn,
  isHandoffSummaryRequest,
} from '../src/core/verse/session-handoff.js';
import { VerseServiceError } from '../src/core/verse/preferences.js';
import {
  VERSE_HANDOFF_MAX_CHARS,
  VERSE_HANDOFF_SUMMARY_REQUEST,
  type VerseEvent,
  type VerseSession,
} from '../src/core/verse/types.js';

const PRIMARY = '/work/app';

function session(overrides: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'src-1',
    title: 'Migrate billing',
    projectPath: PRIMARY,
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-opus-5',
    nativeSessionId: 'n',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    status: 'idle',
    turnCount: 4,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 0,
      contextWindow: null,
    },
    lastError: null,
    ...overrides,
  };
}

/** A tiny event-log builder: seq and timestamps are assigned in order. */
function log() {
  const events: VerseEvent[] = [];
  let seq = 0;
  let tool = 0;
  const at = (): string => new Date(Date.parse('2026-09-20T10:00:00.000Z') + seq * 60_000).toISOString();
  const push = (event: Record<string, unknown>): void => {
    seq += 1;
    events.push({ seq, at: at(), turnId: 't', ...event } as VerseEvent);
  };
  const api = {
    events,
    user(text: string) { push({ type: 'user-message', text }); return api; },
    assistant(text: string) { push({ type: 'assistant-message', text }); return api; },
    tool(name: string, input: unknown, result?: { output: string; isError: boolean }) {
      tool += 1;
      const toolUseId = `tu-${tool}`;
      push({ type: 'tool-use', toolUseId, name, input });
      if (result) push({ type: 'tool-result', toolUseId, ...result });
      return api;
    },
    error(message: string) { push({ type: 'error', turnId: null, message }); return api; },
    compaction(pre: number | null, post: number | null) {
      push({ type: 'compaction', trigger: 'auto', preTokens: pre, postTokens: post, durationMs: 1000 });
      return api;
    },
  };
  return api;
}

const noGit = (): string | null => null;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(VerseServiceError);
    return (err as VerseServiceError).code;
  }
}

describe('content', () => {
  it('assembles goal, latest asks, state, files, commands, errors, roots and compactions', () => {
    const l = log()
      .user('Move billing from Stripe v1 to v2.')
      .tool('Read', { file_path: `${PRIMARY}/src/billing.ts` })
      .tool('Edit', { file_path: `${PRIMARY}/src/billing.ts`, old_string: 'a', new_string: 'b' })
      .tool('Bash', { command: 'npm test -- billing' }, { output: 'FAIL billing.test.ts\nexpected 2', isError: true })
      .assistant('First pass done; tests fail on proration.')
      .user('Fix proration.')
      .tool('Write', { file_path: 'src/proration.ts', content: 'x' })
      .compaction(812_000, 41_000)
      .user('Also update the docs.')
      .assistant('Proration fixed. Docs pending.');
    const preview = buildHandoffPreview(session({ compactionCount: 1 }), l.events, {
      gitDiffStat: () => ' src/billing.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)',
    });
    const text = preview.text;

    expect(text.startsWith(VERSE_HANDOFF_HEADER)).toBe(true);
    expect(text).toContain('"Migrate billing" (claude · claude-opus-5, 3 turns, 2026-09-20)');
    expect(text).toMatch(/## Original goal\n\n> Move billing from Stripe v1 to v2\./);
    expect(text).toMatch(/## Latest requests \(oldest first\)\n\n1\. Fix proration\.\n2\. Also update the docs\./);
    expect(text).toMatch(/## Where it stood \(the previous agent's last reply\)\n\n> Proration fixed\. Docs pending\./);
    // Edit order is kept (oldest first); the read-then-edited file is edited.
    expect(text).toMatch(/Edited:\n- src\/billing\.ts\n- src\/proration\.ts\n\nRelative paths/);
    // A file read and then edited is listed once, as edited.
    expect(text).not.toMatch(/Read:\n- src\/billing\.ts/);
    expect(text).toContain('- `npm test -- billing`');
    expect(text).toContain('- Bash: FAIL billing.test.ts — expected 2');
    expect(text).toContain(`- ${PRIMARY} (primary)`);
    expect(text).toContain(' src/billing.ts | 4 ++--');
    expect(text).toMatch(/auto-compacted 1 time,.*from ~812k to ~41k tokens/);
    expect(text).toMatch(/---\nStart by checking the current state/);

    expect(preview.sourceSessionId).toBe('src-1');
    expect(preview.sourceTitle).toBe('Migrate billing');
    expect(preview.stats).toEqual({
      chars: text.length,
      estTokens: Math.ceil(text.length / 4),
      turnsCovered: 3,
      filesTouched: 2,
      truncated: [],
    });
  });

  it('puts the operator focus first and rejects focus over 500 chars', () => {
    const l = log().user('goal');
    const preview = buildHandoffPreview(session(), l.events, { focus: '  finish the v2 webhooks  ', gitDiffStat: noGit });
    const focusAt = preview.text.indexOf('## Focus for this session\n\nfinish the v2 webhooks');
    expect(focusAt).toBeGreaterThan(0);
    expect(focusAt).toBeLessThan(preview.text.indexOf('## Original goal'));
    expect(codeOf(() => buildHandoffPreview(session(), l.events, { focus: 'x'.repeat(501), gitDiffStat: noGit }))).toBe('VERSE_INVALID');
    // Whitespace-only focus is no focus.
    expect(buildHandoffPreview(session(), l.events, { focus: '   ', gitDiffStat: noGit }).text).not.toContain('## Focus');
  });

  it('keeps only the last three asks after the goal and says how many were omitted', () => {
    const l = log().user('goal');
    for (let i = 1; i <= 6; i += 1) l.user(`ask ${i}`);
    const text = buildHandoffPreview(session(), l.events, { gitDiffStat: noGit }).text;
    expect(text).toContain('## Latest requests (oldest first; 3 earlier omitted)');
    expect(text).toMatch(/1\. ask 4\n2\. ask 5\n3\. ask 6/);
    expect(text).not.toContain('ask 3');
  });

  it('indents a multi-line ask under its number', () => {
    const l = log().user('goal').user('line one\nline two');
    expect(buildHandoffPreview(session(), l.events, { gitDiffStat: noGit }).text).toContain('1. line one\n   line two');
  });

  it('abridges a long last reply (head + tail) unless includeLastAssistant asks for it verbatim', () => {
    const reply = `VERDICT FIRST\n${'middle line\n'.repeat(400)}FINAL SUMMARY LINE`;
    const l = log().user('goal').assistant(reply);
    const abridged = buildHandoffPreview(session(), l.events, { gitDiffStat: noGit }).text;
    expect(abridged).toContain('## Where it stood (the previous agent\'s last reply, abridged)');
    expect(abridged).toContain('VERDICT FIRST');
    expect(abridged).toContain('FINAL SUMMARY LINE');
    expect(abridged).toContain('[… middle of the reply omitted …]');
    expect(abridged.match(/middle line/g)?.length ?? 0).toBeLessThan(200);

    const verbatim = buildHandoffPreview(session(), l.events, { includeLastAssistant: true, gitDiffStat: noGit }).text;
    expect(verbatim).toContain('## Where it stood (the previous agent\'s own summary, verbatim)');
    expect(verbatim).not.toContain('middle of the reply omitted');
    expect(verbatim.match(/middle line/g)?.length ?? 0).toBeGreaterThan(abridged.match(/middle line/g)?.length ?? 0);
  });

  it('reads codex file_change and command_execution items', () => {
    const l = log()
      .user('goal')
      .tool('file_change', { changes: [{ path: `${PRIMARY}/a.rs`, kind: 'update' }, { path: '/elsewhere/b.rs', kind: 'add' }] })
      .tool('command_execution', { command: 'cargo test', cwd: PRIMARY }, { output: 'error[E0308]: mismatched types', isError: true });
    const preview = buildHandoffPreview(session({ engine: 'codex', model: 'gpt-6-astra' }), l.events, { gitDiffStat: noGit });
    expect(preview.text).toMatch(/Edited:\n- a\.rs\n- \/elsewhere\/b\.rs/);
    expect(preview.text).toContain('- `cargo test`');
    expect(preview.text).toContain('- command_execution: error[E0308]: mismatched types');
    expect(preview.stats.filesTouched).toBe(2);
  });

  it('reads grok tool names (read_file / search_replace / run_terminal_command)', () => {
    const l = log()
      .user('goal')
      .tool('read_file', { target_file: 'm.js' })
      .tool('read_file', { target_file: 'lib/util.js' })
      .tool('search_replace', { file_path: 'm.js', old_string: 'a-b', new_string: 'a+b' })
      .tool('run_terminal_command', { command: 'node m.js' });
    const text = buildHandoffPreview(session({ engine: 'grok' }), l.events, { gitDiffStat: noGit }).text;
    expect(text).toMatch(/Edited:\n- m\.js\n\nRead:\n- lib\/util\.js/);
    expect(text).toContain('- `node m.js`');
  });

  it('bounds files (60), commands (15, most recent, repeats collapsed) and errors (5, most recent)', () => {
    const l = log().user('goal');
    for (let i = 0; i < 80; i += 1) l.tool('Read', { file_path: `f${i}.ts` });
    for (let i = 0; i < 20; i += 1) { l.tool('Bash', { command: `step ${i}` }); l.tool('Bash', { command: `step ${i}` }); }
    for (let i = 0; i < 8; i += 1) l.error(`boom ${i}`);
    const preview = buildHandoffPreview(session(), l.events, { gitDiffStat: noGit });
    const text = preview.text;
    expect(preview.stats.filesTouched).toBe(80);
    expect(text.match(/^- f\d+\.ts$/gm)).toHaveLength(HANDOFF_MAX_FILES);
    expect(text).toContain('- f79.ts');
    expect(text).not.toContain('- f19.ts\n');
    expect(text).toContain('(20 more not listed)');
    expect(text.match(/^- `step \d+`$/gm)).toHaveLength(HANDOFF_MAX_COMMANDS);
    expect(text).toContain('- `step 19`');
    expect(text).not.toContain('- `step 4`');
    expect(text.match(/^- boom \d$/gm)).toHaveLength(HANDOFF_MAX_ERRORS);
    expect(text).toContain('- boom 7');
    expect(text).not.toContain('- boom 2');
  });

  it('lists every root and says when there are no uncommitted changes', () => {
    const s = session({ extraRoots: ['/work/lib'] });
    const text = buildHandoffPreview(s, log().user('goal').events, {
      gitDiffStat: (root) => (root === PRIMARY ? '' : null),
    }).text;
    expect(text).toContain(`- ${PRIMARY} (primary)\n  No uncommitted changes against HEAD.`);
    expect(text).toContain('- /work/lib');
    expect(text).not.toContain('/work/lib (primary)');
  });

  it('caps an injected git stat at 4 KB, keeping its summary line', () => {
    const lines = Array.from({ length: 400 }, (_, i) => ` src/file-${i}.ts | 2 +-`);
    const stat = [...lines, ' 400 files changed, 400 insertions(+), 400 deletions(-)'].join('\n');
    const text = buildHandoffPreview(session(), log().user('goal').events, { gitDiffStat: () => stat }).text;
    const block = text.slice(text.indexOf('  ```\n') + 6, text.lastIndexOf('\n  ```'));
    expect(Buffer.byteLength(block.replace(/^ {2}/gm, ''), 'utf8')).toBeLessThanOrEqual(HANDOFF_GIT_MAX_BYTES);
    expect(block).toMatch(/… \d+ more files/);
    expect(block).toContain('400 files changed');
  });

  it('survives a gitDiffStat that throws', () => {
    const preview = buildHandoffPreview(session(), log().user('goal').events, {
      gitDiffStat: () => { throw new Error('spawn EACCES'); },
    });
    expect(preview.text).toContain(`- ${PRIMARY} (primary)`);
  });

  it('handles an empty log: header, roots and footer only', () => {
    const preview = buildHandoffPreview(session(), [], { gitDiffStat: noGit });
    expect(preview.text).toContain('0 turns');
    expect(preview.text).toContain('## Repositories');
    expect(preview.text).not.toContain('## Original goal');
    expect(preview.stats.turnsCovered).toBe(0);
  });

  it('recovers the ORIGINAL goal when handing off a session that was itself a handoff', () => {
    const first = buildHandoffPreview(session(), log().user('Ship the v2 migration.').assistant('ok').events, { gitDiffStat: noGit });
    const l = log().user(first.text).user('keep going');
    const second = buildHandoffPreview(session({ id: 'src-2', handoffFrom: { sessionId: 'src-1', title: 'Migrate billing' } }), l.events, { gitDiffStat: noGit });
    expect(second.text).toMatch(/## Original goal\n\n> Ship the v2 migration\.\n/);
    // The previous note is not nested inside the new one.
    expect(second.text.split(VERSE_HANDOFF_HEADER)).toHaveLength(2);
  });
});

describe('control turns (summarize-first, /compact)', () => {
  /** The shape "Ask this seat to summarize first" leaves in the log. */
  function summarised() {
    return log()
      .user('Migrate billing to the new webhooks API')
      .user('Now update the webhooks handler')
      .user('Add a regression test for the retry path')
      .assistant('Handler updated; test pending.')
      .user(VERSE_HANDOFF_SUMMARY_REQUEST)
      .assistant('## Handoff\nGoal: billing on webhooks v2. Done: handler. Next: retry test.');
  }

  it('never lists the canned summary request as a request, and uses its reply as the summary', () => {
    const preview = buildHandoffPreview(session(), summarised().events, { includeLastAssistant: true, gitDiffStat: noGit });
    const text = preview.text;
    expect(text).not.toContain('Write the handoff note');
    expect(text).not.toContain('about to continue in a fresh session');
    // The real latest ask is the latest request the footer points at.
    expect(text).toMatch(/## Latest requests \(oldest first\)\n\n1\. Now update the webhooks handler\n2\. Add a regression test for the retry path\n\n/);
    expect(text).toContain('## Where it stood (the previous agent\'s own summary, verbatim)\n\n> ## Handoff\n> Goal: billing on webhooks v2.');
    expect(text).not.toContain('Handler updated; test pending.');
    // The summary turn WAS a turn (it was spent), so the header counts it.
    expect(preview.stats.turnsCovered).toBe(4);
  });

  it('does not let the summary request push a real ask out of the three-item window', () => {
    const l = log().user('goal').user('ask 1').user('ask 2').user('ask 3')
      .user(VERSE_HANDOFF_SUMMARY_REQUEST).assistant('summary');
    const text = buildHandoffPreview(session(), l.events, { includeLastAssistant: true, gitDiffStat: noGit }).text;
    expect(text).toMatch(/1\. ask 1\n2\. ask 2\n3\. ask 3/);
    expect(text).not.toContain('earlier omitted');
  });

  it('recognises the request despite CRLF and surrounding whitespace, and never as the goal', () => {
    const crlf = `  ${VERSE_HANDOFF_SUMMARY_REQUEST.replace(/\n/g, '\r\n')}\n`;
    expect(isHandoffSummaryRequest(crlf)).toBe(true);
    expect(isHandoffSummaryRequest(`${VERSE_HANDOFF_SUMMARY_REQUEST} and also fix the tests`)).toBe(false);
    const l = log().user(crlf).assistant('summary').user('the real goal');
    const text = buildHandoffPreview(session(), l.events, { gitDiffStat: noGit }).text;
    expect(text).toContain('## Original goal\n\n> the real goal');
    expect(text).not.toContain('Write the handoff note');
  });

  it('drops /compact turns from the goal and latest requests, but not asks that merely start with a slash', () => {
    expect(isControlCommandTurn('/compact')).toBe(true);
    expect(isControlCommandTurn('/compact keep the login fix')).toBe(true);
    expect(isControlCommandTurn('/compaction is broken')).toBe(false);
    expect(isControlCommandTurn('/Users/me/app/server.ts throws on start')).toBe(false);
    const l = log().user('goal').user('/Users/me/app/server.ts throws on start').user('/compact the auth refactor')
      .assistant('Compacted.');
    const text = buildHandoffPreview(session(), l.events, { gitDiffStat: noGit }).text;
    expect(text).toMatch(/## Latest requests \(oldest first\)\n\n1\. \/Users\/me\/app\/server\.ts throws on start\n\n/);
    expect(text).not.toContain('/compact');
  });

  it('a later turn supersedes the summary: includeLastAssistant then shows the latest reply', () => {
    const l = summarised().user('actually, first rename the table').assistant('Renamed billing_v1 to billing.');
    const text = buildHandoffPreview(session(), l.events, { includeLastAssistant: true, gitDiffStat: noGit }).text;
    expect(text).toContain('> Renamed billing_v1 to billing.');
    expect(text).toMatch(/3\. actually, first rename the table\n\n/);
  });

  it('without includeLastAssistant the state is still the last reply (abridged when long)', () => {
    const text = buildHandoffPreview(session(), summarised().events, { gitDiffStat: noGit }).text;
    expect(text).toContain('## Where it stood (the previous agent\'s last reply)');
    expect(text).toContain('> Goal: billing on webhooks v2.');
  });
});

describe('the cap', () => {
  it('drops the lowest-priority sections first, whole, and names them', () => {
    const l = log().user(`goal ${'g'.repeat(5000)}`);
    for (let i = 0; i < 3; i += 1) l.user(`ask ${i} ${'a'.repeat(2000)}`);
    for (let i = 0; i < 80; i += 1) l.tool('Edit', { file_path: `src/deeply/nested/module-${i}/implementation-file-${i}.ts` });
    for (let i = 0; i < 20; i += 1) l.tool('Bash', { command: `run ${i} ${'c'.repeat(190)}` });
    for (let i = 0; i < 6; i += 1) l.error(`failure ${i} ${'e'.repeat(230)}`);
    l.assistant(`summary ${'s'.repeat(9000)}`);
    l.compaction(500_000, 20_000);
    const preview = buildHandoffPreview(session({ compactionCount: 1 }), l.events, {
      includeLastAssistant: true,
      focus: 'f'.repeat(500),
      gitDiffStat: () => Array.from({ length: 200 }, (_, i) => ` x${i} | 1 +`).join('\n'),
    });
    expect(preview.text.length).toBeLessThanOrEqual(VERSE_HANDOFF_MAX_CHARS);
    expect(preview.stats.chars).toBe(preview.text.length);
    // Dropped from the bottom of the priority list upward.
    const order = ['compactions', 'repositories', 'errors', 'commands', 'files', 'state', 'latest-asks', 'goal', 'focus'];
    expect(preview.stats.truncated.length).toBeGreaterThan(0);
    expect(preview.stats.truncated).toEqual(order.slice(0, preview.stats.truncated.length));
    for (const name of preview.stats.truncated) {
      const heading = { compactions: '## Compactions', repositories: '## Repositories', errors: '## Errors', commands: '## Commands', files: '## Files', state: '## Where it stood', 'latest-asks': '## Latest requests', goal: '## Original goal', focus: '## Focus' }[name];
      expect(preview.text).not.toContain(heading);
    }
    // The highest-priority sections survive.
    expect(preview.text).toContain('## Focus for this session');
    expect(preview.text).toContain('## Original goal');
    expect(preview.text).toContain('[… truncated]');
  });

  it('keeps everything when it fits', () => {
    const preview = buildHandoffPreview(session(), log().user('small').events, { gitDiffStat: noGit });
    expect(preview.stats.truncated).toEqual([]);
  });
});

describe('determinism and safety', () => {
  it('is byte-identical for the same inputs', () => {
    const l = log().user('goal').tool('Read', { file_path: 'a.ts' }).assistant('done');
    const opts = { gitDiffStat: () => ' a.ts | 1 +' };
    expect(buildHandoffPreview(session(), l.events, opts)).toEqual(buildHandoffPreview(session(), l.events, opts));
  });

  it('scrubs secrets from every section and the title', () => {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const l = log()
      .user(`use key ${key}`)
      .tool('Bash', { command: `curl -H "Authorization: Bearer ${key}" x` })
      .error(`401 for token=${key}`)
      .assistant(`set ANTHROPIC_API_KEY=${key}`);
    const preview = buildHandoffPreview(session({ title: `debug ${key}` }), l.events, { focus: `rotate ${key}`, gitDiffStat: noGit });
    expect(preview.text).not.toContain(key);
    expect(preview.sourceTitle).not.toContain(key);
    expect(preview.text).toContain('[REDACTED]');
  });

  it('strips NUL and other control characters (the note becomes argv) but keeps tabs and newlines', () => {
    const l = log()
      .user('goal with a NUL\u0000here and a bell\u0007')
      .user('ask\twith tab\u001b[31m and escape')
      .assistant('reply\u0085with C1\r\nand CRLF');
    const preview = buildHandoffPreview(session({ title: 'title\u0000x' }), l.events, { focus: 'focus\u0001line', gitDiffStat: noGit });
    // eslint-disable-next-line no-control-regex
    expect(preview.text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(preview.text).toContain('goal with a NULhere and a bell');
    expect(preview.text).toContain('ask\twith tab[31m and escape');
    expect(preview.text).toContain('focusline');
    expect(preview.sourceTitle).toBe('titlex');
  });

  it('has no model path: imports nothing that can dispatch', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'verse', 'session-handoff.ts'), 'utf8');
    expect(src).not.toMatch(/session-engine|startTurn|spawnEngine|provider-client|fetch\(/);
  });
});

describe('defaultGitDiffStat (real git)', () => {
  let tmp: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'verse-handoff-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports uncommitted changes, "" for a clean tree, null for a non-repo', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    expect(defaultGitDiffStat(repo)).toBe('');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    const stat = defaultGitDiffStat(repo);
    expect(stat).toContain('a.txt');
    expect(stat).toMatch(/1 file changed, 1 insertion/);

    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    expect(defaultGitDiffStat(plain)).toBeNull();
    expect(defaultGitDiffStat(join(tmp, 'missing'))).toBeNull();

    const unborn = join(tmp, 'unborn');
    mkdirSync(unborn);
    git(unborn, 'init', '-q');
    expect(defaultGitDiffStat(unborn)).toBeNull();
  });

  it('never runs a repository-configured external diff, textconv filter or fsmonitor hook', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.evil'), 'one\n');
    git(repo, 'add', 'a.evil');
    git(repo, 'commit', '-q', '-m', 'init');
    const marker = join(tmp, 'ran');
    const hook = join(tmp, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, '.gitattributes'), '*.evil diff=evil\n');
    git(repo, 'config', 'diff.evil.textconv', hook);
    git(repo, 'config', 'diff.evil.command', hook);
    git(repo, 'config', 'core.fsmonitor', hook);
    writeFileSync(join(repo, 'a.evil'), 'one\ntwo\n');

    const stat = defaultGitDiffStat(repo);
    expect(stat).toContain('a.evil');
    expect(existsSync(marker)).toBe(false);

    // Control: a plain `git diff --stat` in the same repo DOES run the filter,
    // so the assertion above is not vacuous.
    git(repo, 'diff', '--stat', 'HEAD');
    expect(existsSync(marker)).toBe(true);
  });

  it('is what buildHandoffPreview uses by default', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.ts'), 'a\n');
    git(repo, 'add', 'x.ts');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'x.ts'), 'b\n');
    const text = buildHandoffPreview(session({ projectPath: repo }), log().user('goal').events).text;
    expect(text).toContain('Uncommitted changes against HEAD');
    expect(text).toContain('x.ts');
  });
});
