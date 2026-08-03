import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MANIFEST_NAME = 'ashlr-m93-launchd-cleanup.json';
const COMMAND_TIMEOUT_MS = 15_000;

function launchctl(args) {
  return spawnSync('launchctl', args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function absent(result) {
  return result.status !== 0
    && !result.error
    && /(?:could not find (?:specified )?service|service .* not found|no such process)/i
      .test(`${result.stdout}\n${result.stderr}`);
}

function below(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path !== ''
    && path !== '..'
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}

function exactRuntime(output, serviceTarget, manifest) {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines[0] !== `${serviceTarget} = {` || lines.at(-1)?.trim() !== '}') return false;
  const values = (field) => {
    const prefix = `\t${field} = `;
    return lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length).trim());
  };
  const blocks = lines
    .map((line, index) => line === '\targuments = {' ? index : -1)
    .filter((index) => index >= 0);
  if (blocks.length !== 1) return false;
  const start = blocks[0];
  const end = lines.indexOf('\t}', start + 1);
  if (end < 0) return false;
  const argumentsValue = lines.slice(start + 1, end);
  return values('path').length === 1
    && values('path')[0] === manifest.plistPath
    && values('program').length === 1
    && values('program')[0] === manifest.program
    && argumentsValue.every((line) => line.startsWith('\t\t'))
    && JSON.stringify(argumentsValue.map((line) => line.slice(2)))
      === JSON.stringify(manifest.arguments);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function main() {
  if (process.platform !== 'darwin') return;
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('RUNNER_TEMP is required for launchd cleanup');
  const manifestPath = resolve(runnerTemp, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return;

  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (
    raw !== JSON.stringify(manifest)
    || JSON.stringify(Object.keys(manifest).sort())
      !== JSON.stringify(['arguments', 'label', 'plistPath', 'program', 'schemaVersion', 'scratch'])
    || manifest.schemaVersion !== 1
    || typeof manifest.label !== 'string'
    || !/^ai\.ashlr\.m93\.[a-f0-9]{32}$/.test(manifest.label)
    || typeof manifest.scratch !== 'string'
    || typeof manifest.plistPath !== 'string'
    || typeof manifest.program !== 'string'
    || !Array.isArray(manifest.arguments)
    || manifest.arguments.length === 0
    || manifest.arguments.some((argument) => typeof argument !== 'string')
    || !below(runnerTemp, manifest.scratch)
    || !below(manifest.scratch, manifest.plistPath)
  ) {
    throw new Error(`refusing malformed native launchd cleanup manifest at ${manifestPath}`);
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${manifest.label}`;
  let state = launchctl(['print', serviceTarget]);
  if (!absent(state)) {
    if (
      state.status !== 0
      || state.error
      || state.stderr.trim() !== ''
      || !exactRuntime(state.stdout, serviceTarget, manifest)
    ) {
      throw new Error(`refusing cleanup without exact fixture ownership: ${state.stderr || state.stdout}`);
    }
    launchctl(['bootout', domainTarget, manifest.plistPath]);
    state = launchctl(['print', serviceTarget]);
    for (let attempt = 0; attempt < 50 && !absent(state); attempt++) {
      sleep(100);
      state = launchctl(['print', serviceTarget]);
    }
  }
  if (!absent(state)) {
    throw new Error(`cleanup could not prove ${serviceTarget} absent: ${state.stderr || state.stdout}`);
  }
  rmSync(manifest.scratch, { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
