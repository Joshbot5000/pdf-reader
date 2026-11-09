import { describe, expect, it } from 'vitest';
import { blockAt, buildBlocks, type Run } from '../src/shared/textBlocks';

const run = (str: string, x: number, y: number, size = 12, width = str.length * size * 0.5): Run => ({ str, transform: [size, 0, 0, size, x, y], width });

describe('buildBlocks', () => {
  it('groups runs into lines and lines into paragraphs', () => {
    const blocks = buildBlocks([
      run('Service Agreement', 45, 776, 24),
      run('The Supplier will deliver the Services in', 45, 744),
      run('accordance with good practice.', 45, 730),
      run('Payment is due within', 45, 705),
      run('30 days', 175, 705),
      run('of the invoice date.', 222, 705),
    ]);
    expect(blocks.map((b) => b.text)).toEqual([
      'Service Agreement',
      'The Supplier will deliver the Services in accordance with good practice.',
      'Payment is due within 30 days of the invoice date.',
    ]);
    expect(blocks[1].lines).toHaveLength(2);
    expect(blocks[1].lineGap).toBeCloseTo(14);
    expect(blocks[1].box.y).toBeLessThan(730);
    expect(blocks[1].box.y + blocks[1].box.height).toBeGreaterThan(744);
  });

  it('keeps separate columns and distant paragraphs apart', () => {
    const blocks = buildBlocks([run('Left column', 40, 700), run('Right column', 320, 700), run('Far below', 40, 600)]);
    expect(blocks.map((b) => b.text).sort()).toEqual(['Far below', 'Left column', 'Right column']);
  });

  it('rejoins hyphenated line breaks and skips rotated text', () => {
    const blocks = buildBlocks([
      run('A negli-', 40, 700),
      run('gence claim', 40, 686),
      { str: 'Sideways', transform: [0, 12, -12, 0, 300, 300], width: 50 },
    ]);
    expect(blocks.map((b) => b.text)).toEqual(['A negligence claim']);
  });

  it('finds the block under a point', () => {
    const blocks = buildBlocks([run('Hello world', 100, 500)]);
    expect(blockAt(blocks, 120, 503)?.text).toBe('Hello world');
    expect(blockAt(blocks, 120, 560)).toBeUndefined();
  });
});
