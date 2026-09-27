/**
 * routes/verse/browser/browser-geometry.ts — where the page goes inside the
 * pane: device presets, zoom steps, and the rectangle handed to the native
 * webview. Pure.
 *
 * The native webview is a separate window laid over the Verse window, so it
 * is positioned in the Verse page's viewport coordinates (CSS px from the
 * top-left of the window's web content — `getBoundingClientRect()`), and
 * native adds the window's own screen position.
 */

export type DevicePreset = 'fill' | 'desktop' | 'tablet' | 'mobile';

export const DEVICE_SIZES: Readonly<Record<Exclude<DevicePreset, 'fill'>, { width: number; height: number; label: string }>> = {
  desktop: { width: 1280, height: 800, label: 'Desktop 1280 × 800' },
  tablet: { width: 820, height: 1180, label: 'Tablet 820 × 1180' },
  mobile: { width: 390, height: 844, label: 'Phone 390 × 844' },
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The page's rectangle inside `stage` for a preset: the preset's size,
 * centred, never larger than the stage (a phone in a short pane scrolls
 * inside the page rather than spilling over the chat).
 */
export function frameRect(stage: Rect, device: DevicePreset): Rect {
  if (device === 'fill') return roundRect(stage);
  const size = DEVICE_SIZES[device];
  const width = Math.min(size.width, stage.width);
  const height = Math.min(size.height, stage.height);
  return roundRect({
    x: stage.x + (stage.width - width) / 2,
    y: stage.y + (stage.height - height) / 2,
    width,
    height,
  });
}

export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, width: Math.max(1, Math.round(r.x + r.width) - x), height: Math.max(1, Math.round(r.y + r.height) - y) };
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** A rectangle the native side will accept (finite, positive, on screen). */
export function isUsableRect(r: Rect): boolean {
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 40 && r.height >= 40;
}

export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function stepZoom(current: number, direction: -1 | 1): number {
  const index = ZOOM_STEPS.findIndex((z) => Math.abs(z - current) < 0.001);
  if (index < 0) return 1;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))]!;
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
