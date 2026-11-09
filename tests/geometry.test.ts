import { describe, expect, it } from 'vitest';
import { runSliceBox } from '../src/renderer/src/geometry';

describe('runSliceBox', () => {
  // Flip y like a pdf.js viewport at scale 1 on an 800pt-tall page.
  const flip = (x: number, y: number): [number, number] => [x, 800 - y];

  it('boxes a slice of a horizontal run', () => {
    const r = runSliceBox({ str: 'abcd', transform: [10, 0, 0, 10, 100, 700], width: 40 }, 1, 3, flip)!;
    expect(r.left).toBeCloseTo(110);
    expect(r.width).toBeCloseTo(20);
    expect(r.top).toBeCloseTo(800 - 709.2);
    expect(r.height).toBeCloseTo(11.4);
  });

  it('handles rotated text', () => {
    const r = runSliceBox({ str: 'ab', transform: [0, 10, -10, 0, 100, 100], width: 20 }, 0, 2, flip)!;
    expect(r.height).toBeCloseTo(20);
    expect(r.width).toBeCloseTo(11.4);
  });

  it('uses a font measurer for proportional text', () => {
    // 'W' is three times as wide as 'i' in this fake font.
    const measure = (t: string) => [...t].reduce((n, c) => n + (c === 'W' ? 3 : 1), 0);
    const r = runSliceBox({ str: 'Wii', transform: [10, 0, 0, 10, 0, 0], width: 50 }, 1, 3, flip, measure)!;
    expect(r.left).toBeCloseTo(30);
    expect(r.width).toBeCloseTo(20);
  });

  it('returns null for empty slices', () => {
    expect(runSliceBox({ str: '', transform: [1, 0, 0, 1, 0, 0], width: 0 }, 0, 0, flip)).toBeNull();
  });
});
