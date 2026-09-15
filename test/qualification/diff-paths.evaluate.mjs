import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_NAMES, CASE_MESSAGES } from './diff-paths-cases.mjs';

const TARGET = 'src/web-ui/routes/inbox/diff-parser.ts';
const ROOT = dirname(fileURLToPath(import.meta.url));
const diagnostic = (code, message) => ({ code, message, path: TARGET, line: 1 });
const invalid = () => ({ passed: false, score: 0,
  metrics: { cases: CASE_NAMES.length, passedCases: 0, failedCases: CASE_NAMES.length, invalidExecution: 1, evaluatorPid: process.pid },
  diagnostics: [diagnostic('DIFF_PATHS_INVALID_EXECUTION', 'The parser probe did not produce valid bounded execution evidence')] });
let result = invalid();
try {
  const root = process.env.ASHLR_UNIVERSE_CANDIDATE;
  if (typeof root !== 'string' || !isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Invalid root');
  const target = join(root, TARGET);
  if (realpathSync(target) !== target || !lstatSync(target).isFile() || lstatSync(target).size > 64 * 1024) throw new Error('Invalid target');
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'diff-paths-cases.mjs'), target], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024,
    env: { PATH: process.env.PATH ?? '', NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  if (child.error || child.status !== 0 || child.signal !== null || child.stderr !== '' || child.stdout.trim().split('\n').length !== 1) throw new Error('Invalid probe');
  const raw = JSON.parse(child.stdout);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'cases,schemaVersion' ||
      raw.schemaVersion !== 1 || !Array.isArray(raw.cases) || raw.cases.length !== CASE_NAMES.length ||
      !raw.cases.every(value => typeof value === 'boolean')) throw new Error('Invalid evidence');
  const passedCases = raw.cases.filter(Boolean).length;
  result = { passed: passedCases === CASE_NAMES.length, score: passedCases,
    metrics: { cases: CASE_NAMES.length, passedCases, failedCases: CASE_NAMES.length - passedCases, invalidExecution: 0, evaluatorPid: process.pid },
    diagnostics: raw.cases.flatMap((passed, index) => passed ? [] : [diagnostic(`DIFF_PATHS_${index + 1}`, CASE_MESSAGES[index])]) };
} catch { /* Fixed failure evidence only; never disclose loader output or host paths. */ }
process.stdout.write(`${JSON.stringify(result)}\n`);
