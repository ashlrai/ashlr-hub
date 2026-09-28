/**
 * The Agents board: every chat in exactly one of Working / Needs you /
 * Ready for review / Done, using the chat list's own row statuses.
 */
import { describe, expect, it } from 'vitest';
import type { VerseActivityResponse, VerseSessionMetaResponse } from '../../../../core/verse/workbench-types.js';
import { bootstrap, session } from '../fixtures.test-support.js';
import { needsItem, runningRow, activityResponse } from '../mobile/mobile.test-support.js';
import { AGENT_COLUMNS, boardCounts, buildAgentsBoard } from './agents-board-model.js';

const projects = bootstrap().projects;

function board(sessions = [session()], activity: VerseActivityResponse | null = null, meta: VerseSessionMetaResponse | null = null, localSeen = new Map<string, number>()) {
  return buildAgentsBoard({ sessions, projects, activity, meta, localSeen });
}

function ids(columns: ReturnType<typeof board>) {
  return Object.fromEntries(columns.map((c) => [c.id, c.rows.map((r) => r.session.id)]));
}

describe('buildAgentsBoard', () => {
  it('has the four columns in order, each with its empty sentence', () => {
    expect(AGENT_COLUMNS.map((c) => c.label)).toEqual(['Working', 'Needs you', 'Ready for review', 'Done']);
    expect(board([]).every((c) => c.rows.length === 0 && c.empty.length > 0)).toBe(true);
  });

  it('files each chat in exactly one column', () => {
    const sessions = [
      session({ id: 'run', status: 'running', updatedAt: '2026-09-19T10:09:00Z' }),
      session({ id: 'failed', status: 'error', updatedAt: '2026-09-19T10:08:00Z' }),
      session({ id: 'asks', updatedAt: '2026-09-19T10:07:00Z' }),
      session({ id: 'unread', turnCount: 3, updatedAt: '2026-09-19T10:06:00Z' }),
      session({ id: 'done', turnCount: 2, updatedAt: '2026-09-19T10:05:00Z' }),
    ];
    const activity = activityResponse({
      needsYou: [needsItem({ id: 'chats:chat-failed:asks', kind: 'chat-failed', subject: { repo: null, pr: null, seatId: null, sessionId: 'asks', engine: null }, target: { kind: 'session', sessionId: 'asks' } })],
    });
    const meta: VerseSessionMetaResponse = {
      sessions: {
        unread: { sessionId: 'unread', pinned: false, archived: false, seenTurnCount: 1 },
        done: { sessionId: 'done', pinned: false, archived: false, seenTurnCount: 2 },
        run: { sessionId: 'run', pinned: false, archived: false, seenTurnCount: 1 },
        failed: { sessionId: 'failed', pinned: false, archived: false, seenTurnCount: 1 },
        asks: { sessionId: 'asks', pinned: false, archived: false, seenTurnCount: 1 },
      },
    };
    const columns = board(sessions, activity, meta);
    expect(ids(columns)).toEqual({ working: ['run'], 'needs-you': ['failed', 'asks'], review: ['unread'], done: ['done'] });
    expect(boardCounts(columns)).toEqual({ working: 1, 'needs-you': 2, review: 1, done: 1 });
  });

  it('a running chat with a question for you stays Working (it is still moving)', () => {
    const activity = activityResponse({
      running: [runningRow({ sessionId: 'vs_1' })],
      needsYou: [needsItem({ subject: { repo: null, pr: null, seatId: null, sessionId: 'vs_1', engine: null } })],
    });
    expect(ids(board([session()], activity)).working).toEqual(['vs_1']);
  });

  it('leaves archived chats out and sorts newest first', () => {
    const sessions = [
      session({ id: 'old', updatedAt: '2026-09-18T00:00:00Z' }),
      session({ id: 'new', updatedAt: '2026-09-19T00:00:00Z' }),
      session({ id: 'gone', updatedAt: '2026-09-20T00:00:00Z' }),
    ];
    const meta: VerseSessionMetaResponse = {
      sessions: {
        old: { sessionId: 'old', pinned: false, archived: false, seenTurnCount: 1 },
        new: { sessionId: 'new', pinned: true, archived: false, seenTurnCount: 1 },
        gone: { sessionId: 'gone', pinned: false, archived: true, seenTurnCount: 1 },
      },
    };
    expect(ids(board(sessions, activityResponse(), meta)).done).toEqual(['new', 'old']);
  });

  it('this tab having opened a chat clears its review dot', () => {
    const meta: VerseSessionMetaResponse = { sessions: { vs_1: { sessionId: 'vs_1', pinned: false, archived: false, seenTurnCount: 0 } } };
    expect(ids(board([session({ turnCount: 2 })], activityResponse(), meta)).review).toEqual(['vs_1']);
    expect(ids(board([session({ turnCount: 2 })], activityResponse(), meta, new Map([['vs_1', 2]]))).done).toEqual(['vs_1']);
  });
});
