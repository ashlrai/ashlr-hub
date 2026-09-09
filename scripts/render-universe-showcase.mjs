#!/usr/bin/env node
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { projectUniverseShowcase } from './generate-universe-showcase.mjs';

/** Accept only the exact public schema; private demo records are not render inputs. */
export function renderUniverseShowcaseSvg(input) {
  let checked;
  try {
    const raw = { measurementScope: 'local-experiment', verified: input.verified, checks: input.checks,
      runs: input.generations.map((generation) => ({ generation: generation.generation, status: generation.status,
        trials: generation.trials.map((trial) => ({ id: trial.id, variantId: trial.variant, niche: trial.niche,
          status: trial.status, selected: trial.selected, parentTrialId: trial.parentTrialId,
          metrics: { artifactBytes: trial.artifactBytes, casesPassed: trial.casesPassed },
          score: trial.artifactBytes, delta: trial.delta })) })) };
    checked = projectUniverseShowcase(raw, { sourceRevision: input.sourceRevision, generatedAt: input.generatedAt });
    if (!isDeepStrictEqual(input, checked)) throw new Error();
  } catch { throw new Error('Expected validated public showcase evidence'); }
  const trial = (generation, variant) => checked.generations[generation].trials.find((item) => item.variant === variant);
  const texts = [];
  const text = (x, y, value, size = 25, color = '#e4f7ff', weight = 400) =>
    texts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${value}</text>`);
  const nodes = [];
  for (const [index, variant] of ['compact', 'readable'].entries()) {
    const y = 270 + index * 245;
    for (let generation = 0; generation < 2; generation++) {
      const item = trial(generation, variant); const x = generation === 0 ? 80 : 820;
      nodes.push(`<rect x="${x}" y="${y}" width="540" height="185" rx="14" fill="#10243b" stroke="#2c4963"/>`);
      text(x + 28, y + 43, variant === 'compact' ? 'Compact niche' : 'Readable niche', 28, '#e4f7ff', 600);
      text(x + 28, y + 107, `${item.artifactBytes} bytes`, 46, '#67e8f9', 600);
      text(x + 28, y + 151, '7 / 7 cases passed', 25);
      text(x + 315, y + 151, 'Retained', 25, '#9bb5ca');
    }
    const improvement = trial(1, variant).delta;
    nodes.push(`<path d="M 634 ${y + 80} H 800" fill="none" stroke="#67e8f9" stroke-width="3" marker-end="url(#arrow)"/>`);
    text(650, y + 54, 'Parent reused', 20, '#9bb5ca');
    text(650, y + 117, `−${improvement} bytes`, 23, '#67e8f9', 600);
  }
  for (const x of [80, 820]) {
    nodes.push(`<rect x="${x}" y="765" width="540" height="100" rx="14" fill="#10243b" stroke="#805645"/>`);
    text(x + 28, 806, 'Broken sort variant', 27, '#ffb38a', 600);
    text(x + 28, 843, 'Rejected · order preservation failed', 23, '#e4f7ff');
  }
  text(80, 90, 'Ashlr Universe', 58, '#e4f7ff', 600);
  text(80, 143, 'Measured improvement. Preserved correctness.', 30, '#9bb5ca');
  text(80, 231, 'Generation 1', 30, '#e4f7ff', 600);
  text(820, 231, 'Generation 2', 30, '#e4f7ff', 600);
  text(80, 925, 'Deterministic code experiment — not model engineering yield.', 26, '#e4f7ff');
  text(80, 965, `Source ${checked.sourceRevision ?? 'not supplied'}`, 21, '#9bb5ca');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1010" width="1440" height="1010" role="img" aria-labelledby="title description">
<title id="title">Ashlr Universe measured offline demonstration</title>
<desc id="description">Two generations retain compact and readable code variants after seven correctness cases. Compact shrinks from ${trial(0, 'compact').artifactBytes} to ${trial(1, 'compact').artifactBytes} bytes. Readable shrinks from ${trial(0, 'readable').artifactBytes} to ${trial(1, 'readable').artifactBytes} bytes. The broken sort variant is rejected in both generations. Arrows show reuse of retained parents. This is a deterministic local demonstration, not measured model engineering yield.</desc>
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M 0 1 L 8 5 L 0 9" fill="none" stroke="#67e8f9" stroke-width="1.5"/></marker></defs>
<rect width="1440" height="1010" fill="#07111f"/>
<path d="M80 178H1360 M80 888H1360" stroke="#2c4963"/>
${nodes.join('\n')}
<g font-family="'Space Grotesk', Arial, sans-serif">${texts.join('\n')}</g>
</svg>\n`;
}

export function writeUniverseShowcaseSvg(inputPath, outputPath) {
  if (!isAbsolute(inputPath) || !isAbsolute(outputPath) || resolve(outputPath) !== outputPath) throw new Error('Use absolute paths');
  const input = lstatSync(inputPath); const parent = dirname(outputPath); const directory = lstatSync(parent);
  if (!input.isFile() || input.isSymbolicLink() || input.size > 64 * 1024 ||
    !directory.isDirectory() || directory.isSymbolicLink() || realpathSync(parent) !== parent ||
    typeof process.getuid !== 'function' || directory.uid !== process.getuid() || (directory.mode & 0o022) !== 0) {
    throw new Error('Expected a bounded public JSON file and private output directory');
  }
  const svg = renderUniverseShowcaseSvg(JSON.parse(readFileSync(inputPath, 'utf8')));
  const fd = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, svg); fsyncSync(fd); } finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [inputFlag, input, outputFlag, output, ...extra] = process.argv.slice(2);
    if (inputFlag !== '--input' || outputFlag !== '--output' || !input || !output || extra.length) throw new Error();
    writeUniverseShowcaseSvg(input, output);
    console.log('Public evidence SVG written.');
  } catch { console.error('SVG export failed; use --input PUBLIC_JSON --output NEW_ABSOLUTE_SVG.'); process.exitCode = 1; }
}
