/** Private per-job environment. Never overlays the daemon's process.env. */
import { AsyncLocalStorage } from 'node:async_hooks';

interface JobContext {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly validate?: () => void;
  active: boolean;
}
const jobs = new AsyncLocalStorage<JobContext>();
const CONFIG_IDENTITY = new Set([
  'HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'GH_CONFIG_DIR', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_PROJECT_ID',
  'SUPABASE_PROJECT_REF', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID',
]);
const credentialKey = /(?:^|_)(?:API_KEY|SECRET|TOKEN|KEY|PAT|PASSWORD|PASSWD|CREDS?|CREDENTIALS?|AUTH_SOCK)(?:_|$)/i;
const controlledKey = (key: string): boolean => key.toUpperCase().startsWith('LOCUS_') || CONFIG_IDENTITY.has(key.toUpperCase());

/** Captures a frozen snapshot; delegated executor authority remains private to this job. */
export async function runInLocusJobEnv<T>(
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T> | T,
  validate?: () => void,
): Promise<T> {
  const snapshot = { ...env };
  for (const key of Object.keys(snapshot)) {
    if (key.toUpperCase() === 'LOCUS_CONTROL_CAPABILITY') delete snapshot[key];
  }
  const context: JobContext = { env: Object.freeze(snapshot), validate, active: true };
  return jobs.run(context, async () => {
    try {
      assertLocusJobDispatch();
      return await fn();
    } finally {
      context.active = false;
    }
  });
}

/** Whether dispatch is inside a delegated job rather than an ambient provider context. */
export function hasLocusJobEnv(): boolean {
  return jobs.getStore() !== undefined;
}

/** Child processes lose ALS. Inherited delegation must be captured and verified before effects. */
export function hasInheritedLocusSession(): boolean {
  return process.env.LOCUS_SESSION_ID !== undefined ||
    process.env.LOCUS_EXECUTOR_CAPABILITY !== undefined;
}

/** Read-only private snapshot for gates and child builders; never log or expose to a model. */
export function getLocusJobEnv(): Readonly<NodeJS.ProcessEnv> {
  return jobs.getStore()?.env ?? process.env;
}

/** Recheck live authority at dispatch, including work delayed by unrelated awaits. */
export function assertLocusJobDispatch(): void {
  const context = jobs.getStore();
  if (!context) {
    if (hasInheritedLocusSession()) {
      throw new Error('Inherited Locus session requires live verification before dispatch');
    }
    return;
  }
  if (!context.active) throw new Error('Locus job has ended; refusing delayed dispatch');
  const result: unknown = context.validate?.();
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error('Locus job dispatch validator must be synchronous');
  }
}

/**
 * A captured job is the baseline, rather than the ambient daemon environment.
 * Containment/runtime additions are allowed; identity changes fail closed and
 * uncaptured credential-shaped additions are omitted. Control authority is never
 * delegated. Executor authority is preserved for sealed Locus child operations.
 */
export function withLocusJobChildEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  assertLocusJobDispatch();
  const context = jobs.getStore();
  const result: NodeJS.ProcessEnv = { ...(context?.env ?? base ?? process.env) };
  if (context && base) {
    for (const [key, value] of Object.entries(base)) {
      if (key.toUpperCase() === 'LOCUS_CONTROL_CAPABILITY') continue;
      if (controlledKey(key)) {
        if (value !== undefined && value !== (context.env[key] ?? context.env[key.toUpperCase()])) {
          throw new Error('Locus job child environment identity override refused');
        }
        continue;
      }
      if (credentialKey.test(key) && value !== context.env[key]) continue;
      result[key] = value;
    }
  }
  for (const key of Object.keys(result)) {
    const normalized = key.toUpperCase();
    if (normalized === 'LOCUS_CONTROL_CAPABILITY' || (context &&
      (normalized === 'ASHLR_CONFIG' || normalized === 'ASHLR_GENOME_DIR'))) delete result[key];
  }
  return result;
}
