/**
 * M513 — explicit caller-confirmed protected-PR submission CLI.
 *
 * Core Git/remote transaction behavior is exercised in M419. These tests keep
 * the CLI gate hermetic and prove that list/show never submit, non-TTY calls
 * require --yes, partial evidence is refused, and the exact proposal id/config
 * reach the protected handoff capability once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { submitSpy, autoMergeSpy, loadConfigSpy, questionSpy } = vi.hoisted(() => ({
  submitSpy: vi.fn(),
  autoMergeSpy: vi.fn(),
  loadConfigSpy: vi.fn(),
  questionSpy: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (question: string, callback: (answer: string) => void) => {
      questionSpy(question);
      callback('n');
    },
    close: vi.fn(),
  }),
}));

vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => autoMergeSpy(...args),
  submitVerifiedProtectedPr: (...args: unknown[]) => submitSpy(...args),
}));

vi.mock('../src/core/config.js', () => ({
  loadConfig: () => loadConfigSpy(),
}));

import { cmdInbox } from '../src/cli/inbox.js';
import { HELP_ENTRIES } from '../src/cli/help.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import type { AshlrConfig } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalLog = console.log;
const originalError = console.error;
const originalWrite = process.stdout.write.bind(process.stdout);
const originalStdoutTty = process.stdout.isTTY;
const originalStdinTty = process.stdin.isTTY;
let home: string;

function proposal(partial = false) {
  return createProposal({
    repo: '/tmp/enrolled-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'verified protected handoff',
    summary: 'submit one exact proposal to host review',
    diff: 'diff --git a/docs/a.md b/docs/a.md\n+review me\n',
    ...(partial ? { isPartial: true } : {}),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-m513-'));
  process.env.HOME = home;
  console.log = vi.fn();
  console.error = vi.fn();
  process.stdout.write = vi.fn() as typeof process.stdout.write;
  submitSpy.mockReset();
  autoMergeSpy.mockReset();
  loadConfigSpy.mockReset();
  questionSpy.mockReset();
  loadConfigSpy.mockReturnValue({ version: 1 } as AshlrConfig);
  submitSpy.mockResolvedValue({
    ok: true,
    merged: false,
    handoff: true,
    verificationFresh: true,
    reason: 'protected PR awaiting host merge',
    prUrl: 'https://github.com/ashlrai/fixture/pull/513',
  });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalWrite;
  Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTty, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTty, configurable: true });
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M513 inbox submit CLI', () => {
  it('requires --yes in non-TTY mode and performs no handoff on refusal', async () => {
    const pending = proposal();

    expect(await cmdInbox(['submit', pending.id])).toBe(2);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(loadConfigSpy).not.toHaveBeenCalled();
  });

  it('submits the exact proposal once with explicit confirmation and stable JSON', async () => {
    const pending = proposal();

    expect(await cmdInbox(['submit', pending.id, '--yes', '--json'])).toBe(0);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledWith(
      pending.id,
      expect.objectContaining({ version: 1 }),
      { confirmed: true },
    );
    const output = JSON.parse(String((console.log as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]));
    expect(output).toMatchObject({
      ok: true,
      merged: false,
      handoff: true,
      verificationFresh: true,
      prUrl: 'https://github.com/ashlrai/fixture/pull/513',
    });
  });

  it('shows the truthful protected-PR action without invoking it', async () => {
    const pending = proposal();

    expect(await cmdInbox(['show', pending.id])).toBe(0);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    expect(output).toContain(`ashlr inbox submit  ${pending.id.slice(0, 12)}`);
    expect(output).toContain('never merges main');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('refuses partial review evidence before loading config or handoff code', async () => {
    const partial = proposal(true);

    expect(await cmdInbox(['submit', partial.id, '--yes'])).toBe(1);
    expect(loadConfigSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('returns nonzero when the core cannot prove a protected PR handoff', async () => {
    const pending = proposal();
    submitSpy.mockResolvedValueOnce({
      ok: false,
      merged: false,
      reason: 'protected remote evidence unavailable',
    });

    expect(await cmdInbox(['submit', pending.id, '--yes', '--json'])).toBe(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('labels an idempotent replay as an observation rather than a fresh submission', async () => {
    const pending = proposal();
    submitSpy.mockResolvedValueOnce({
      ok: true,
      merged: false,
      handoff: true,
      observedExisting: true,
      verificationFresh: false,
      reason: 'existing protected PR observed; no verification or PR creation was performed',
      prUrl: 'https://github.com/ashlrai/fixture/pull/513',
    });

    expect(await cmdInbox(['submit', pending.id, '--yes'])).toBe(0);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    expect(output).toContain('Existing protected PR observed');
    expect(output).not.toContain('Protected PR handed off');
  });

  it('truthfully reports an uncertain result when a PR exists but final proof failed', async () => {
    const pending = proposal();
    submitSpy.mockResolvedValueOnce({
      ok: false,
      merged: false,
      handoff: true,
      verificationFresh: true,
      reason: 'final protected handoff confirmation is uncertain and requires reconciliation',
      prUrl: 'https://github.com/ashlrai/fixture/pull/513',
    });

    expect(await cmdInbox(['submit', pending.id, '--yes'])).toBe(1);
    const errors = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    expect(errors).toContain('handoff is uncertain; a PR exists or may exist');
    expect(output).toContain('https://github.com/ashlrai/fixture/pull/513');
  });

  it('documents JSON coverage and the unauthenticated nature of --yes truthfully', () => {
    const byCommand = new Map(HELP_ENTRIES.map((entry) => [entry.cmd, entry.desc]));
    expect(byCommand.get('inbox submit <id> --yes')).toMatch(/caller intent, not an authenticated human receipt/i);
    expect(byCommand.get('inbox --json')).toMatch(/submit/);
    expect(byCommand.get('inbox approve <id>')).not.toMatch(/ONLY outward path/i);
  });

  it('uses a purely observational confirmation prompt for an existing handoff', async () => {
    const pending = proposal();
    expect(setStatus(pending.id, 'awaiting-host-merge')).toBe(true);
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    expect(await cmdInbox(['submit', pending.id])).toBe(0);
    expect(questionSpy).toHaveBeenCalledTimes(1);
    const question = String(questionSpy.mock.calls[0]?.[0]);
    expect(question).toMatch(/observe this existing protected PR handoff/i);
    expect(question).not.toMatch(/verify|submit/i);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
