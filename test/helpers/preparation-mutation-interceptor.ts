/** Test-only mutation seam. Native results and controller counters remain untouched.
 * Injection work is trusted fixture setup, never a candidate performance sample. */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { runVerifySubprocessAsync, VerifySubprocessResult } from '../../src/core/run/verify-commands.js';

export interface PreparationMutationRequest {
  readonly schemaVersion: 1;
  readonly id: number;
  readonly nonce: string;
  readonly api: 'execFileSync' | 'spawnSync';
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Readonly<{ cwd: string | null; encoding: 'utf8' | 'buffer'; timeoutMs: number; maxBuffer: number; inputBase64: string | null }>;
}
const { readonlyCommand } = await import(new URL('../../scripts/evaluators/preparation-verification-controller.mjs', import.meta.url).href) as {
  readonlyCommand(request: unknown, fixture: string, scratch: string): unknown;
};
const { exact, MAX_MESSAGE_BYTES } = await import(new URL('../../scripts/evaluators/preparation-verification-protocol.mjs', import.meta.url).href) as {
  exact(value: unknown, keys: string[]): boolean; MAX_MESSAGE_BYTES: number;
};
const message = 'PREPARATION_MUTATION_INTERCEPTOR_FAILED';
function privateDirectory(value: string): void {
  if (!isAbsolute(value) || resolve(value) !== value || realpathSync(value) !== value) throw new Error(message);
  const stat = lstatSync(value);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(message);
}
function json(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error(message);
  return JSON.parse(text) as Record<string, unknown>;
}
function success(result: VerifySubprocessResult): void {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut !== false || result.cancelled !== false ||
      result.error !== undefined || result.outputTruncated !== undefined || result.stderr !== '' ||
      result.processGroupSettlement !== 'group-exit-confirmed') throw new Error(message);
  const output = json(result.stdout);
  if (!exact(output, ['started', 'status', 'signal', 'stdoutBase64', 'stderrBase64', 'error']) || output.started !== true ||
      output.status !== 0 || output.signal !== null || output.error !== null) throw new Error(message);
  for (const key of ['stdoutBase64', 'stderrBase64']) {
    const value = output[key];
    if (typeof value !== 'string' || value.length > MAX_MESSAGE_BYTES) throw new Error(message);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > 64 * 1024 || bytes.toString('base64') !== value) throw new Error(message);
  }
}

export function createPreparationMutationInterceptor(options: {
  run: typeof runVerifySubprocessAsync; toolPath: string; fixtureRoot: string;
  matches(request: PreparationMutationRequest): boolean; mutate(): void;
}) {
  const { run, toolPath, fixtureRoot, matches, mutate } = options;
  privateDirectory(fixtureRoot);
  if (typeof run !== 'function' || typeof matches !== 'function' || typeof mutate !== 'function' || !isAbsolute(toolPath) ||
      resolve(toolPath) !== toolPath || realpathSync(toolPath) !== toolPath || !lstatSync(toolPath).isFile()) throw new Error(message);
  let armed = false, fired = false, count = 0, fault = false, pending = false, lastId = 0;
  let scratchPin: string | undefined;
  const nonces = new Set<string>();
  function fail(): never { fault = true; throw new Error(message); }
  const wrapped: typeof runVerifySubprocessAsync = async (argv, opts) => {
    // Candidate lifecycle and other non-tool calls pass through verbatim, even
    // during fault cleanup. Never make settlement depend on a working injector.
    if (!argv.includes(toolPath)) return run(argv, opts);
    if (fault || pending) return fail();
    pending = true;
    try {
      if (argv.length !== 6 || argv[0] !== '/usr/bin/sandbox-exec' || argv[1] !== '-p' ||
          typeof argv[2] !== 'string' || argv[3] !== process.execPath || argv[4] !== '--no-addons' || argv[5] !== toolPath) fail();
      const input = json(opts.input);
      if (!exact(input, ['request', 'fixtureRoot', 'scratch']) || input.fixtureRoot !== fixtureRoot || input.scratch !== opts.cwd) fail();
      privateDirectory(opts.cwd); if (scratchPin !== undefined && scratchPin !== opts.cwd) fail(); scratchPin = opts.cwd;
      readonlyCommand(input.request, fixtureRoot, opts.cwd);
      const request = input.request as PreparationMutationRequest;
      if (request.id !== lastId + 1 || request.id > 4096 || nonces.has(request.nonce)) fail();
      lastId = request.id; nonces.add(request.nonce);
      Object.freeze(request.args); Object.freeze(request.options); Object.freeze(request);
      const selected = armed && !fired ? matches(request) : false;
      if (typeof selected !== 'boolean') fail();
      const result = await run(argv, opts);
      if (selected) {
        success(result); fired = true;
        // Async callbacks could mutate after the controller resumes. Only an
        // exactly void synchronous callback may complete an injection.
        const returned: unknown = mutate(); if (returned !== undefined) fail();
        count++;
      }
      return result;
    } catch { return fail(); }
    finally { pending = false; }
  };
  return {
    run: wrapped,
    arm(): void { if (fault || armed || pending) fail(); armed = true; },
    assertInjected(): void { if (fault || !armed || pending || count !== 1) fail(); },
    injections(): number { return count; },
  };
}
