/**
 * test/helpers/fake-typesafe.ts — an in-process fake of TypeSafe's System One
 * endpoint (POST /v1/systemone), installed as a `fetch` stub.
 *
 * It speaks the verified wire format (docs/JEV-INTEGRATION.md): it parses the
 * request body, hands the question map to a scripted responder, and answers
 * `{ model, answers, usage }`. Nothing here opens a socket, so suites using it
 * stay out of the real-io lane, and nothing can ever reach the paid API: the
 * fake answers only for FAKE_TYPESAFE_ENDPOINT and 404s everything else.
 */

import { vi } from 'vitest';

export const FAKE_TYPESAFE_ENDPOINT = 'https://typesafe.fake.invalid/v1/systemone';
export const FAKE_TYPESAFE_KEY = 'fake-typesafe-key-not-a-credential';

export interface FakeQuestion {
  type: 'choice' | 'noul' | 'score';
  instructions: string;
  criteria?: Record<string, string>;
}

export interface FakeRequest {
  model: string;
  state: string;
  questions: Record<string, FakeQuestion>;
  authorization: string | null;
}

export type FakeAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities?: Record<string, number> }
  | { type: 'noul'; noul: number };

/** Return answers keyed by question name, or a Response to send verbatim. */
export type FakeResponder = (req: FakeRequest) => Record<string, FakeAnswer> | Response;

export interface FakeTypeSafe {
  readonly calls: FakeRequest[];
  respond(responder: FakeResponder): void;
  /** Answer every choice question with its first criterion at `confidence`, every noul with `noul`. */
  answerAll(opts?: { confidence?: number; noul?: number; pick?: (name: string, q: FakeQuestion) => string }): void;
  readonly fetch: ReturnType<typeof vi.fn>;
}

export function choice(label: string, confidence: number): FakeAnswer {
  return { type: 'choice', choice: label, confidence, probabilities: { [label]: confidence } };
}

export function noul(p: number): FakeAnswer {
  return { type: 'noul', noul: p };
}

export function installFakeTypeSafe(): FakeTypeSafe {
  const calls: FakeRequest[] = [];
  let responder: FakeResponder = () => ({});
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== FAKE_TYPESAFE_ENDPOINT) return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}')) as Omit<FakeRequest, 'authorization'>;
    const req: FakeRequest = { ...body, authorization: new Headers(init?.headers).get('authorization') };
    calls.push(req);
    const out = responder(req);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({
      model: 'jev-fake-1.0',
      answers: out,
      usage: { input_tokens: 400 + req.state.length, output_tokens: 20 * Object.keys(out).length },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetch: fetchMock,
    respond(r) {
      responder = r;
    },
    answerAll(opts = {}) {
      responder = (req) => {
        const answers: Record<string, FakeAnswer> = {};
        for (const [name, q] of Object.entries(req.questions)) {
          if (q.type === 'noul') answers[name] = noul(opts.noul ?? 0.9);
          else answers[name] = choice(opts.pick?.(name, q) ?? Object.keys(q.criteria ?? {})[0] ?? 'x', opts.confidence ?? 0.95);
        }
        return answers;
      };
    },
  };
}
