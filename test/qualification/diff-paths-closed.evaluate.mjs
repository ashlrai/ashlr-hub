// Fixed host evaluator: behavior AND closed compiler AND fixed lint. This file,
// its two checker assets and behavioral tests are protected in the seed commit.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClosedTypecheckCandidate, withClosedAcceptance } from './closed-source/closed-typecheck.mjs';

let result = { passed: false, score: 0, metrics: { invalidExecution: 1 },
  diagnostics: [{ code: 'CLOSED_EVALUATION_UNAVAILABLE', message: 'Protected acceptance evidence is unavailable.' }] };
try {
  const checked = checkClosedTypecheckCandidate();
  const behavior = spawnSync(process.execPath, ['--max-old-space-size=256', '--disable-warning=ExperimentalWarning',
    join(dirname(fileURLToPath(import.meta.url)), 'diff-paths.evaluate.mjs')], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', ASHLR_UNIVERSE_CANDIDATE: process.env.ASHLR_UNIVERSE_CANDIDATE,
      NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  if (behavior.error || behavior.status !== 0 || behavior.signal !== null || behavior.stderr !== '' ||
      behavior.stdout.trim().split('\n').length !== 1) throw new Error('Protected behavioral evidence unavailable');
  result = withClosedAcceptance(JSON.parse(behavior.stdout), checked);
} catch { /* Share no candidate output or host diagnostics on failure. */ }
process.stdout.write(JSON.stringify(result) + '\n');
