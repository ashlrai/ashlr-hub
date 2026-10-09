import { configureReleaseArticles, defaultReleaseArticlesDeps, importProposedRelease, readReleaseArticles, syncReleaseArticles, type ReleaseArticlesDeps } from '../core/release-articles.js';
import { readPrivateFileCapped } from '../core/verse/preferences.js';
import { verifyLatestWorkbenchRelease } from '../core/release-public-facts.js';

export const RELEASE_ARTICLES_USAGE = 'phm release-articles status | metadata | enable [ashlrai/ashlr-hub|ashlrai/phantom] | disable | import <proposed.json> | sync [version] [--json]';
export async function runReleaseArticlesCli(args: string[], deps: ReleaseArticlesDeps, print: (text: string) => void, signal?: AbortSignal): Promise<number> {
  const json = args.includes('--json'); const argv = args.filter((arg) => arg !== '--json');
  try {
    let result;
    if (argv.length === 1 && argv[0] === 'status') result = readReleaseArticles();
    else if (argv.length === 1 && argv[0] === 'metadata') result = await verifyLatestWorkbenchRelease(deps.reader, deps.now(), signal);
    else if (argv.length <= 2 && argv[0] === 'enable') {
      const repository = argv[1];
      if (repository !== undefined && repository !== 'ashlrai/ashlr-hub' && repository !== 'ashlrai/phantom') throw new Error('Invalid release repository');
      result = configureReleaseArticles(true, repository);
    } else if (argv.length === 1 && argv[0] === 'disable') result = configureReleaseArticles(false);
    else if (argv.length === 2 && argv[0] === 'import') {
      const read = readPrivateFileCapped(argv[1]!, 4096);
      if (!read || read.truncated) throw new Error('Proposed release file unavailable');
      result = importProposedRelease(JSON.parse(read.text) as unknown);
    } else if (argv.length <= 2 && argv[0] === 'sync') result = await syncReleaseArticles(deps, signal, argv[1]);
    else { print(RELEASE_ARTICLES_USAGE); return 2; }
    print(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch {
    print(json ? JSON.stringify({ ok: false, reason: 'Release article operation withheld; inspect configuration and public verification.' }) :
      'Release article operation withheld. Configuration or public verification is unavailable; no publication was performed.');
    return 1;
  }
}
export async function cmdReleaseArticles(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(RELEASE_ARTICLES_USAGE + '\n'); return 0; }
  const controller = new AbortController(); const stop = (): void => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await runReleaseArticlesCli(args, defaultReleaseArticlesDeps(), (line) => process.stdout.write(line + '\n'), controller.signal); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
