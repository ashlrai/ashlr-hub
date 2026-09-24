import { describe, expect, it } from 'vitest';
import { CLAUDE_MAX_SEAT, GROK_SEAT } from '../seat-fixtures.test-support.js';
import { issuesHeadline, needsAttention, seatHealthIssues, shellCommandText } from './health-model.js';
import { healthReport } from './health.test-support.js';

const NOW = Date.parse('2026-09-23T20:00:00.000Z');

describe('seat health model', () => {
  it('surfaces problems, most urgent first, and stays quiet about seats that are fine or merely unchecked', () => {
    const reports = [
      healthReport('grok', { connection: 'binary-skew', reasons: ['Pinned to Grok CLI 0.2.106; 0.2.118 is installed.'] }),
      healthReport('claude', { connection: 'signed-out', reasons: ['Claude Code reports this account is not signed in.'] }),
      healthReport('codex-personal', { connection: 'exhausted', resetAt: '2026-09-25T18:25:00.000Z' }),
      healthReport('codex-cmp', { connection: 'connected' }),
      healthReport('fresh', { connection: 'unknown', reasons: ['No status reading yet — the background health sweep has not reached this seat.'] }),
      healthReport('local:qwen', { engine: 'local', connection: 'unknown', reasons: ['Ollama is not answering at http://127.0.0.1:11434.'] }),
    ];
    const issues = seatHealthIssues(reports, [CLAUDE_MAX_SEAT, GROK_SEAT], NOW);
    expect(issues.map((i) => [i.report.seatId, i.word, i.tone])).toEqual([
      ['claude', 'signed out', 'danger'],
      ['codex-personal', 'out of usage', 'danger'],
      ['grok', 'older CLI pinned', 'warning'],
      ['local:qwen', 'not checked', 'neutral'],
    ]);
    expect(issues[0]!.label).toBe('Claude Max');
    expect(issues[1]!.label).toBe('codex-personal');
    expect(issues[1]!.reset).toMatch(/^resets /);
    expect(needsAttention(reports[4]!)).toBe(false);
  });

  it('writes a headline that leads with what cannot run', () => {
    const one = seatHealthIssues([healthReport('claude', { connection: 'signed-out' })], [CLAUDE_MAX_SEAT], NOW);
    expect(issuesHeadline(one)).toBe("Claude Max can't run turns right now.");
    const two = seatHealthIssues([
      healthReport('claude', { connection: 'signed-out' }), healthReport('grok', { connection: 'exhausted' }),
    ], [], NOW);
    expect(issuesHeadline(two)).toBe("2 seats can't run turns right now.");
    const warn = seatHealthIssues([healthReport('grok', { connection: 'expiring' })], [GROK_SEAT], NOW);
    expect(issuesHeadline(warn)).toBe('Grok needs attention.');
    expect(issuesHeadline([])).toBe('All seats are connected.');
  });

  it('renders an argv as a copyable command, keeping ~ expandable and quoting anything else', () => {
    expect(shellCommandText(['ashlr', 'resources', 'profile', 'repin', '--directory', '~/.ashlr/native-profiles/codex-a',
      '--executable', '/Applications/ChatGPT.app/Contents/Resources/codex'])).toBe(
      'ashlr resources profile repin --directory ~/.ashlr/native-profiles/codex-a --executable /Applications/ChatGPT.app/Contents/Resources/codex');
    expect(shellCommandText(['echo', "it's", '~/My Dir/x', '$(rm)'])).toBe(`echo 'it'\\''s' ~/'My Dir/x' '$(rm)'`);
  });
});
