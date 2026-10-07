import type { Writable } from 'node:stream';
import { getDesktopUpdateTrust } from '../core/desktop/update-trust.js';
import { applyQualifiedDesktopUpdate, createDesktopUpdateDependencies, inspectQualifiedDesktopUpdate, readQualifiedDesktopUpdateResult,
  type DesktopUpdateDependencies, type DesktopUpdateResult } from '../core/desktop/qualified-update.js';

const USAGE = `usage: phm desktop-update inspect|apply --stage <32 lowercase hex> --json

Inspect a publisher-signed paired app/CLI stage or apply it after normal native
exit, prior Stop/drain and a fresh equal-surface grant. No URL, path, shell,
credential operation, Stop release or resident restart is accepted.
Changed authority requires the existing manual update and approval flow.
`;
export function parseDesktopUpdateArgs(args: string[]): {verb: 'inspect'|'apply'; stage: string} | null {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) return null;
  if (args.length !== 4 || !['inspect', 'apply'].includes(args[0]!) || args[1] !== '--stage' ||
      !/^[a-f0-9]{32}$/.test(args[2]!) || args[3] !== '--json') throw new Error('Invalid desktop-update arguments');
  return {verb: args[0] as 'inspect'|'apply', stage: args[2]!};
}
const closedOutput = (error: unknown) => ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes((error as NodeJS.ErrnoException)?.code ?? '');
/** Only the native-update JSON channel owns this listener; no global IO errors are ignored. */
export function desktopUpdateJsonWriter(stream: Writable) {
  let failed: Error | null = null;
  const onError = (error: Error) => {failed = error;};
  stream.on('error', onError);
  return {
    write: async (value: DesktopUpdateResult): Promise<void> => {
      if (failed) throw failed;
      await new Promise<void>((resolve, reject) => stream.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
    },
    dispose: async (): Promise<void> => {
      // Node may notify the stream error immediately after its write callback.
      await new Promise<void>(resolve => setImmediate(resolve));
      stream.removeListener('error', onError);
    },
  };
}
export async function cmdDesktopUpdate(args: string[], dependencies?: DesktopUpdateDependencies,
  emit?: (value: DesktopUpdateResult) => void | Promise<void>): Promise<number> {
  let options: ReturnType<typeof parseDesktopUpdateArgs>;
  try {options = parseDesktopUpdateArgs(args);} catch {console.error(USAGE); return 2;}
  if (!options) {console.log(USAGE); return 0;}
  const deps = dependencies ?? createDesktopUpdateDependencies(getDesktopUpdateTrust());
  const writer = emit ? null : desktopUpdateJsonWriter(process.stdout);
  const output = emit ?? writer!.write;
  try {
    let observed: DesktopUpdateResult;
    if (options.verb === 'inspect') {
      observed = inspectQualifiedDesktopUpdate(options.stage, deps);
      if (observed.reason === 'update-attempt-already-recorded') observed = await readQualifiedDesktopUpdateResult(options.stage, deps);
    } else observed = await applyQualifiedDesktopUpdate(options.stage, deps, undefined, output);
    // Apply already fsynced its durable result. Normal native exit closes this
    // pipe; that expected output failure must not erase a completed transaction.
    try {await output(observed);} catch (error) {
      if (!closedOutput(error)) {console.error('Desktop update result channel failed.'); return 1;}
    }
    return observed.state === 'ready' || observed.state === 'applied' ? 0 : 1;
  } finally {await writer?.dispose();}
}
