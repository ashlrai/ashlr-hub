import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUniverse, initUniverseCampaign, type UniverseManifest } from '../../src/core/universe/index.js';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const parserSourcePath = fileURLToPath(new URL('../../src/core/goal-loop/parse.ts', import.meta.url));
export const parserTypesPath = fileURLToPath(new URL('../../src/core/goal-loop/types.ts', import.meta.url));
export interface Operation { op: 'create' | 'replace' | 'delete'; path: string; content?: string }
export interface OperationPrompt {
  generation: number;
  parentTrialId: string | null;
  files: Array<{ path: string; content: string | null }>;
  feedback?: { previousAttemptFiles: Array<{ path: string; content: string; contentDigest: string }> };
  fileOperationsContext?: {
    files: Array<{ path: string; contentDigest: string | null }>;
    contextFiles: Array<{ path: string; content: string; contentDigest: string }>;
    previous: { files: Array<{ path: string; contentDigest: string | null }> } | null;
  };
}

export function parserHelper(tilde: boolean): string {
  return `/** Keep original line positions while masking fenced Markdown examples. */
export function markdownLines(lines: string[]): string[] {
  let fence = ''; let length = 0;
  return lines.map((line) => {
    const match = line.match(/^ {0,3}(\x60{3,}${tilde ? '|~{3,}' : ''})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence && match[1].length >= length && match[2].trim() === '') fence = '';
      return '';
    }
    if (match) { fence = match[1][0]; length = match[1].length; return ''; }
    return line;
  });
}
`;
}

export function parserCandidate(source: string): string {
  const replacements: Array<[string, string]> = [
    ["import { readFileSync } from 'node:fs';", "import { readFileSync } from 'node:fs';\nimport { markdownLines } from './markdown-lines.js';"],
    ['for (const rawLine of splitLines(content)) {', 'for (const rawLine of markdownLines(splitLines(content))) {'],
    ['const lines = splitLines(content);\n\n  let title', 'const lines = splitLines(content);\n  const visibleLines = markdownLines(lines);\n\n  let title'],
    ['const line = lines[i] as string;\n\n    const heading', 'const line = visibleLines[i] as string;\n\n    const heading'],
    ['doneWhen: findDoneWhen(lines, i, label)', 'doneWhen: findDoneWhen(visibleLines, i, label)'],
  ];
  let result = source;
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error('Real parser fixture source boundary changed; review the challenge');
    result = result.replace(before, after);
  }
  return result;
}

// The fixed evaluator keeps expectations in its own process. The candidate
// child receives invocation cases only, exactly like the existing native demo.
const PARSER_PROBE = String.raw`import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const inputs=JSON.parse(readFileSync(0,'utf8'));
const candidate=await import(pathToFileURL(process.argv[1]).href);
const observations=inputs.map((input,index)=>{
  const path=join(process.cwd(),'case-'+index+'.md');writeFileSync(path,input.text);
  try {
    if(input.kind==='roadmap') return candidate.parseRoadmap(process.cwd(),'case-'+index+'.md').milestones.map(item=>({id:item.id,title:item.title,file:item.file.split('/').at(-1)}));
    const doc=candidate.parseMilestone(path,'M0');const tick=candidate.tickSteps(doc,['M0.1']);
    return {id:doc.id,title:doc.title,steps:doc.steps,gate:doc.gate,lines:doc.lines,ticked:tick.lines,changed:tick.changed};
  } catch { return {error:'Candidate parser failed'}; }
});
console.log(JSON.stringify(observations));`;

