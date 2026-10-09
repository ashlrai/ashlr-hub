/** Role capability is separate from account authority and model quality.
 * A qualified worker adapter can also execute a Manager stage. Grant, exact
 * account/model admission, billing and execution leases remain the caller's
 * existing lifecycle; a tier label never grants those permissions. */
import type { AshlrConfig } from '../types.js';
import { resolveEngineSpec } from './engine-registry.js';

/** Source-owned implementations, not an arbitrary configurable CLI label. */
export function supportsRoleExecution(engine: string, cfg: AshlrConfig): boolean {
  const spec = resolveEngineSpec(engine, cfg);
  if (!spec) return false;
  if (spec.kind === 'cli-agent') {
    return ['claude', 'codex', 'grok-cli', 'devin-cli'].includes(engine);
  }
  // These runtimes enter the existing tool-capable local API-model runner.
  // A generic remote OpenAI-compatible endpoint is not a qualified free lane.
  return spec.kind === 'api-model' && ['local-coder', 'llama-server'].includes(engine);
}
