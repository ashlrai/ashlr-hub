import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeReleaseDependencyInventory } from '../dist/core/daemon/runtime-release-dependency-inventory.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(repositoryRoot, 'dist', 'release-dependency-inventory.json');
const packed = spawnSync(
  'npm',
  ['pack', '--dry-run', '--ignore-scripts', '--json'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
if (packed.status !== 0) {
  process.stderr.write(`release dependency inventory npm pack: ${packed.stderr.trim()}\n`);
  process.exitCode = 1;
} else {
  let packagedFiles;
  try {
    const report = JSON.parse(packed.stdout);
    packagedFiles = report[0]?.files?.map((entry) => entry.path);
    if (!Array.isArray(packagedFiles)) throw new Error('npm pack file report is missing');
  } catch (error) {
    process.stderr.write(`release dependency inventory npm pack: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (packagedFiles) {
    const built = buildRuntimeReleaseDependencyInventory(repositoryRoot, { packagedFiles });
    if (!built.ok) {
      process.stderr.write(`release dependency inventory: ${built.reason}\n`);
      process.exitCode = 1;
    } else {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, built.canonicalJson, { encoding: 'utf8', mode: 0o644 });
    }
  }
}
