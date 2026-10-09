import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { withFolderIo } from './folder-io.js';
import type { OutcomeOperation, OutcomeOperationResult } from './outcomes-api-types.js';
import type { OutcomeTaskContextRequest, OutcomeTaskContextResult } from './outcome-task-context.js';

function workerEntrypoint(): URL {
  if (new URL(import.meta.url).pathname.endsWith('/outcomes-io.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./outcomes-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./outcomes-worker.js', import.meta.url);
}

/** Existing folder-IO admission bounds metadata threads, not fleet work. Each
 * worker is terminated after its single result, including failures/timeouts.
 * Retrying an uncertain write must retain its command ID for durable replay. */
function runMetadataOperation<T>(operation: OutcomeOperation | { kind: 'task-context'; input: OutcomeTaskContextRequest }): Promise<T> {
  return withFolderIo(() => new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerEntrypoint(), { workerData: operation, execArgv: [] });
    let settled = false;
    const finish = (value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => {
        if (value) resolve(value);
        else reject(new Error('Outcome records are unavailable. Refresh and retry with the same command.'));
      }, () => reject(new Error('Outcome metadata worker could not stop.')));
    };
    const timer = setTimeout(() => finish(), 60_000);
    worker.once('message', (message: unknown) => {
      const result = message as { ok?: boolean; value?: T } | null;
      finish(result?.ok === true ? result.value : undefined);
    });
    worker.once('error', () => finish());
    worker.once('exit', () => finish());
  }));
}

export function runOutcomeOperation(operation: OutcomeOperation): Promise<OutcomeOperationResult> {
  return runMetadataOperation(operation);
}
/** Reuse metadata workers so protected-folder reads never block the desktop HTTP loop. */
export function runOutcomeTaskContext(input: OutcomeTaskContextRequest): Promise<OutcomeTaskContextResult> {
  return runMetadataOperation({ kind: 'task-context', input });
}
