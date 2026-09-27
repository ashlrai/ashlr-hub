/**
 * 3.15 versioned playbooks (src/core/playbooks/**): parsing + validation,
 * immutable versioned storage under ~/.ashlr/playbooks, `!macro` / explicit /
 * auto resolution, rendering under the cap, the lane hooks (byte-identical
 * prompts when no playbook applies), the Leader's work.dispatch param, retro
 * attribution per version, and the CLI. HOME is relocated per test (the
 * global setup already isolates it; each test also starts from an empty
 * ~/.ashlr).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCloudPrompt } from '../src/core/cloud/delivery-contract.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';
import { buildDevinPrompt } from '../src/core/devin/delivery-contract.js';
import type { LedgerEntry } from '../src/core/authority/types.js';
import { listRetros } from '../src/core/learn/retro/store.js';
import { collectRetros, sweepRetros, withPlaybookRef, type RetroSweepDeps, type SweepProposal } from '../src/core/learn/retro/sweep.js';
import type { RetroV1 } from '../src/core/learn/retro/types.js';
import { BUILTIN_PLAYBOOK_SOURCES } from '../src/core/playbooks/builtins.js';
import { createPlaybook, newPlaybookVersion } from '../src/core/playbooks/index.js';
import { withFleetPlaybook, leaderPlaybookCatalog, playbookForLaunch } from '../src/core/playbooks/lanes.js';
import { canonicalizePlaybook, parsePlaybook, playbookTemplate, serializePlaybook } from '../src/core/playbooks/parse.js';
import {
  appendPlaybookBlock,
  choosePlaybook,
  findMacroMentions,
  registerPlaybookAutoMatcher,
  renderPlaybookBlock,
  resolvePlaybook,
  resolvePlaybookSync,
} from '../src/core/playbooks/resolve.js';
import { countPlaybookOutcomes } from '../src/core/playbooks/stats.js';
import {
  builtinPlaybooks,
  getPlaybook,
  getPlaybookSync,
  listLatestPlaybooks,
  listPlaybookVersions,
  playbooksHome,
  readPlaybookUses,
  recordPlaybookUse,
  savePlaybook,
} from '../src/core/playbooks/store.js';
import { PLAYBOOK_INJECT_CAP_BYTES, isPlaybookRef, type PlaybookRef, type PlaybookV1 } from '../src/core/playbooks/types.js';
import { parseActionParams } from '../src/core/vision/leader-memo.js';
import { runPlaybookCli, type PlaybookCliDeps } from '../src/cli/playbook.js';

const BUILTIN_IDS = ['add-tests-for-module', 'dependency-bump', 'docs-sync', 'fix-failing-test', 'fix-issue', 'perf-regression', 'security-fix'];

function source(over: { id?: string; macro?: string; kinds?: string; repos?: string; globs?: string; auto?: boolean; outcome?: string } = {}): string {
  const id = over.id ?? 'ship-widget';
  return [
    '---',
    `id: ${id}`,
    'name: Ship a widget',
    `macro: ${over.macro ?? `!${id}`}`,
    'description: Build the widget the careful way.',
    `kinds: [${over.kinds ?? 'feature'}]`,
    `repos: [${over.repos ?? ''}]`,
    `globs: [${over.globs ?? ''}]`,
    `auto: ${over.auto ? 'true' : 'false'}`,
    'budget-usd: 4',
    'done-when:',
    '  - npm test passes',
    '---',
    '',
    '## Outcome',
    '',
    over.outcome ?? 'The widget ships.',
    '',
    '## Procedure',
    '',
    '1. Build it.',
    '2. Test it.',
    '',
    '## Forbidden actions',
    '',
    '- Do not skip tests.',
    '',
  ].join('\n');
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  registerPlaybookAutoMatcher(null);
});

afterEach(() => {
  registerPlaybookAutoMatcher(null);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parsePlaybook', () => {
  it('every built-in is valid, already canonical, and ships auto: false', () => {
    expect(BUILTIN_PLAYBOOK_SOURCES).toHaveLength(7);
    for (const raw of BUILTIN_PLAYBOOK_SOURCES) {
      const c = canonicalizePlaybook(raw);
      expect(c.ok, raw.slice(0, 60)).toBe(true);
      if (!c.ok) continue;
      expect(c.source).toBe(raw);
      expect(c.meta.auto).toBe(false);
      expect(c.sections.Outcome).toBeTruthy();
      expect(c.sections['Forbidden actions']).toBeTruthy();
    }
    expect([...builtinPlaybooks().keys()].sort()).toEqual(BUILTIN_IDS);
  });

  it('reads front-matter and sections; round-trips through serialize', () => {
    const parsed = parsePlaybook(source({ macro: '!ship', repos: 'ashlrai/widget', globs: 'src/**' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta).toMatchObject({
      id: 'ship-widget', macro: '!ship', taskKinds: ['feature'], appliesTo: { repos: ['ashlrai/widget'], globs: ['src/**'] },
      doneWhen: ['npm test passes'], budget: { usd: 4, minutes: null }, auto: false,
    });
    expect(parsed.sections.Procedure).toBe('1. Build it.\n2. Test it.');
    const again = parsePlaybook(serializePlaybook(parsed.meta, parsed.sections));
    expect(again).toEqual(parsed);
  });

  it('keeps a glob with commas whole across a round-trip', () => {
    const parsed = parsePlaybook(source().replace('globs: []', 'globs:\n  - "src/{a,b}/**"'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.appliesTo.globs).toEqual(['src/{a,b}/**']);
    const again = parsePlaybook(serializePlaybook(parsed.meta, parsed.sections));
    expect(again.ok && again.meta.appliesTo.globs).toEqual(['src/{a,b}/**']);
  });

  it('a macro defaults to !<id>', () => {
    const parsed = parsePlaybook(source().replace('macro: !ship-widget\n', ''));
    expect(parsed.ok && parsed.meta.macro).toBe('!ship-widget');
  });

  it.each([
    ['no front-matter', '## Outcome\nx\n## Procedure\ny', 'front-matter'],
    ['bad id', source({ id: 'Bad_Id' }), 'id'],
    ['unknown key', source().replace('auto: false', 'auto: false\ncolour: blue'), 'colour'],
    ['duplicate key', source().replace('auto: false', 'auto: false\nauto: true'), 'auto'],
    ['unknown task kind', source({ kinds: 'party' }), 'kinds'],
    ['bad repo', source({ repos: 'not-a-repo' }), 'repos'],
    ['absolute glob', source({ globs: '/etc/**' }), 'globs'],
    ['auto with no scope', source({ auto: true, kinds: '' }), 'auto'],
    ['missing Outcome', source().replace('## Outcome\n\nThe widget ships.\n', ''), 'Outcome'],
    ['unknown section', `${source()}\n## Vibes\n\nGood ones.\n`, 'sections'],
    ['bad macro', source({ macro: '!!' }), 'macro'],
  ])('rejects %s', (_label, text, field) => {
    const parsed = parsePlaybook(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.field)).toContain(field);
  });

  it('ignores `## ` lines inside fenced code', () => {
    const parsed = parsePlaybook(source().replace('2. Test it.', '2. Test it.\n\n```md\n## Not a section\n```'));
    expect(parsed.ok).toBe(true);
  });

  it('the template is a valid playbook', () => {
    expect(parsePlaybook(playbookTemplate('my-flow')).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Storage + versioning
// ---------------------------------------------------------------------------

describe('playbook store', () => {
  it('lists the built-ins without writing anything', async () => {
    const all = await listLatestPlaybooks();
    expect(all.map((p) => p.meta.id)).toEqual(BUILTIN_IDS);
    expect(all.every((p) => p.builtin && p.version === 1)).toBe(true);
    expect(existsSync(playbooksHome())).toBe(false);
  });

  it('creates v1, then every edit is a new immutable version (0600 files, 0700 dir)', async () => {
    const v1 = await savePlaybook(source(), { author: 'mason', note: 'first' });
    expect(v1.ok && v1.playbook.version).toBe(1);
    const v1File = join(playbooksHome(), 'ship-widget', 'v1.md');
    const v1Text = readFileSync(v1File, 'utf8');
    expect(statSync(v1File).mode & 0o777).toBe(0o600);
    expect(statSync(join(playbooksHome(), 'ship-widget')).mode & 0o777).toBe(0o700);

    const v2 = await savePlaybook(source({ outcome: 'The widget ships, documented.' }), { baseVersion: 1, note: 'docs too' });
    expect(v2.ok && v2.playbook.version).toBe(2);
    expect(readFileSync(v1File, 'utf8')).toBe(v1Text);
    expect((await getPlaybook('ship-widget'))!.version).toBe(2);
    expect((await getPlaybook('ship-widget', 1))!.sections.Outcome).toBe('The widget ships.');
    expect(getPlaybookSync('ship-widget', 1)!.sha).toBe((await getPlaybook('ship-widget', 1))!.sha);
    const versions = await listPlaybookVersions('ship-widget');
    expect(versions.map((v) => [v.version, v.note, v.author])).toEqual([[1, 'first', 'mason'], [2, 'docs too', null]]);
  });

  it('the first edit of a built-in persists its shipped v1 verbatim, then v2', async () => {
    const shipped = builtinPlaybooks().get('fix-issue')!;
    const edited = shipped.source.replace('Reproduce the bug', 'Reproduce the reported bug');
    expect(edited).not.toBe(shipped.source);
    const res = await newPlaybookVersion(edited, { baseVersion: 1 });
    expect(res.ok && res.playbook.version).toBe(2);
    expect(readFileSync(join(playbooksHome(), 'fix-issue', 'v1.md'), 'utf8')).toBe(shipped.source);
    const v1 = await getPlaybook('fix-issue', 1);
    expect(v1!.sha).toBe(shipped.sha);
    expect(v1!.builtin).toBe(false);
  });

  it('refuses a stale base version, an identical save, a secret, and a macro another playbook owns', async () => {
    await savePlaybook(source());
    await savePlaybook(source({ outcome: 'v2' }));
    const stale = await savePlaybook(source({ outcome: 'v3' }), { baseVersion: 1 });
    expect(!stale.ok && stale.errors[0]!.field).toBe('version');
    const same = await savePlaybook(source({ outcome: 'v2' }));
    expect(!same.ok && same.errors[0]!.field).toBe('source');
    const secret = await savePlaybook(source({ outcome: 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push.' }));
    expect(!secret.ok && secret.errors[0]!.message).toMatch(/secret/);
    const clash = await savePlaybook(source({ id: 'other-flow', macro: '!fix-bug' }));
    expect(!clash.ok && clash.errors[0]!.field).toBe('macro');
    const aliasClash = await savePlaybook(source({ id: 'other-flow', macro: '!fix-issue' }));
    expect(!aliasClash.ok && aliasClash.errors[0]!.field).toBe('macro');
    expect(readdirSync(join(playbooksHome(), 'ship-widget')).sort()).toEqual(['v1.md', 'v2.md']);
  });

  it('create refuses an existing id; newVersion refuses an unknown id', async () => {
    expect((await createPlaybook(source())).ok).toBe(true);
    const again = await createPlaybook(source({ outcome: 'x' }));
    expect(!again.ok && again.errors[0]!.field).toBe('id');
    const unknown = await newPlaybookVersion(source({ id: 'nope-flow' }));
    expect(!unknown.ok && unknown.errors[0]!.field).toBe('id');
  });

  it('a version file whose id disagrees with its folder is not trusted', async () => {
    await savePlaybook(source());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(playbooksHome(), 'ship-widget', 'v2.md'), source({ id: 'someone-else' }), { mode: 0o600 });
    expect(await getPlaybook('ship-widget', 2)).toBeNull();
  });

  it('records uses append-only and reads the newest per lane:key', async () => {
    const ref: PlaybookRef = { id: 'fix-issue', version: 1, sha: builtinPlaybooks().get('fix-issue')!.sha };
    await recordPlaybookUse({ lane: 'fleet', key: 'run-1', ref, match: 'macro' });
    await recordPlaybookUse({ lane: 'fleet', key: 'run-1', ref: { ...ref, version: 2 }, match: 'macro' });
    await recordPlaybookUse({ lane: 'fleet', key: '../escape', ref, match: 'macro' });
    const uses = await readPlaybookUses();
    expect(uses.size).toBe(1);
    expect(uses.get('fleet:run-1')!.ref.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Resolution + rendering
// ---------------------------------------------------------------------------

describe('resolution', () => {
  const catalog = (): PlaybookV1[] => [...builtinPlaybooks().values()];

  it('finds !macros in prose, never in code, never mid-word', () => {
    expect(findMacroMentions('Please !fix-bug the parser, then !docs-sync@v2')).toEqual([
      { name: 'fix-bug', version: null }, { name: 'docs-sync', version: 2 },
    ]);
    expect(findMacroMentions('if (!fix-bug) `!fix-bug` a!fix-bug\n```\n!fix-bug\n```')).toEqual([]);
  });

  it('explicit beats macro beats auto; an unknown explicit name is reported', () => {
    expect(choosePlaybook(catalog(), { explicit: 'docs-sync', text: '!fix-bug now', repo: null })).toEqual({ id: 'docs-sync', version: null, match: 'explicit' });
    expect(choosePlaybook(catalog(), { explicit: '!fix-bug@v1', text: '', repo: null })).toEqual({ id: 'fix-issue', version: 1, match: 'explicit' });
    expect(choosePlaybook(catalog(), { text: 'Crash on start. !fix-bug', repo: null })).toEqual({ id: 'fix-issue', version: null, match: 'macro' });
    expect(choosePlaybook(catalog(), { text: 'use !fix-issue', repo: null })).toEqual({ id: 'fix-issue', version: null, match: 'macro' });
    expect(choosePlaybook(catalog(), { explicit: 'nope', text: '', repo: null })).toEqual({ unknown: 'nope' });
    expect(choosePlaybook(catalog(), { text: 'wow !important', repo: null })).toBeNull();
  });

  it('auto-matches only playbooks switched to auto, most specific first', async () => {
    // Built-ins are auto: false — a plain bug-fix task gets nothing.
    expect(choosePlaybook(catalog(), { text: 'Fix the crash in the parser', repo: 'ashlrai/widget' })).toBeNull();
    await savePlaybook(source({ id: 'any-fix', kinds: 'fix', auto: true }));
    await savePlaybook(source({ id: 'widget-fix', kinds: 'fix', repos: 'ashlrai/widget', auto: true }));
    const all = await listLatestPlaybooks();
    expect(choosePlaybook(all, { text: 'Fix the crash in the parser', repo: 'ashlrai/widget' })).toMatchObject({ id: 'widget-fix', match: 'auto' });
    expect(choosePlaybook(all, { text: 'Fix the crash in the parser', repo: '/Users/x/mirrors/ashlrai__widget' })).toMatchObject({ id: 'widget-fix' });
    expect(choosePlaybook(all, { text: 'Fix the crash in the parser', repo: 'ashlrai/other' })).toMatchObject({ id: 'any-fix' });
    expect(choosePlaybook(all, { text: 'Write the README', repo: 'ashlrai/widget' })).toBeNull();
  });

  it('a registered matcher is used only above its confidence gate, only among auto playbooks', async () => {
    await savePlaybook(source({ id: 'any-fix', kinds: 'fix', auto: true }));
    await savePlaybook(source({ id: 'docs-auto', kinds: 'docs', auto: true }));
    const all = await listLatestPlaybooks();
    registerPlaybookAutoMatcher(() => ({ id: 'docs-auto', confidence: 0.95 }), { minConfidence: 0.9 });
    expect(choosePlaybook(all, { text: 'Fix the crash', repo: null })).toMatchObject({ id: 'docs-auto', match: 'auto' });
    registerPlaybookAutoMatcher(() => ({ id: 'docs-auto', confidence: 0.5 }), { minConfidence: 0.9 });
    expect(choosePlaybook(all, { text: 'Fix the crash', repo: null })).toMatchObject({ id: 'any-fix' });
    registerPlaybookAutoMatcher(() => ({ id: 'fix-issue', confidence: 1 }));
    expect(choosePlaybook(all, { text: 'Fix the crash', repo: null })).toMatchObject({ id: 'any-fix' });
    registerPlaybookAutoMatcher(() => { throw new Error('boom'); });
    expect(choosePlaybook(all, { text: 'Fix the crash', repo: null })).toMatchObject({ id: 'any-fix' });
  });

  it('resolves pinned versions, and refuses a pin that does not exist', async () => {
    await savePlaybook(source());
    await savePlaybook(source({ outcome: 'Second.' }));
    const pinned = await resolvePlaybook({ text: 'go !ship-widget@v1', repo: null });
    expect(pinned.ok && pinned.resolved?.ref.version).toBe(1);
    expect(resolvePlaybookSync({ text: 'go !ship-widget', repo: null })?.ref.version).toBe(2);
    const missing = await resolvePlaybook({ explicit: 'ship-widget@v9', text: '', repo: null });
    expect(missing).toEqual({ ok: false, error: 'The playbook “ship-widget” has no version 9.' });
    const unknown = await resolvePlaybook({ explicit: 'no-such', text: '', repo: null });
    expect(unknown.ok).toBe(false);
  });

  it('renders sections, done-when and budget under a heading that names id@version', () => {
    const block = renderPlaybookBlock(builtinPlaybooks().get('fix-issue')!);
    expect(block.startsWith('## Playbook: Fix a reported bug (!fix-bug · fix-issue@v1)')).toBe(true);
    for (const h of ['### Outcome', '### Procedure', '### Forbidden actions', '### Required from user', '### Done when', '### Budget']) {
      expect(block).toContain(h);
    }
    expect(block).toContain('stop and report what is missing');
  });

  it('never exceeds the cap: optional sections go first, whole', () => {
    const pb = builtinPlaybooks().get('fix-issue')!;
    const full = renderPlaybookBlock(pb);
    const small = renderPlaybookBlock(pb, Buffer.byteLength(full) - 10);
    expect(small).not.toContain('### Advice');
    expect(small).toContain('### Procedure');
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(PLAYBOOK_INJECT_CAP_BYTES);
    expect(renderPlaybookBlock(pb, 10)).toBe('');
  });

  it('appending an empty block is byte-identical', () => {
    expect(appendPlaybookBlock('prompt', '')).toBe('prompt');
    expect(appendPlaybookBlock('prompt', 'B')).toBe('prompt\n\nB');
  });
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

const TASK = {
  id: 'ct_20260927T1000_aaaaaa', repo: 'ashlrai/widget', branch: 'ashlr-cloud/ct_20260927T1000_aaaaaa', baseBranch: 'main', title: 'Fix it', prompt: 'Fix the parser crash.',
} as unknown as CloudTaskV1;

describe('lane hooks', () => {
  it('fleet: no playbook ⇒ the goal is byte-identical and nothing is recorded', async () => {
    const goal = 'GOAL TEXT\n\nguidance';
    expect(withFleetPlaybook(goal, { repo: '/tmp/repo', title: 'Fix crash', detail: 'The parser crashes.' }, 'run-1')).toBe(goal);
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(playbooksHome())).toBe(false);
  });

  it('fleet: a !macro appends the block and records runId → id@version', async () => {
    const goal = 'GOAL TEXT';
    const out = withFleetPlaybook(goal, { repo: '/tmp/repo', title: 'Fix crash', detail: 'Parser crash. !fix-bug' }, 'run-42');
    expect(out.startsWith('GOAL TEXT\n\n## Playbook: Fix a reported bug')).toBe(true);
    let uses = await readPlaybookUses();
    for (let i = 0; i < 20 && uses.size === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      uses = await readPlaybookUses();
    }
    expect(uses.get('fleet:run-42')).toMatchObject({ lane: 'fleet', match: 'macro', ref: { id: 'fix-issue', version: 1 } });
  });

  it('cloud + Devin prompt builders are byte-identical with no playbook, and put the block before the contract', () => {
    expect(buildCloudPrompt(TASK, '', '')).toBe(buildCloudPrompt(TASK));
    expect(buildCloudPrompt(TASK, 'LESSONS', '')).toBe(buildCloudPrompt(TASK, 'LESSONS'));
    const cloud = buildCloudPrompt(TASK, 'LESSONS', 'PLAYBOOK');
    expect(cloud.indexOf('PLAYBOOK')).toBeGreaterThan(cloud.indexOf('Fix the parser crash.'));
    expect(cloud.indexOf('PLAYBOOK')).toBeLessThan(cloud.indexOf('LESSONS'));
    expect(cloud.indexOf('LESSONS')).toBeLessThan(cloud.indexOf('DELIVERY CONTRACT'));
    expect(buildDevinPrompt(TASK, '')).toBe(buildDevinPrompt(TASK));
    const devin = buildDevinPrompt(TASK, 'PLAYBOOK');
    expect(devin.startsWith('Fix the parser crash.\n\nPLAYBOOK\n\n---\nDELIVERY CONTRACT')).toBe(true);
  });

  it('launch resolution: none, macro, explicit, unknown explicit', async () => {
    expect(await playbookForLaunch({ title: 'T', prompt: 'Just do it', repo: 'ashlrai/widget' })).toEqual({ ok: true, ref: null, match: null, block: '' });
    const macro = await playbookForLaunch({ title: 'T', prompt: 'Crash !fix-bug', repo: 'ashlrai/widget' });
    expect(macro.ok && macro.ref?.id).toBe('fix-issue');
    expect(macro.ok && macro.block).toContain('## Playbook:');
    const explicit = await playbookForLaunch({ explicit: 'docs-sync', title: 'T', prompt: 'x', repo: 'ashlrai/widget' });
    expect(explicit.ok && explicit.match).toBe('explicit');
    const unknown = await playbookForLaunch({ explicit: 'nope-nope', title: 'T', prompt: 'x', repo: 'ashlrai/widget' });
    expect(unknown.ok).toBe(false);
  });

  it('Leader: work.dispatch may name a playbook; it rides in the detail as a !macro line', () => {
    const ok = parseActionParams('work.dispatch', { task: { repo: 'ashlrai/widget', title: 'Fix parser', detail: 'It crashes.', difficulty: 'low', value: 3, playbook: 'fix-issue' } });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.params.task.detail).toBe('It crashes.\n\nPlaybook: !fix-issue');
    expect(choosePlaybook([...builtinPlaybooks().values()], { text: ok.params.task.detail, repo: null })).toMatchObject({ id: 'fix-issue' });
    const without = parseActionParams('work.dispatch', { task: { repo: 'ashlrai/widget', title: 'Fix parser', detail: 'It crashes.', difficulty: 'low', value: 3 } });
    expect(without.ok && without.params.task.detail).toBe('It crashes.');
    const bad = parseActionParams('work.dispatch', { task: { repo: 'ashlrai/widget', title: 'x', difficulty: 'low', value: 3, playbook: '../etc' } });
    expect(bad.ok).toBe(false);
  });

  it('Leader catalog lists the playbooks, bounded', () => {
    const rows = leaderPlaybookCatalog();
    expect(rows.map((r) => r.id)).toEqual(BUILTIN_IDS);
    expect(leaderPlaybookCatalog(2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('attribution', () => {
  const ref: PlaybookRef = { id: 'fix-issue', version: 2, sha: 'abcdefabcdef' };

  it('withPlaybookRef attaches only a well-formed ref', () => {
    const retro = { id: 'rt_x' } as RetroV1;
    expect(withPlaybookRef(retro, undefined)).toBe(retro);
    expect(withPlaybookRef(retro, { id: 'x' })).toBe(retro);
    expect(withPlaybookRef(retro, ref).playbookRef).toEqual(ref);
    expect(isPlaybookRef(ref)).toBe(true);
  });

  it('cloud retros carry the task\'s playbookRef', () => {
    const task = {
      v: 1, id: 'ct_20260926T1000_aaaaaa', repo: 'ashlrai/widget', baseBranch: 'main', branch: 'ashlr-cloud/x', title: 'Fix', prompt: 'Fix !fix-bug',
      origin: 'operator', requestedBy: 'mason', seat: 'claude-a', sessionId: null, sessionUrl: null, state: 'merged', stateReason: null,
      failure: null, createdAt: iso(NOW - 2 * DAY), launchedAt: null, updatedAt: iso(NOW - DAY), pr: null, report: null, estimatedCostUsd: 0,
      backlogItemId: null, needsYouId: null, playbookRef: ref,
    } as CloudTaskV1;
    const [retro] = collectRetros({ ledger: null, inbox: null, cloud: [task], leader: null, load: () => null, sinceIso: iso(NOW - 30 * DAY), nowIso: iso(NOW) });
    expect(retro!.playbookRef).toEqual(ref);
  });

  it('fleet retros are attributed through the proposal runId and the uses ledger', async () => {
    const entries = [
      { v: 1, seq: 1, at: iso(NOW - DAY), actor: 'daemon', grantId: 'g', repo: 'ashlrai/widget', prevHash: 'x', hash: 'y', kind: 'gate:result',
        data: { v: 1, gate: 'G3', proposalId: 'p-1', repo: 'ashlrai/widget', headSha: null, verdict: 'refuse', code: 'verify-failed', reason: 'tests failed', at: iso(NOW - DAY), digest: 'd' } },
      { v: 1, seq: 2, at: iso(NOW - DAY), actor: 'daemon', grantId: 'g', repo: 'ashlrai/widget', prevHash: 'x', hash: 'y', kind: 'gate:result',
        data: { v: 1, gate: 'G3', proposalId: 'p-2', repo: 'ashlrai/widget', headSha: null, verdict: 'refuse', code: 'verify-failed', reason: 'tests failed', at: iso(NOW - DAY), digest: 'd' } },
    ] as unknown as LedgerEntry[];
    const proposals: Record<string, SweepProposal> = {
      'p-1': { id: 'p-1', title: 'Fix parser', summary: '', status: 'rejected', createdAt: iso(NOW - 2 * DAY), runId: 'run-a' },
      'p-2': { id: 'p-2', title: 'Fix lexer', summary: '', status: 'rejected', createdAt: iso(NOW - 2 * DAY), runId: 'run-b' },
    };
    const deps: RetroSweepDeps = {
      now: () => NOW,
      readLedger: async () => ({ entries, head: null, chain: 'ok', brokenAtSeq: null, reason: null }) as never,
      decidedProposals: () => [],
      loadProposal: (id) => proposals[id] ?? null,
      cloudTasks: () => [],
      leaderActions: () => [],
      model: null,
      playbookUses: async () => new Map([['fleet:run-a', { ref }]]),
    };
    await sweepRetros(deps);
    const retros = await listRetros();
    const byTask = new Map(retros.map((r) => [r.taskId, r]));
    expect(byTask.get('p-1')!.playbookRef).toEqual(ref);
    expect(byTask.get('p-2')!.playbookRef).toBeUndefined();
  });

  it('counts outcomes per version', () => {
    const r = (endKind: RetroV1['endKind'], version: number | null, id = 'fix-issue') => ({
      endKind, playbookRef: version === null ? undefined : { id, version, sha: 'abcdefabcdef' },
    });
    const counts = countPlaybookOutcomes([
      r('merged', 1), r('merged', 2), r('gate-refused', 2), r('reverted', 2), r('verify-failed', 2), r('owner-laned', 2),
      r('merged', null), r('merged', 2, 'other'),
    ], 'fix-issue');
    expect(counts.get(1)).toEqual({ merged: 1, refused: 0, reverted: 0, failed: 0, total: 1 });
    expect(counts.get(2)).toEqual({ merged: 1, refused: 2, reverted: 1, failed: 1, total: 5 });
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('ashlr playbook', () => {
  function cli(over: Partial<PlaybookCliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const launched: unknown[] = [];
    const deps: Partial<PlaybookCliDeps> = {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      color: false,
      cwd: () => '/tmp',
      originRepo: () => null,
      readStdin: () => null,
      edit: () => null,
      launchCloud: async (req) => {
        launched.push({ lane: 'cloud', ...req });
        return { ok: true, task: { id: 'ct_1', sessionUrl: null } as unknown as CloudTaskV1, error: null, failure: null };
      },
      launchDevin: async (req) => {
        launched.push({ lane: 'devin', ...req });
        return { ok: false, task: null, error: 'Devin is off.', failure: 'not-enabled' } as never;
      },
      ...over,
    };
    return { deps, out, err, launched };
  }

  it('list prints the built-ins', async () => {
    const c = cli();
    expect(await runPlaybookCli(['list'], c.deps)).toBe(0);
    expect(c.out.join('\n')).toContain('fix-issue');
    expect(c.out.join('\n')).toContain('!fix-bug');
  });

  it('show renders the playbook with its versions', async () => {
    const c = cli();
    expect(await runPlaybookCli(['show', 'fix-issue'], c.deps)).toBe(0);
    expect(c.out.join('\n')).toContain('## Playbook: Fix a reported bug');
    expect(c.out.join('\n')).toContain('v1');
    expect(await runPlaybookCli(['show', 'nope-nope'], c.deps)).toBe(1);
  });

  it('new from --file writes v1; edit from --file writes v2', async () => {
    const files: Record<string, string> = { '/a.md': source(), '/b.md': source({ outcome: 'Better.' }) };
    const c = cli({ readFile: (p) => files[p]! });
    expect(await runPlaybookCli(['new', 'ship-widget', '--file', '/a.md'], c.deps)).toBe(0);
    expect(await runPlaybookCli(['edit', 'ship-widget', '--file=/b.md', '--note', 'clearer'], c.deps)).toBe(0);
    expect(c.out).toEqual([expect.stringContaining('ship-widget@v1'), expect.stringContaining('ship-widget@v2')]);
    expect((await listPlaybookVersions('ship-widget')).map((v) => [v.version, v.author, v.note])).toEqual([[1, 'cli', null], [2, 'cli', 'clearer']]);
    expect(await runPlaybookCli(['new', 'other-id', '--file', '/a.md'], c.deps)).toBe(1);
  });

  it('run launches the cloud lane pinned to id@version; Devin refusals surface', async () => {
    const c = cli();
    expect(await runPlaybookCli(['run', 'fix-issue', '--repo', 'ashlrai/widget', '--task', 'Crash on start'], c.deps)).toBe(0);
    expect(c.launched[0]).toMatchObject({ lane: 'cloud', repo: 'ashlrai/widget', prompt: 'Crash on start', origin: 'cli', playbook: 'fix-issue@v1', title: 'Fix a reported bug' });
    expect(await runPlaybookCli(['run', 'fix-issue', '--repo', 'ashlrai/widget', '--lane', 'devin'], c.deps)).toBe(1);
    expect(c.err.join('\n')).toContain('Devin is off.');
    expect(await runPlaybookCli(['run', 'fix-issue'], c.deps)).toBe(2);
    expect(await runPlaybookCli(['run', 'fix-issue', '--repo', 'a/b', '--lane', 'moon'], c.deps)).toBe(2);
  });
});
