import { AgentsReadError, metadataPage, sessionMetadata, turnMetadata, validResourceId } from './contracts.js';

const ORIGIN = 'https://api.openai.com';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
export interface AgentsReadClientOptions {
  /** Called only when an explicit read command executes. Never persisted or passed to a sandbox. */
  readApiKey: () => string | undefined;
  fetch?: typeof fetch;
}
export interface ReadPageOptions { limit?: number; after?: string }

/** Fixed-host GET-only client. One page per call; no automatic pagination or mutation methods. */
export class AgentsReadClient {
  constructor(private readonly options: AgentsReadClientOptions) {}
  private pageQuery(options: ReadPageOptions): URLSearchParams {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.after !== undefined && !validResourceId(options.after))) {
      throw new AgentsReadError('invalid-argument');
    }
    const query = new URLSearchParams({ limit: String(limit), order: 'desc' });
    if (options.after) query.set('after', options.after);
    return query;
  }
  private sessionPath(sessionId: string): string {
    if (!validResourceId(sessionId)) throw new AgentsReadError('invalid-argument');
    return `/v1/agents/sessions/${sessionId}`;
  }
  async listSessions(options: ReadPageOptions = {}) {
    const query = this.pageQuery(options);
    return this.read(`/v1/agents/sessions?${query}`, value => metadataPage(value, Number(query.get('limit')), sessionMetadata));
  }
  async inspectSession(sessionId: string) {
    const path = this.sessionPath(sessionId);
    return this.read(path, value => {
      const session = sessionMetadata(value);
      if (session.id !== sessionId) throw new AgentsReadError('invalid-response');
      return session;
    });
  }
  async listTurns(sessionId: string, options: ReadPageOptions = {}) {
    const path = this.sessionPath(sessionId), query = this.pageQuery(options);
    return this.read(`${path}/turns?${query}`, value => metadataPage(value, Number(query.get('limit')), item => turnMetadata(item, sessionId)));
  }
  private async read<T>(path: string, project: (value: unknown) => T): Promise<T> {
    let key: string | undefined;
    try { key = this.options.readApiKey(); } catch { throw new AgentsReadError('missing-auth'); }
    if (!key || !key.trim()) throw new AgentsReadError('missing-auth');
    if (key.length > 8192 || /[\r\n]/.test(key)) throw new AgentsReadError('authentication');
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new AgentsReadError('timeout')); }, TIMEOUT_MS);
    });
    const request = async (): Promise<T> => {
      const response = await (this.options.fetch ?? globalThis.fetch)(`${ORIGIN}${path}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'OpenAI-Beta': 'agents=v1', Accept: 'application/json' },
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new AgentsReadError('timeout');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code = response.status === 401 ? 'authentication' : response.status === 403 ? 'permission' : response.status === 404 ? 'not-found' : response.status === 429 ? 'rate-limit' : 'provider-error';
        throw new AgentsReadError(code);
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
        await response.body?.cancel().catch(() => {});
        throw new AgentsReadError('response-too-large');
      }
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel().catch(() => {});
        throw new AgentsReadError('invalid-response');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw new AgentsReadError('response-too-large');
        chunks.push(chunk.value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw new AgentsReadError('invalid-response'); }
      const result = project(parsed);
      // A compromised or mistaken upstream must not echo the actual authentication value into output.
      if (JSON.stringify(result).includes(key!)) throw new AgentsReadError('invalid-response');
      return result;
    };
    try { return await Promise.race([request(), timeout]); }
    catch (error) { throw error instanceof AgentsReadError ? error : new AgentsReadError('transport'); }
    finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
}
