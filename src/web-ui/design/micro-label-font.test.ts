/**
 * design/micro-label-font.test.ts — the Display-font setting has to reach
 * EVERY uppercase micro-label, not half of them.
 *
 * `appearance-store.ts` implements the Display-font choice by writing
 * `--font-display` inline on `<html>`; a rule that does not reference that
 * token is simply unaffected by it. The app had both kinds of micro-label
 * side by side — `global.css`'s `.label-micro` and the Transcript/Settings
 * labels used the display face, while the Usage, Autonomy and Approvals panel
 * titles inherited `--font-ui` from body (one named it explicitly) — so
 * switching Display font to Mono re-faced one half of a screen and left the
 * other half sitting next to it unchanged.
 *
 * The signature of a micro-label is DESIGN-V2 §2's own definition: uppercase
 * plus `--tracking-label`. Every rule carrying both must also declare
 * `--font-display`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_UI = resolve(process.cwd(), 'src/web-ui');

/** tokens.css DEFINES `--tracking-label`; it declares no micro-labels. */
const EXEMPT = new Set(['design/tokens.css']);

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out.sort();
}

interface Rule {
  file: string;
  line: number;
  selector: string;
  body: string;
}

function microLabelRules(): Rule[] {
  const found: Rule[] = [];
  for (const file of cssFiles(WEB_UI)) {
    const rel = relative(WEB_UI, file);
    if (EXEMPT.has(rel)) continue;
    const css = readFileSync(file, 'utf8');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2] ?? '';
      if (!/text-transform:\s*uppercase/.test(body) || !body.includes('--tracking-label')) continue;
      const selector = (match[1] ?? '').trim().split('\n').at(-1)!.trim();
      found.push({ file: rel, line: css.slice(0, match.index).split('\n').length, selector, body });
    }
  }
  return found;
}

describe('design — uppercase micro-labels follow the Display-font setting', () => {
  const rules = microLabelRules();

  it('finds the micro-labels at all (guards the matcher itself)', () => {
    expect(rules.length).toBeGreaterThan(15);
  });

  it('declares --font-display on every one of them', () => {
    const offenders = rules
      .filter((rule) => !/font-family:\s*var\(--font-display\)/.test(rule.body))
      .map((rule) => `${rule.file}:${rule.line} ${rule.selector}`);
    expect(offenders).toEqual([]);
  });
});