function parserCases(): Array<{ kind: 'roadmap' | 'milestone'; text: string; expected: unknown }> {
  const cases: Array<{ kind: 'roadmap' | 'milestone'; text: string; expected: unknown }> = [];
  const road = ['# Roadmap', '- [M0](M0-first.md)', '- M1: M1-second.md', '- [M0 duplicate](ignored.md)'];
  const roadmapExpected = [{ id: 'M0', title: 'M0', file: 'M0-first.md' }, { id: 'M1', title: 'M1', file: 'M1-second.md' }];
  cases.push({ kind: 'roadmap', text: road.join('\n'), expected: roadmapExpected });
  const base = ['# Real milestone', '- [ ] M0.1: Implement feature', '  Done when: passes the real check', '',
    '## Acceptance checklist (gate)', '- stable output', '- [x] repeatable'];
  const addMilestone = (lines: string[], crlf = false): void => {
    const lineIndex = lines.indexOf('- [ ] M0.1: Implement feature');
    const ticked = [...lines]; ticked[lineIndex] = '- [x] M0.1: Implement feature';
    cases.push({ kind: 'milestone', text: lines.join(crlf ? '\r\n' : '\n'), expected: {
      id: 'M0', title: 'Real milestone',
      steps: [{ id: 'M0.1', text: 'Implement feature', doneWhen: 'passes the real check', checked: false, lineIndex }],
      gate: ['stable output', 'repeatable'], lines, ticked, changed: true,
    } });
  };
  addMilestone(base); addMilestone(base, true);
  for (const [open, close] of [['```', '```'], ['~~~', '~~~'], ['````js', '````'], ['   ~~~~text', '  ~~~~~']]) {
    const fake = [open, '# Fake title', '- [ ] M9.9: Example', 'Done when: fake check', '## Acceptance gate', '- fake gate', close];
    cases.push({ kind: 'roadmap', text: [open, '- [M99](not-a-task.md)', close, ...road].join('\n'), expected: roadmapExpected });
    addMilestone([...fake, ...base]);
    addMilestone([...base.slice(0, 2), ...fake, ...base.slice(2)]);
    addMilestone([...base.slice(0, 5), ...fake, ...base.slice(5)]);
  }
  cases.push({ kind: 'roadmap', text: ['```', ...road].join('\n'), expected: [] });
  cases.push({ kind: 'roadmap', text: ['~~~~', '- [M99](not-a-task.md)', '~~~', '- [M98](also-example.md)', '~~~~', ...road].join('\n'), expected: roadmapExpected });
  return cases;
}

export const PARSER_CASE_COUNT = parserCases().length + 2;
function parserEvaluator(typesDigest: string): string {
  return String.raw`import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
const source=process.env.ASHLR_UNIVERSE_CANDIDATE;
const scratch=join(process.env.TMPDIR,'compiled');mkdirSync(scratch,{recursive:true});
writeFileSync(join(scratch,'package.json'),'{"type":"module"}');
const tests=CASES;
let observations=[];let compiled=false;
try {
  for(const name of ['parse.ts','markdown-lines.ts']) if(existsSync(join(source,name)))
    writeFileSync(join(scratch,name.replace(/\.ts$/,'.js')),stripTypeScriptTypes(readFileSync(join(source,name),'utf8')));
  observations=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',PROBE,join(scratch,'parse.js')],{
    cwd:scratch,env:process.env,input:JSON.stringify(tests.map(({kind,text})=>({kind,text}))),encoding:'utf8',timeout:3000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']}));
  compiled=true;
} catch {}
const passed=tests.map((test,index)=>isDeepStrictEqual(observations[index],test.expected));
const contextIntact=createHash('sha256').update(readFileSync(join(source,'types.ts'))).digest('hex')===TYPES;
const helperPresent=existsSync(join(source,'markdown-lines.ts'));
const casesPassed=passed.filter(Boolean).length+Number(contextIntact)+Number(helperPresent);
const casesTotal=tests.length+2;
console.log(JSON.stringify({passed:compiled&&casesPassed===casesTotal,score:casesPassed,metrics:{casesPassed,casesTotal,contextIntact:Number(contextIntact),helperPresent:Number(helperPresent)},
diagnostics:casesPassed===casesTotal?[]:[{code:'MARKDOWN_FENCE_CASES',message:'Ignore both backtick and tilde fenced examples in roadmap, steps, headings, Done when and gates; preserve original lines and tick indices.',path:'parse.ts'}]}));`
    .replace('CASES', JSON.stringify(parserCases())).replace('PROBE', JSON.stringify(PARSER_PROBE)).replace('TYPES', JSON.stringify(typesDigest));
}

const DELETE_EVALUATOR = String.raw`import {existsSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const root=process.env.ASHLR_UNIVERSE_CANDIDATE;
let value=null;try{value=Number(execFileSync(process.execPath,[join(root,'entry.mjs')],{encoding:'utf8',timeout:1000,env:process.env}));}catch{}
const preserved=readFileSync(join(root,'contract.txt'),'utf8')==='Return a positive measured integer.\n';
const passed=Number.isInteger(value)&&value>0&&preserved&&!existsSync(join(root,'legacy.mjs'))&&existsSync(join(root,'helper.mjs'));
console.log(JSON.stringify({passed,score:passed?value:0,metrics:{contextIntact:Number(preserved),legacyPresent:Number(existsSync(join(root,'legacy.mjs')))}}));`;

