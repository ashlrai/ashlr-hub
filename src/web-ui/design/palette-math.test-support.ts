/**
 * design/palette-math.test-support.ts — the colour-distance math the dataviz
 * skill's validate_palette.js uses, typed, over ./contrast.ts's parser, so
 * the palette properties the V3.10 tokens were DERIVED with (tokens.css
 * "Data encoding") are re-checked on every run instead of trusted:
 *
 *   - OKLab (Ottosson 2020) for perceptual distance: ΔE = 100 × Euclidean
 *     distance in OKLab, the validator's scale (15 = clearly different).
 *   - Machado, Oliveira & Fernandes 2009 at severity 1.0 for protanopia and
 *     deuteranopia — the same matrices the validator applies in linear sRGB.
 *
 * Test support only: nothing at runtime needs perceptual distance.
 */
import { parseColor, type Rgba } from './contrast.js';

type Vec3 = [number, number, number];

const MACHADO: Record<'protan' | 'deutan', [Vec3, Vec3, Vec3]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function rgbOf(color: string): Rgba {
  const parsed = parseColor(color);
  if (!parsed) throw new Error(`not a colour this probe can read: ${color}`);
  return parsed;
}

function linear(color: string): Vec3 {
  const { r, g, b } = rgbOf(color);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

function oklabFromLinear([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate([r, g, b]: Vec3, kind: 'protan' | 'deutan'): Vec3 {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const [m0, m1, m2] = MACHADO[kind];
  return [
    clamp(m0[0] * r + m0[1] * g + m0[2] * b),
    clamp(m1[0] * r + m1[1] * g + m1[2] * b),
    clamp(m2[0] * r + m2[1] * g + m2[2] * b),
  ];
}

/** OKLCH of a colour: [L 0-1, C, h degrees]. */
export function oklch(color: string): Vec3 {
  const [L, a, b] = oklabFromLinear(linear(color));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** Perceptual distance on the validator's scale (100 × OKLab distance). */
export function deltaE(a: string, b: string, kind?: 'protan' | 'deutan'): number {
  const la = kind ? simulate(linear(a), kind) : linear(a);
  const lb = kind ? simulate(linear(b), kind) : linear(b);
  const [L1, a1, b1] = oklabFromLinear(la);
  const [L2, a2, b2] = oklabFromLinear(lb);
  return 100 * Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

/** The worse of the protan / deutan distances — the validator's CVD figure. */
export function cvdDeltaE(a: string, b: string): number {
  return Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));
}
