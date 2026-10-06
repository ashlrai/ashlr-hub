/* global process, console */
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
export function bindSource({ root, candidate, eventSha, runGit } = {}) {
  if (!shaPattern.test(candidate) || !shaPattern.test(eventSha)) throw new Error('Invalid candidate or event revision');
  const git = runGit ?? ((args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim());
  if (git(['rev-parse', 'HEAD']) !== candidate) throw new Error('Checkout is not the candidate revision');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Source checkout is dirty');
  if (candidate !== eventSha) git(['fetch', '--no-tags', 'origin', eventSha]);
  const tree = git(['rev-parse', `${candidate}^{tree}`]);
  if (!shaPattern.test(tree) || git(['rev-parse', `${eventSha}^{tree}`]) !== tree) {
    throw new Error('Candidate tree differs from the original GitHub event tree');
  }
  return { revision: candidate, tree, eventSha };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = bindSource({ root: process.cwd(), candidate: process.env.ASHLR_CANDIDATE_SHA, eventSha: process.env.GITHUB_SHA });
    if (!process.env.GITHUB_ENV) throw new Error('Missing GitHub environment output');
    appendFileSync(process.env.GITHUB_ENV, `ASHLR_CI_SOURCE_SHA=${source.revision}\nASHLR_CI_EVENT_SHA=${source.eventSha}\n`);
    console.log(`Bound candidate ${source.revision} to event tree ${source.tree}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
