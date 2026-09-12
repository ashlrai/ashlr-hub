/** Typed test access to the exact shipped interceptor; native results remain unchanged. */
import type { runVerifySubprocessAsync } from '../../src/core/run/verify-commands.js';

export interface PreparationMutationRequest {
  readonly schemaVersion: 1; readonly id: number; readonly nonce: string;
  readonly api: 'execFileSync' | 'spawnSync'; readonly file: string; readonly args: readonly string[];
  readonly options: Readonly<{ cwd: string | null; encoding: 'utf8' | 'buffer'; timeoutMs: number; maxBuffer: number; inputBase64: string | null }>;
}
interface InterceptorOptions {
  run: typeof runVerifySubprocessAsync; toolPath: string; fixtureRoot: string;
  matches(request: PreparationMutationRequest): boolean; mutate(): void;
}
interface Interceptor {
  run: typeof runVerifySubprocessAsync; arm(): void; assertInjected(): void; injections(): number;
}
const controller = await import(new URL('../../scripts/evaluators/preparation-verification-controller.mjs', import.meta.url).href) as {
  createPreparationMutationInterceptor(options: InterceptorOptions): Interceptor;
};
export const createPreparationMutationInterceptor = controller.createPreparationMutationInterceptor;