export function fixtureSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const stat = lstatSync(path); const relative = `${prefix}${name}`;
      if (stat.isSymbolicLink()) throw new Error('Unexpected fixture symlink');
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else { if (!stat.isFile()) throw new Error('Unexpected fixture file type'); result[relative] = `${stat.mode & 0o777}:${sha256(readFileSync(path))}`; }
    }
  };
  visit(root, ''); return result;
}

export async function fileOperationsFixture(options: {
  kind?: 'parser' | 'delete'; generations?: number; feedback?: boolean;
  respond?: (prompt: OperationPrompt, index: number) => Operation[] | Promise<Operation[]>;
  onRequest?: () => void;
} = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-file-ops-native-')));
  const root = join(base, 'store'); const repo = join(base, 'seed'); mkdirSync(repo, { mode: 0o700 });
  const parser = readFileSync(parserSourcePath, 'utf8'); const types = readFileSync(parserTypesPath, 'utf8');
  const kind = options.kind ?? 'parser';
  const seedFiles: Record<string, string> = kind === 'parser'
    ? { 'parse.ts': parser, 'types.ts': types, 'evaluate.mjs': parserEvaluator(sha256(types)) }
    : { 'entry.mjs': "import {value} from './legacy.mjs'; console.log(value);\n", 'legacy.mjs': 'export const value = 0;\n',
      'contract.txt': 'Return a positive measured integer.\n', 'evaluate.mjs': DELETE_EVALUATOR };
  for (const [name, content] of Object.entries(seedFiles)) writeFileSync(join(repo, name), content);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', ...Object.keys(seedFiles));
  git('-c', 'user.name=Universe File Operation Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'pin independent source challenge');
  const requests: OperationPrompt[] = [];
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; tools?: unknown };
      if (request.headers.authorization || parsed.tools !== undefined) throw new Error('Fixture unexpectedly received credentials or tools');
      const prompt = JSON.parse(parsed.messages.find((message) => message.role === 'user')!.content) as OperationPrompt;
      const index = requests.push(prompt) - 1; options.onRequest?.();
      const generated = options.respond?.(prompt, index) ?? (index < 2
        ? [{ op: 'create' as const, path: 'markdown-lines.ts', content: parserHelper(index > 0) },
          { op: 'replace' as const, path: 'parse.ts', content: parserCandidate(parser) }]
        : [{ op: 'replace' as const, path: 'markdown-lines.ts', content: parserHelper(true) }]);
      Promise.resolve(generated).then((operations) => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ operations }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 } }));
      }).catch(() => { response.writeHead(500); response.end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'file-operations', name: 'Independent file operations fixture',
    objective: kind === 'parser' ? 'Ignore fenced Markdown examples while preserving the real goal-loop parser API, original lines and checkbox indexes.' : 'Replace the obsolete helper while preserving the read-only contract.',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: kind === 'parser' ? 'casesPassed' : 'value', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15000, trialTimeoutMs: 5000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 4000 },
    variants: [{ id: 'generator', niche: 'correctness', hypothesis: 'Create a reusable module and correct the caller using independent feedback.',
      generation: { kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'deterministic-file-operations-fixture',
        files: kind === 'parser' ? ['parse.ts', 'markdown-lines.ts'] : ['entry.mjs', 'legacy.mjs', 'helper.mjs'], maxOutputTokens: 4096,
        fileOperations: { schemaVersion: 1, contextFiles: kind === 'parser' ? ['types.ts'] : ['contract.txt'] } } }] };
  initUniverse(manifest, { root });
  const generations = options.generations ?? 3;
  const definition = { schemaVersion: 1 as const, id: 'file-campaign', universeId: manifest.id, feedback: options.feedback ?? true,
    budget: { maxGenerations: generations, maxDurationMs: 30000, maxModelRequests: generations, maxStagnantGenerations: generations, maxReportedTokens: null } };
  initUniverseCampaign(definition, { root });
  const dispose = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    const writable = (path: string): void => {
      const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(base); rmSync(base, { recursive: true, force: true });
  };
  return { base, root, repo, git, manifest, definition, requests, parser, types, dispose };
}
