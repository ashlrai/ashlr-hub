// Temporary local visual acceptance, never an execution/metadata collector launch.
import console from 'node:console';
import process from 'node:process';
import { constants, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { inspectPrivateDirectory } from '../../dist/core/universe/artifacts.js';
import { startResourceConsoleServer } from '../../dist/core/web/resource-console-server.js';

const [root, poolFile, bindingsFile, observationsFile, startupFile] = process.argv.slice(2);
if (process.argv.length !== 7 || ![root, poolFile, bindingsFile, observationsFile, startupFile].every(path => isAbsolute(path))) {
  throw new Error('Five explicit absolute preview paths required');
}
inspectPrivateDirectory(dirname(startupFile));
// Reserve the private output before constructing a server; no existing file is overwritten.
const fd = openSync(startupFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
let handle;
try {
  handle = await startResourceConsoleServer({ root, poolFile, bindingsFile, observationsFile, port: 0 });
  writeFileSync(fd, JSON.stringify({ url: handle.consoleUrl, readToken: handle.readToken }) + '\n'); fsyncSync(fd);
} catch {
  await handle?.close(); throw new Error('Inspection preview unavailable; preserve private startup evidence');
} finally { closeSync(fd); }
console.log(JSON.stringify({ url: handle.consoleUrl, readOnly: handle.scope.readOnly, hasControlToken: handle.controlToken !== null }));
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  try { await handle.close(); console.log('Inspection preview closed'); }
  catch { process.exitCode = 1; console.error('Inspection preview cleanup unavailable'); }
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
