/** Geometry helpers for mapping pdf.js text runs to on-screen boxes. */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** pdf.js text item geometry (subset of TextItem). */
export interface RunGeometry {
  str: string;
  /** Text-space to user-space matrix [a, b, c, d, e, f]. */
  transform: number[];
  /** Advance width in user-space units. */
  width: number;
}

export type ToViewport = (x: number, y: number) => [number, number];
/** Measures a string's advance width in any consistent unit. */
export type Measure = (text: string) => number;

/** Fraction of the run's width taken by its first `n` characters. */
function advanceFraction(str: string, n: number, measure?: Measure): number {
  if (n <= 0) return 0;
  if (n >= str.length) return 1;
  if (measure) {
    const total = measure(str);
    if (total > 0) return measure(str.slice(0, n)) / total;
  }
  return n / str.length;
}

/**
 * Bounding box, in viewport pixels, of characters [start, end) of a run.
 * Character positions come from `measure` (a font-aware text measurer) when
 * given, scaled to the run's real width; otherwise characters are assumed
 * evenly spaced. Works for rotated text and rotated pages because all four
 * corners are converted and then boxed.
 */
export function runSliceBox(
  run: RunGeometry,
  start: number,
  end: number,
  toViewport: ToViewport,
  measure?: Measure,
): Rect | null {
  const len = run.str.length;
  if (!len || end <= start) return null;
  const [a, b, c, d, e, f] = run.transform;
  const advance = Math.hypot(a, b) || 1;
  const fontHeight = Math.hypot(c, d) || advance;
  const dir = [a / advance, b / advance];
  const up = [c / fontHeight, d / fontHeight];
  const s0 = run.width * advanceFraction(run.str, start, measure);
  const s1 = run.width * advanceFraction(run.str, end, measure);
  const below = -0.22 * fontHeight; // descenders
  const above = 0.92 * fontHeight; // cap height and accents
  const corners = [
    [s0, below],
    [s1, below],
    [s1, above],
    [s0, above],
  ].map(([s, h]) => toViewport(e + dir[0] * s + up[0] * h, f + dir[1] * s + up[1] * h));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}
