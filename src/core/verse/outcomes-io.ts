import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { withFolderIo } from './folder-io.js';
import type { OutcomeOperation, OutcomeOperationResult } from './outcomes-api-types.js';

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
export function runOutcomeOperation(operation: OutcomeOperation): Promise<OutcomeOperationResult> {
  return withFolderIo(() => new Promise<OutcomeOperationResult>((resolve, reject) => {
    const worker = new Worker(workerEntrypoint(), { workerData: operation, execArgv: [] });
    let settled = false;
    const finish = (value?: OutcomeOperationResult): void => {
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
      const result = message as { ok?: boolean; value?: OutcomeOperationResult } | null;
      finish(result?.ok === true ? result.value : undefined);
    });
    worker.once('error', () => finish());
    worker.once('exit', () => finish());
  }));
}
