import { AgentsReadClient } from '../core/openai-agents/client.js';
import { AgentsReadError, validResourceId } from '../core/openai-agents/contracts.js';

const HELP = `ashlr openai-agents — read-only managed OpenAI Agents API inventory

  ashlr openai-agents sessions [--limit 1..100] [--after <session-id>] [--json]
  ashlr openai-agents inspect <session-id> [--json]
  ashlr openai-agents turns <session-id> [--limit 1..100] [--after <turn-id>] [--json]

Reads one bounded page; hasMore/nextCursor disclose remaining inventory.
Uses host-held OPENAI_API_KEY only when a read executes. Configure it through your existing
secure environment/provider setup; never put a key in command arguments or chat.
API billing/access is separate from Codex or ChatGPT subscriptions. A successful read does
not qualify a fleet seat. No create, input, steering, cancellation, files or event streaming.`;

export interface AgentsCliDeps {
  client: Pick<AgentsReadClient, 'listSessions' | 'inspectSession' | 'listTurns'>;
  out: (text: string) => void;
  err: (text: string) => void;
}
const ERROR_GUIDANCE: Record<AgentsReadError['code'], string> = {
  'missing-auth': 'Configure host-held OPENAI_API_KEY through your secure environment/provider setup. API access is separate from subscription access; do not paste a key into chat.',
  'invalid-argument': 'Use a resource ID and a page limit from 1 to 100.',
  'invalid-response': 'The API returned metadata outside the supported contract; no readiness was inferred.',
  'response-too-large': 'The response exceeded the 2 MiB metadata bound. Request a smaller page.',
  timeout: 'The read exceeded 15 seconds. No session mutation was requested.',
  transport: 'The official API read failed. Check your network and API access.',
  authentication: 'API authentication failed. Check your host-held key in your secure provider setup.',
  permission: 'API permission was refused. Check project access to the Agents API.',
  'not-found': 'The requested API resource is unavailable for this project.',
  'rate-limit': 'The API refused the read due to a rate limit. Retry later.',
  'provider-error': 'The API read failed. Provider response text was withheld.',
};

/** Help/invalid arguments never read credentials or invoke transport. */
export async function runOpenaiAgentsCli(args: string[], deps?: AgentsCliDeps): Promise<number> {
  const out = deps?.out ?? console.log, err = deps?.err ?? console.error;
  if (!args.length || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]))) { out(HELP); return 0; }
  const [command, ...rest] = args;
  const json = rest.includes('--json');
  const rejectUsage = (): number => { err(json ? JSON.stringify({ error: 'invalid-argument' }) : HELP); return 2; };
  if (!['sessions', 'inspect', 'turns'].includes(command)) return rejectUsage();
  let sessionId: string | undefined;
  const page: { limit?: number; after?: string } = {};
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') { if (seen.has(arg)) return rejectUsage(); seen.add(arg); continue; }
    if (arg === '--limit' || arg === '--after') {
      if (command === 'inspect' || seen.has(arg)) return rejectUsage();
      seen.add(arg);
      const value = rest[++i];
      if (arg === '--limit') {
        if (!value || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) return rejectUsage();
        page.limit = Number(value);
      } else { if (!validResourceId(value)) return rejectUsage(); page.after = value; }
      continue;
    }
    if (command === 'sessions' || sessionId || !validResourceId(arg)) return rejectUsage();
    sessionId = arg;
  }
  if (command !== 'sessions' && !sessionId) return rejectUsage();
  const client = deps?.client ?? new AgentsReadClient({ readApiKey: () => process.env.OPENAI_API_KEY });
  try {
    const result = command === 'sessions' ? await client.listSessions(page)
      : command === 'inspect' ? await client.inspectSession(sessionId!) : await client.listTurns(sessionId!, page);
    out(JSON.stringify({ readOnly: true, executionQualified: false, result }, null, json ? undefined : 2));
    return 0;
  } catch (error) {
    const code = error instanceof AgentsReadError ? error.code : 'transport';
    err(json ? JSON.stringify({ error: code, guidance: ERROR_GUIDANCE[code] }) : ERROR_GUIDANCE[code]);
    return 1;
  }
}
