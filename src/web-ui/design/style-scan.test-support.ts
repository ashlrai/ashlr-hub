/**
 * design/style-scan.test-support.ts — the static half of SPEC-310C §7's
 * "Dark" test method: NEW 3.10 UI files may not carry a raw hex colour or a
 * px font size (unit C0).
 *
 * Why a scan and not review: a hex is a colour that does not follow the
 * theme (it is right in one mode and wrong in the other), and a px font size
 * ignores the operator's display-size setting and the 11px floor. Both are
 * invisible in a light-mode screenshot at the default size — which is exactly
 * when a builder looks. Tokens (design/tokens.css, charts/chart-tokens.css)
 * are the only sanctioned sources, so they are not scanned.
 *
 * Scoped to the paths SPEC-310C §7 creates, so the rule binds new work
 * without re-litigating every legacy stylesheet in the same change.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export type StyleViolationKind = 'hex-colour' | 'px-font-size';

export interface StyleViolation {
  /** Relative to src/web-ui. */
  file: string;
  line: number;
  kind: StyleViolationKind;
  text: string;
}

/**
 * NEW 3.10 UI paths (relative to src/web-ui), from SPEC-310C §7's ownership
 * table. A directory covers everything under it; a file is exact. Paths that
 * do not exist yet are skipped, so a unit is held to the rule the moment its
 * files land.
 */
export const NEW_310_UI_PATHS: readonly string[] = [
  'routes/verse/shell',
  'routes/verse/dock',
  'routes/verse/composer',
  'routes/verse/git',
  'routes/verse/apps',
  'routes/verse/command',
  'routes/verse/fleet',
  'routes/verse/growth',
  'routes/verse/mind',
  'routes/verse/autonomy/AutonomyOffState.tsx',
  'routes/verse/autonomy/autonomy-off.module.css',
  'routes/verse/sections/CommandSection.tsx',
  'routes/verse/sections/FleetSection.tsx',
  'routes/verse/sections/GrowthSection.tsx',
  'routes/verse/sections/MindSection.tsx',
  'routes/verse/sections/AppsSection.tsx',
  'routes/verse/chat/ActivityGroup.tsx',
  'routes/verse/chat/ActivityGroup.module.css',
  'routes/verse/chat/TasksTray.tsx',
  'routes/verse/chat/TasksTray.module.css',
  'routes/verse/chat/ChapterRail.tsx',
  'routes/verse/chat/ChapterRail.module.css',
  'routes/verse/chat/NoticeSlot.tsx',
  'routes/verse/chat/NoticeSlot.module.css',
  'components/charts/ForestPlot.tsx',
  'components/charts/ForestPlot.module.css',
  'components/charts/MatrixHeatmap.tsx',
  'components/charts/MatrixHeatmap.module.css',
  'components/charts/StepBand.tsx',
  'components/charts/StepBand.module.css',
];

const SCANNED = /\.(?:css|tsx?)$/;
const EXEMPT = /\.test\.[^/]+$|\.test-support\.[^/]+$/;

/**
 * A hex colour as a WHOLE token: `#fff`, `#0c6a92`, `#0c6a92cc`. The
 * look-behind/ahead keep URL fragments and ids out (`href="#add-root"`,
 * `#fed1`), which only look like hex until the next character.
 */
const HEX_RE = /(?<![\w&/])#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/gi;

/** CSS: a font-size (or font shorthand) whose value carries a px length anywhere, calc() included. */
const CSS_FONT_PX_RE = /\bfont(?:-size)?\s*:[^;{}]*?\d(?:\.\d+)?px/gi;

/** TS/TSX: `fontSize: 12`, `fontSize: '12px'`, `fontSize={11}`, `fontSize="11"`, `font-size="11px"`. */
const TS_FONT_PX_RE = /\b(?:fontSize|font-size)\s*[:=]\s*\{?\s*['"`]?\d/g;

function stripComments(source: string, isCss: boolean): string {
  // Keep line breaks so reported line numbers stay true.
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const block = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  return isCss ? block : block.replace(/(^|[^:\\])\/\/.*$/gm, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Scan one source text. `file` only labels the result (and picks CSS vs TS rules). */
export function scanStyleSource(file: string, source: string): StyleViolation[] {
  const isCss = file.endsWith('.css');
  const text = stripComments(source, isCss);
  const out: StyleViolation[] = [];
  for (const m of text.matchAll(HEX_RE)) {
    out.push({ file, line: lineOf(text, m.index), kind: 'hex-colour', text: m[0] });
  }
  for (const m of text.matchAll(isCss ? CSS_FONT_PX_RE : TS_FONT_PX_RE)) {
    out.push({ file, line: lineOf(text, m.index), kind: 'px-font-size', text: m[0].trim() });
  }
  return out.sort((a, b) => a.line - b.line);
}

function walk(path: string, into: string[]): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), into);
  } else if (SCANNED.test(path) && !EXEMPT.test(path)) {
    into.push(path);
  }
}

/** Every scanned file under `paths` (relative to `webRoot`) that exists today. */
export function newUiFiles(webRoot: string = resolve(process.cwd(), 'src/web-ui'), paths: readonly string[] = NEW_310_UI_PATHS): string[] {
  const files: string[] = [];
  for (const rel of paths) {
    const abs = join(webRoot, rel);
    if (existsSync(abs)) walk(abs, files);
  }
  return [...new Set(files)].sort();
}

/** Scan every new 3.10 UI file that exists. */
export function scanNewUiFiles(webRoot: string = resolve(process.cwd(), 'src/web-ui')): StyleViolation[] {
  return newUiFiles(webRoot).flatMap((abs) => scanStyleSource(relative(webRoot, abs), readFileSync(abs, 'utf8')));
}
