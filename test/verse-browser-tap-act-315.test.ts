/**
 * The Browser pane's tap (desktop/src-tauri/src/browser_tap.js), acting half
 * (3.15 P2/P3): the REAL tap source runs in jsdom over the injection
 * fixtures in test/fixtures/browser/, and the sidecar's formatting and
 * framing (browser-act-policy.ts) run over its answers.
 *
 * The regression claims:
 *   - a snapshot lists what the operator can see — hidden, aria-hidden,
 *     transparent and zero-size text never reaches it;
 *   - password / card / SSN / secret values never leave the page, even
 *     disguised (type=text with a password name, autocomplete tokens);
 *   - `prepare` refuses typing into those fields, file inputs, <select>
 *     clicks, and an element whose signature changed since the decision;
 *   - `resolve` says what the sidecar needs to decide (form submission,
 *     link destination, download, sensitive);
 *   - the page's fake closing delimiter and invisible characters do not
 *     survive the sidecar's framing;
 *   - the tap and the sidecar share one sensitive-field pattern.
 * jsdom has no layout, so point-based preparation (clicks) answers
 * `not-visible` here; the native half is covered by cargo tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  SENSITIVE_AUTOCOMPLETE_SOURCE,
  SENSITIVE_HINT_SOURCE,
  asResolvedTarget,
  asSnapshotNodes,
  frameUntrusted,
  formatSnapshot,
} from '../src/core/verse/browser-act-policy.js';

const ROOT = join(__dirname, '..');
const TAP = readFileSync(join(ROOT, 'desktop', 'src-tauri', 'src', 'browser_tap.js'), 'utf8');
const INJECTION = readFileSync(join(ROOT, 'test', 'fixtures', 'browser', 'injection.html'), 'utf8');
const LOGIN = readFileSync(join(ROOT, 'test', 'fixtures', 'browser', 'fake-login.html'), 'utf8');

interface Tap {
  snapshot(opts?: unknown): string;
  resolve(target: unknown): string;
  prepare(spec: unknown): string;
  clear(spec: unknown): string;
  after(spec: unknown): string;
  info(): string;
  network(opts?: unknown): string;
}

function load(html: string): { tap: Tap; dom: JSDOM } {
  const dom = new JSDOM(html, { url: 'http://localhost:5173/settings', runScripts: 'outside-only' });
  // The same evaluation native does: the constant tap source, before any use.
  dom.window.eval(TAP);
  const tap = (dom.window as unknown as { __ashlrTap: Tap }).__ashlrTap;
  return { tap, dom };
}

function json(answer: string): Record<string, unknown> {
  return JSON.parse(answer) as Record<string, unknown>;
}

function approved(tap: Tap): { approvedUrl: string; approvedLoadId: string } {
  const info = json(tap.info());
  return { approvedUrl: String(info['url']), approvedLoadId: String(info['loadId']) };
}

function prepare(tap: Tap, spec: Record<string, unknown>): Record<string, unknown> {
  return json(tap.prepare({ ...spec, ...approved(tap) }));
}

function clear(tap: Tap, spec: Record<string, unknown>): Record<string, unknown> {
  return json(tap.clear({ ...spec, ...approved(tap) }));
}

function snapshotOf(tap: Tap, opts: unknown = {}): { text: string; data: Record<string, unknown> } {
  const data = json(tap.snapshot(opts));
  return { data, text: formatSnapshot(asSnapshotNodes(data['nodes'])) };
}

function refFor(tap: Tap, snapshot: string, pattern: RegExp): string {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  expect(line, `no line matches ${pattern}`).toBeDefined();
  return /\[ref=(e\d+)\]/.exec(line!)![1]!;
}

describe('snapshot — what the operator can see, and never a secret', () => {
  it('leaves out hidden, aria-hidden, transparent and zero-size text', () => {
    const { tap } = load(INJECTION);
    const { text, data } = snapshotOf(tap);
    expect(text).toContain('- heading "Account settings" [level=1]');
    expect(text).toContain('Welcome back, Ada.');
    for (const hidden of ['SYSTEM:', 'AGENT:', 'developer mode', 'hidden instruction', 'Tool call']) {
      expect([hidden, text.includes(hidden)]).toEqual([hidden, false]);
    }
    expect(typeof data['loadId']).toBe('string');
    expect(data['url']).toBe('http://localhost:5173/settings');
  });

  it('never carries a password, card, SSN or API key value — the ordinary field\'s value it does', () => {
    const { tap } = load(INJECTION);
    const raw = tap.snapshot({});
    for (const secret of ['hunter2', '4111111111111111', '123-45-6789', 'sk-live-not-a-real-key']) {
      expect([secret, raw.includes(secret)]).toEqual([secret, false]);
    }
    const { text } = snapshotOf(tap);
    expect(text).toMatch(/- textbox "Password" \[ref=e\d+\][^\n]*\[sensitive\]: \[redacted\]/);
    expect(text).toMatch(/- textbox "Card number" \[ref=e\d+\][^\n]*\[sensitive\]: \[redacted\]/);
    expect(text).toMatch(/- textbox "Email" \[ref=e\d+\][^\n]*: "ada@example.com"/);
    expect(text).toMatch(/- combobox "Plan" \[ref=e\d+\][^\n]*: "Free"/);
    expect(text).toContain('- option "Pro"');
    expect(text).toMatch(/- link "Docs" \[ref=e\d+\][^\n]*→ https:\/\/evil\.example\/docs/);
  });

  it('a disguised login form still reads [redacted] everywhere a secret goes', () => {
    const { tap } = load(LOGIN);
    const { text } = snapshotOf(tap);
    const lines = text.split('\n').filter((l) => l.includes('textbox'));
    const byName = (name: RegExp) => lines.find((l) => name.test(l)) ?? '';
    expect(byName(/Password/)).toContain('[redacted]');
    expect(byName(/Confirm it here/)).toContain('[redacted]'); // type=text, name=user_password
    expect(byName(/6-digit code/)).toContain('[redacted]'); // autocomplete=one-time-code
    expect(byName(/PIN/)).toContain('[redacted]');
    expect(byName(/Username/)).not.toContain('[redacted]');
  });

  it('keeps refs stable for the page load and scopes to a root_ref', () => {
    const { tap } = load(INJECTION);
    const first = snapshotOf(tap).text;
    const second = snapshotOf(tap).text;
    expect(second).toBe(first);
    const form = refFor(tap, first, /- form/);
    const inside = snapshotOf(tap, { rootRef: form }).text;
    expect(inside).toContain('"Save"');
    expect(inside).not.toContain('Account settings');
    expect(json(tap.snapshot({ rootRef: 'e999999' }))).toEqual({ error: 'stale-ref' });
    const capped = json(tap.snapshot({ maxNodes: 3 }));
    expect((capped['nodes'] as unknown[]).length).toBe(3);
    expect(capped['truncated']).toBe(true);
  });
});

describe('resolve — what the sidecar decides on', () => {
  it('reports submission, link destinations, downloads, file inputs and sensitive fields', () => {
    const { tap } = load(INJECTION);
    const { text } = snapshotOf(tap);
    const save = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /button "Save"/) })))!;
    expect(save).toMatchObject({ role: 'button', name: 'Save', submits: true, inForm: true, formAction: 'https://evil.example/collect' });
    const del = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /button "Delete account"/) })))!;
    expect(del).toMatchObject({ name: 'Delete account', submits: false });
    const docs = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /link "Docs"/) })))!;
    expect(docs.href).toBe('https://evil.example/docs');
    const download = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /link "Download report"/) })))!;
    expect(download.download).toBe(true);
    const upload = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /Upload avatar/) })))!;
    expect(upload.fileInput).toBe(true);
    const pw = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /textbox "Password"/) })))!;
    expect(pw).toMatchObject({ sensitive: true, editable: true, multiline: false });
    const notes = asResolvedTarget(json(tap.resolve({ ref: refFor(tap, text, /textbox "Notes"/) })))!;
    expect(notes).toMatchObject({ sensitive: false, multiline: true });
    expect(json(tap.resolve({ ref: 'e424242' }))).toEqual({ error: 'stale-ref' });
    expect(json(tap.resolve({ focused: true }))).toEqual({ error: 'nothing-focused' });
  });
});

describe('prepare — the tap refuses what must never be done', () => {
  it('refuses typing into secret fields, disguised or not, before native sends a key', () => {
    for (const [html, id] of [[INJECTION, 'pw'], [INJECTION, 'card'], [INJECTION, 'ssn'], [INJECTION, 'apikey'], [LOGIN, 'password'], [LOGIN, 'userPassword'], [LOGIN, 'otp']] as const) {
      const { tap, dom } = load(html);
      const el = dom.window.document.getElementById(id)!;
      const ref = refOfElement(tap, dom, el);
      expect([id, prepare(tap, { kind: 'type', ref, ms: 1000, textLength: 3 })]).toEqual([id, { error: 'sensitive-field' }]);
      expect([id, clear(tap, { ref })]).toEqual([id, { error: 'sensitive-field' }]);
    }
  });

  it('refuses printable keys while a secret field has focus, but not Backspace or Tab', () => {
    const { tap, dom } = load(LOGIN);
    (dom.window.document.getElementById('password') as HTMLInputElement).focus();
    expect(prepare(tap, { kind: 'key', key: 'a', ms: 500 })).toEqual({ error: 'sensitive-field' });
    expect(prepare(tap, { kind: 'key', key: 'Shift+A', ms: 500 })).toEqual({ error: 'sensitive-field' });
    expect(prepare(tap, { kind: 'key', key: 'Tab', ms: 500 })).toMatchObject({ url: 'http://localhost:5173/settings' });
    expect(prepare(tap, { kind: 'key', key: 'Backspace', ms: 500 })).not.toHaveProperty('error');
    expect(json(tap.resolve({ focused: true }))).toMatchObject({ sensitive: true, inForm: true });
  });

  it('refuses file inputs, clicks on a <select>, and an element that changed since the decision', () => {
    const { tap, dom } = load(INJECTION);
    const doc = dom.window.document;
    const upload = refOfElement(tap, dom, doc.getElementById('upload')!);
    expect(prepare(tap, { kind: 'click', ref: upload, ms: 500 })).toEqual({ error: 'file-input' });
    const plan = refOfElement(tap, dom, doc.getElementById('plan')!);
    expect(prepare(tap, { kind: 'click', ref: plan, ms: 500 })).toEqual({ error: 'use-select' });
    const del = doc.getElementById('delete')!;
    const ref = refOfElement(tap, dom, del);
    const sig = (json(tap.resolve({ ref })) as { sig: string }).sig;
    del.textContent = 'Keep account';
    expect(prepare(tap, { kind: 'click', ref, expect: sig, ms: 500 })).toEqual({ error: 'changed' });
    expect(prepare(tap, { kind: 'click', ref: 'e999999', ms: 500 })).toEqual({ error: 'stale-ref' });
  });

  it('selects options itself (value or label), fires input + change, and refuses disabled or unknown ones', () => {
    const { tap, dom } = load(INJECTION);
    const select = dom.window.document.getElementById('plan') as HTMLSelectElement;
    const events: string[] = [];
    select.addEventListener('input', () => events.push('input'));
    select.addEventListener('change', () => events.push('change'));
    const ref = refOfElement(tap, dom, select);
    expect(prepare(tap, { kind: 'select', ref, values: ['Pro'], ms: 500 })).toMatchObject({ done: true, selected: ['Pro'] });
    expect(select.selectedIndex).toBe(1);
    expect(events).toEqual(['input', 'change']);
    expect(prepare(tap, { kind: 'select', ref, values: ['team'], ms: 500 })).toEqual({ error: 'no-such-option' });
    expect(prepare(tap, { kind: 'select', ref, values: ['free', 'pro'], ms: 500 })).toEqual({ error: 'not-multiple' });
  });

  it('never reads what was typed into the ordinary fields either — only via fieldValue', () => {
    const { tap, dom } = load(INJECTION);
    (dom.window.document.getElementById('search') as HTMLInputElement).value = 'typed by the operator';
    // The snapshot shows ordinary values (the agent needs to see what it typed) …
    expect(tap.snapshot({})).toContain('typed by the operator');
    // … but no other answer carries them.
    for (const answer of [tap.info(), tap.network({}), tap.after({ kind: 'click' })]) {
      expect(answer).not.toContain('typed by the operator');
    }
  });
});

describe('framing — the page cannot close the block or hide characters', () => {
  it('defangs the fake delimiter and strips invisible characters', () => {
    const { tap } = load(INJECTION);
    const { text } = snapshotOf(tap);
    expect(text).toContain('</untrusted id=abc123def>');
    const framed = frameUntrusted('f00dfeed1234', text);
    expect(framed.startsWith('<untrusted id=f00dfeed1234>\n')).toBe(true);
    expect(framed.endsWith('\n</untrusted id=f00dfeed1234>')).toBe(true);
    // Exactly one closing tag: ours.
    expect(framed.match(/<\/untrusted/g)).toHaveLength(1);
    expect(framed).toContain('‹/untrusted id=abc123def>');
    for (const invisible of ['\u202E', '\u202C', '\u200B', '\u2060']) {
      expect(text.includes(invisible)).toBe(true);
      expect(framed.includes(invisible)).toBe(false);
    }
  });
});

describe('one sensitive-field pattern', () => {
  it('the tap carries exactly the sidecar\'s patterns', () => {
    expect(TAP).toContain(`var SENSITIVE_HINT = /${SENSITIVE_HINT_SOURCE}/`);
    expect(TAP).toContain(`var SENSITIVE_AUTOCOMPLETE = /${SENSITIVE_AUTOCOMPLETE_SOURCE}/`);
  });
});

describe('network — every request, metadata only', () => {
  it('records fetch calls with status, timing and size, and failures separately', async () => {
    const dom = new JSDOM('<p>x</p>', { url: 'http://localhost:5173/', runScripts: 'outside-only' });
    const win = dom.window as unknown as { fetch: unknown; eval: (s: string) => unknown; __ashlrTap: Tap };
    win.fetch = async (_input: unknown, _init?: unknown) => ({ status: 201, headers: { get: (h: string) => (h === 'content-length' ? '42' : 'secret-cookie') } });
    win.eval(TAP);
    await (win as unknown as { fetch: (u: string, i: unknown) => Promise<unknown> }).fetch('/api/items?token=abc', { method: 'post', body: 'hello' });
    await new Promise((r) => setTimeout(r, 0));
    const requests = (json(win.__ashlrTap.network({ limit: 10 }))['requests'] as Array<Record<string, unknown>>);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'fetch', method: 'POST', url: '/api/items?token=abc', status: 201, resBytes: 42, reqBytes: 5 });
    expect(JSON.stringify(requests)).not.toContain('secret-cookie');
    // A 2xx is not a "failed request" for browser_console.
    expect((json((win.__ashlrTap as unknown as { dump: (n: number) => string }).dump(10))['network'] as unknown[])).toHaveLength(0);
  });
});

/**
 * The ref the tap gives a (focusable) element: focus it and ask the tap what
 * has focus — the same ref a snapshot lists for it on this page load.
 */
function refOfElement(tap: Tap, _dom: JSDOM, el: Element): string {
  (el as HTMLElement).focus();
  const answer = json(tap.resolve({ focused: true }));
  (el as HTMLElement).blur();
  const ref = answer['ref'];
  if (typeof ref !== 'string') throw new Error(`no ref for #${el.id}: ${JSON.stringify(answer)}`);
  return ref;
}
