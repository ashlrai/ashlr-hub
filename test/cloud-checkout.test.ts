/**
 * 3.11 cloud lane — isolated launch checkouts (src/core/cloud/checkout.ts).
 *
 * The real-git tests clone a local bare repository (originUrlFor points at a
 * file path), so nothing touches the network or GitHub. HOME is relocated per
 * test; the checkout lands under it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cloudCheckoutPath, ensureCloudCheckout, isSafeBranchName, KeyedMutex } from '../src/core/cloud/checkout.js';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  delete process.env['ASHLR_HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-checkout-')));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A bare "GitHub" repo with `master` and `v3110-cloud`, each with one distinguishing file. */
function makeOrigin(): string {
  const bare = path.join(home, 'origin.git');
  const work = path.join(home, 'work');
  git(home, 'init', '-q', '--bare', '-b', 'master', bare);
  git(home, 'init', '-q', '-b', 'master', work);
  fs.writeFileSync(path.join(work, 'README.md'), 'master\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'master');
  git(work, 'checkout', '-q', '-b', 'v3110-cloud');
  fs.writeFileSync(path.join(work, 'cloud.txt'), 'cloud\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'cloud');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'master', 'v3110-cloud');
  return bare;
}

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('isSafeBranchName', () => {
  it.each(['main', 'master', 'v3110-cloud', 'ashlr-cloud/ct_1', 'release/3.11.0'])('accepts %s', (b) => expect(isSafeBranchName(b)).toBe(true));
  it.each(['', '-main', '--upload-pack=x', 'a..b', 'a b', 'a/', '/a', 'a.lock', 'a//b', 'a/.b', 'x'.repeat(201), 'a;rm'])('refuses %j', (b) => expect(isSafeBranchName(b)).toBe(false));
});

describe('ensureCloudCheckout', () => {
  it('places the checkout at <cloudHome>/checkouts/<owner>__<name>', () => {
    expect(cloudCheckoutPath('ashlrai/ashlr-hub')).toBe(path.join(home, '.ashlr', 'cloud', 'checkouts', 'ashlrai__ashlr-hub'));
    expect(cloudCheckoutPath('AshlrAI/Ashlr-Hub')).toBe(cloudCheckoutPath('ashlrai/ashlr-hub'));
  });

  it('refuses a bad repo or branch without running git', async () => {
    let ran = 0;
    const deps = { git: async () => { ran += 1; return { ok: true, stdout: '', stderr: '' }; } };
    expect(await ensureCloudCheckout('not a repo', 'main', deps)).toMatchObject({ ok: false, failure: 'checkout-failed' });
    expect(await ensureCloudCheckout('a/b', '--upload-pack=evil', deps)).toMatchObject({ ok: false, failure: 'checkout-failed' });
    expect(ran).toBe(0);
  });

  it('runs clone, then fetch/checkout -B FETCH_HEAD/upstream/clean, with the GitHub URL by default', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const res = await ensureCloudCheckout('ashlrai/ashlr-hub', 'v3110-cloud', {
      git: async (args, opts) => {
        calls.push({ args, cwd: opts.cwd });
        if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1)!, '.git'), { recursive: true });
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const co = cloudCheckoutPath('ashlrai/ashlr-hub');
    expect(res).toEqual({ ok: true, path: co });
    expect(calls.map((c) => c.args)).toEqual([
      ['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', 'v3110-cloud', '--', 'https://github.com/ashlrai/ashlr-hub.git', co],
      ['remote', 'set-url', 'origin', 'https://github.com/ashlrai/ashlr-hub.git'],
      ['remote', 'set-branches', 'origin', '*'],
      ['fetch', '--depth', '1', '--no-tags', 'origin', '+refs/heads/v3110-cloud:refs/remotes/origin/v3110-cloud'],
      ['checkout', '--force', '-B', 'v3110-cloud', 'FETCH_HEAD'],
      ['branch', '--set-upstream-to=origin/v3110-cloud', 'v3110-cloud'],
      ['clean', '-ffdx'],
    ]);
    expect(calls[0]!.cwd).toBe(path.dirname(co));
    expect(calls.slice(1).every((c) => c.cwd === co)).toBe(true);
    expect(fs.statSync(path.dirname(co)).mode & 0o777).toBe(0o700);
  });

  it('classifies a missing branch/repo as no-remote and anything else as checkout-failed', async () => {
    const missing = await ensureCloudCheckout('a/b', 'nope', { git: async () => ({ ok: false, stdout: '', stderr: "warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin" }) });
    expect(missing).toMatchObject({ ok: false, failure: 'no-remote' });
    const other = await ensureCloudCheckout('a/b', 'main', { git: async () => ({ ok: false, stdout: '', stderr: 'fatal: disk full' }) });
    expect(other).toMatchObject({ ok: false, failure: 'checkout-failed' });
    // A failed clone leaves nothing half-made behind.
    expect(fs.existsSync(cloudCheckoutPath('a/b'))).toBe(false);
  });

  it('serialises concurrent callers per checkout folder', async () => {
    let active = 0;
    let peak = 0;
    const deps = {
      git: async (args: string[]) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1)!, '.git'), { recursive: true });
        active -= 1;
        return { ok: true, stdout: '', stderr: '' };
      },
    };
    const results = await Promise.all([
      ensureCloudCheckout('a/b', 'main', deps),
      ensureCloudCheckout('a/b', 'dev', deps),
      ensureCloudCheckout('a/b', 'main', deps),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(1);
  });

  it.runIf(hasGit)('with real git: shallow clone, switch base branches, upstream set, leftovers cleaned', async () => {
    const bare = makeOrigin();
    // file:// so git really makes a shallow clone (a plain path clones locally and ignores --depth).
    const deps = { originUrlFor: () => `file://${bare}` };
    const first = await ensureCloudCheckout('ashlrai/ashlr-hub', 'master', deps);
    expect(first.ok).toBe(true);
    const co = (first as { path: string }).path;
    expect(git(co, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master');
    expect(git(co, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(fs.existsSync(path.join(co, 'cloud.txt'))).toBe(false);

    fs.writeFileSync(path.join(co, 'leftover.txt'), 'x');
    fs.writeFileSync(path.join(co, 'README.md'), 'edited');
    const second = await ensureCloudCheckout('ashlrai/ashlr-hub', 'v3110-cloud', deps);
    expect(second).toEqual({ ok: true, path: co });
    expect(git(co, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('v3110-cloud');
    expect(git(co, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe('origin/v3110-cloud');
    expect(fs.existsSync(path.join(co, 'cloud.txt'))).toBe(true);
    expect(fs.existsSync(path.join(co, 'leftover.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(co, 'README.md'), 'utf8')).toBe('master\n');
    expect(git(co, 'status', '--porcelain')).toBe('');

    expect(await ensureCloudCheckout('ashlrai/ashlr-hub', 'missing-branch', deps)).toMatchObject({ ok: false, failure: 'no-remote' });
  }, 20_000);

  it.runIf(hasGit)('replaces a half-made checkout folder', async () => {
    const bare = makeOrigin();
    const co = cloudCheckoutPath('ashlrai/ashlr-hub');
    fs.mkdirSync(co, { recursive: true });
    fs.writeFileSync(path.join(co, 'junk'), 'x');
    expect(await ensureCloudCheckout('ashlrai/ashlr-hub', 'master', { originUrlFor: () => `file://${bare}` })).toEqual({ ok: true, path: co });
    expect(fs.existsSync(path.join(co, 'junk'))).toBe(false);
  }, 20_000);
});

describe('KeyedMutex', () => {
  it('runs one holder per key in FIFO order, keys independent, and releases on throw', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const hold = (key: string, label: string, ms: number, fail = false) => m.run(key, async () => {
      order.push(`start ${label}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${label}`);
      if (fail) throw new Error(label);
      return label;
    });
    const a = hold('k', 'a', 10, true);
    const b = hold('k', 'b', 1);
    const c = hold('other', 'c', 1);
    await expect(a).rejects.toThrow('a');
    expect(await b).toBe('b');
    expect(await c).toBe('c');
    expect(order.indexOf('end a')).toBeLessThan(order.indexOf('start b'));
    expect(order.indexOf('start c')).toBeLessThan(order.indexOf('end a'));
    expect(m.busy('k')).toBe(false);
    expect(m.busy('other')).toBe(false);
  });
});
