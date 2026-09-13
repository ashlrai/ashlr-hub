/** Fixed compiler over a closed virtual filesystem. Candidate text is parsed,
 * never evaluated. The caller owns subprocess memory/time and settlement. */
import { posix } from 'node:path';
import ts from 'typescript';
import { MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES, PREPARATION_TYPECHECK_TARGET, PREPARATION_TYPECHECK_VIRTUAL_ROOT,
  validatePreparationTypecheckProject } from './preparation-typecheck-project.js';
export { parsePreparationTypecheckProject, validatePreparationTypecheckProject } from './preparation-typecheck-project.js';
export type { PreparationTypecheckProject } from './preparation-typecheck-project.js';

export type PreparationTypecheckCode = 'PREPARATION_TYPES_PASSED' | 'PREPARATION_TYPES_INVALID_PROJECT' |
  'PREPARATION_TYPES_INVALID_CANDIDATE' | 'PREPARATION_TYPES_DIRECTIVE_REFUSED' | 'PREPARATION_TYPES_DIAGNOSTICS' | 'PREPARATION_TYPES_FAILED';
export interface PreparationTypecheckResult { passed: boolean; code: PreparationTypecheckCode; diagnosticCount: number | null; diagnosticCodes: number[] }

function forbiddenDirectives(source: string): boolean {
  const parsed = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.ES2022, true);
  // Let the parser identify regex and template/string spans; a bare lexical
  // scanner alone can mistake comment-like bytes inside those literals.
  const literals: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) ||
        [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) {
      literals.push({ start: node.getStart(parsed), end: node.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed); literals.sort((a, b) => a.start - b.start);
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, source);
  let index = 0;
  while (true) {
    while (literals[index] && literals[index]!.end <= scanner.getTextPos()) index++;
    if (literals[index] && literals[index]!.start === scanner.getTextPos()) {
      scanner.setTextPos(literals[index++]!.end); continue;
    }
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return false;
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const comment = scanner.getTokenText();
      if (/@ts-(?:nocheck|ignore|expect-error)\b/.test(comment) || /^\/\/\/\s*</.test(comment)) return true;
    }
  }
}

export function verifyPreparationTypes(projectInput: unknown, candidateSource: unknown): PreparationTypecheckResult {
  let code: PreparationTypecheckCode = 'PREPARATION_TYPES_INVALID_PROJECT';
  const failed = (diagnosticCount: number | null = null, diagnosticCodes = [99999]): PreparationTypecheckResult => ({ passed: false, code, diagnosticCount, diagnosticCodes });
  try {
    const project = validatePreparationTypecheckProject(projectInput);
    if (project.compilerVersion !== ts.version) return failed();
    code = 'PREPARATION_TYPES_INVALID_CANDIDATE';
    if (typeof candidateSource !== 'string' || Buffer.byteLength(candidateSource) > MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES ||
        Buffer.from(candidateSource).toString('utf8') !== candidateSource) return failed();
    code = 'PREPARATION_TYPES_DIRECTIVE_REFUSED';
    if (forbiddenDirectives(candidateSource)) return failed();
    code = 'PREPARATION_TYPES_INVALID_PROJECT';
    const root = PREPARATION_TYPECHECK_VIRTUAL_ROOT, target = `${root}/${PREPARATION_TYPECHECK_TARGET}`;
    const converted = ts.convertCompilerOptionsFromJson(project.compilerOptions, root);
    if (converted.errors.length) return failed();
    const options: ts.CompilerOptions = { ...converted.options, noEmit: true, noCheck: false, incremental: false };
    const files = new Map(project.files.map(file => [`${root}/${file.path}`, file.text]));
    files.set(target, candidateSource);
    const directories = new Set<string>([root]);
    for (const file of files.keys()) for (let parent = posix.dirname(file); parent.startsWith(root); parent = posix.dirname(parent)) directories.add(parent);
    const normalized = (file: string): string | undefined => {
      if (typeof file !== 'string' || file.includes('\\') || file.includes('\0')) return undefined;
      const normalized = posix.resolve(root, file);
      return normalized === root || normalized.startsWith(`${root}/`) ? normalized : undefined;
    };
    const read = (file: string): string | undefined => { const name = normalized(file); return name ? files.get(name) : undefined; };
    const host: ts.CompilerHost = {
      getSourceFile: (file, languageVersion) => { const text = read(file); return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true); },
      getDefaultLibFileName: opts => `${root}/node_modules/typescript/lib/${ts.getDefaultLibFileName(opts)}`,
      getDefaultLibLocation: () => `${root}/node_modules/typescript/lib`,
      getEnvironmentVariable: () => undefined,
      writeFile: () => { throw new Error('Preparation typecheck writes are forbidden'); },
      getCurrentDirectory: () => root,
      getDirectories: directory => { const name = normalized(directory); return name ? [...directories].filter(child => posix.dirname(child) === name && child !== name).map(child => posix.basename(child)).sort() : []; },
      fileExists: file => read(file) !== undefined,
      readFile: read,
      directoryExists: directory => { const name = normalized(directory); return name !== undefined && directories.has(name); },
      realpath: file => normalized(file) ?? '/outside-preparation-typecheck',
      getCanonicalFileName: file => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    };
    code = 'PREPARATION_TYPES_FAILED';
    const program = ts.createProgram(project.rootNames.map(name => `${root}/${name}`), options, host);
    if (program.getSourceFile(target)?.getFullText() !== candidateSource) return failed();
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) {
      code = 'PREPARATION_TYPES_DIAGNOSTICS';
      const codes = [...new Set(diagnostics.map(row => row.code))].sort((a, b) => a - b).slice(0, 32);
      return failed(Math.min(diagnostics.length, 100_000), codes);
    }
    return { passed: true, code: 'PREPARATION_TYPES_PASSED', diagnosticCount: 0, diagnosticCodes: [] };
  } catch { return failed(); }
}
