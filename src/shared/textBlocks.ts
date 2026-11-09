/**
 * Group pdf.js text runs into editable paragraphs.
 *
 * Runs on the same baseline that are close together form a line; consecutive
 * lines with the same font size, similar left edge and normal line spacing
 * form a paragraph. Each paragraph has a bounding box in PDF user space and
 * its text with line breaks joined into flowing text.
 */
import type { Rect } from './pdfOps';

export interface Run {
  str: string;
  /** [a, b, c, d, e, f] text-to-user-space matrix. */
  transform: number[];
  width: number;
  /** pdf.js font id (the loaded font face), when known. */
  fontName?: string;
}

export interface Line {
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
}

export interface Block {
  box: Rect;
  lines: Line[];
  text: string;
  size: number;
  /** Typical distance between baselines (0 for a single line). */
  lineGap: number;
  /** pdf.js font id of the first run, for showing the editor in the same font. */
  fontName?: string;
}

export function buildBlocks(runs: Run[]): Block[] {
  type R = { str: string; x0: number; x1: number; y: number; size: number; font?: string };
  const rs: R[] = [];
  for (const r of runs) {
    if (!r.str.trim()) continue;
    const [a, b, c, d, e, f] = r.transform;
    // Only horizontal, upright text can be edited.
    if (Math.abs(b) > 1e-3 * Math.abs(a) || Math.abs(c) > 1e-3 * Math.abs(d) || a <= 0 || d <= 0) continue;
    rs.push({ str: r.str, x0: e, x1: e + r.width, y: f, size: Math.abs(d), font: r.fontName });
  }
  rs.sort((p, q) => q.y - p.y || p.x0 - q.x0);

  // Lines: same baseline (±35% of the size), similar size, small horizontal gap.
  const lines: (Line & { runs: R[]; font?: string })[] = [];
  for (const r of rs) {
    const line = lines.find(
      (l) =>
        Math.abs(l.y - r.y) < 0.35 * Math.max(l.size, r.size) &&
        Math.max(l.size, r.size) / Math.min(l.size, r.size) < 1.6 &&
        r.x0 >= l.x0 - r.size &&
        r.x0 - l.x1 < 2.5 * r.size,
    );
    if (line) {
      line.runs.push(r);
      line.x1 = Math.max(line.x1, r.x1);
      line.x0 = Math.min(line.x0, r.x0);
      line.size = Math.max(line.size, r.size);
    } else lines.push({ x0: r.x0, x1: r.x1, y: r.y, size: r.size, text: '', runs: [r], font: r.font });
  }
  for (const l of lines) {
    l.runs.sort((p, q) => p.x0 - q.x0);
    let text = '';
    let prev: R | null = null;
    for (const r of l.runs) {
      if (prev && r.x0 - prev.x1 > 0.15 * r.size && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      text += r.str;
      prev = r;
    }
    l.text = text.replace(/\s+/g, ' ').trim();
  }
  lines.sort((p, q) => q.y - p.y || p.x0 - q.x0);

  // Paragraphs: same size, aligned left edge (or a first-line indent), normal spacing.
  const blocks: (Block & { gaps: number[] })[] = [];
  for (const l of lines) {
    const b = blocks.find((blk) => {
      const last = blk.lines[blk.lines.length - 1];
      const gap = last.y - l.y;
      return (
        Math.abs(last.size - l.size) < 0.15 * l.size &&
        gap > 0.9 * l.size &&
        gap < 1.9 * l.size &&
        (!blk.gaps.length || Math.abs(gap - blk.gaps[0]) < 0.25 * l.size) &&
        Math.abs(l.x0 - blk.box.x) < 3 * l.size &&
        l.x0 < blk.box.x + blk.box.width &&
        l.x1 > blk.box.x
      );
    });
    if (b) {
      b.gaps.push(b.lines[b.lines.length - 1].y - l.y);
      b.lines.push(l);
    } else {
      blocks.push({ box: { x: l.x0, y: l.y, width: l.x1 - l.x0, height: 0 }, lines: [l], text: '', size: l.size, lineGap: 0, gaps: [], fontName: l.font });
      continue;
    }
    const x0 = Math.min(b.box.x, l.x0);
    const x1 = Math.max(b.box.x + b.box.width, l.x1);
    b.box = { ...b.box, x: x0, width: x1 - x0 };
  }

  return blocks.map(({ lines: ls, gaps, size, fontName }) => {
    const x0 = Math.min(...ls.map((l) => l.x0));
    const x1 = Math.max(...ls.map((l) => l.x1));
    const top = ls[0].y + size * 0.9;
    const bottom = ls[ls.length - 1].y - size * 0.25;
    let text = '';
    for (const l of ls) {
      if (!text) text = l.text;
      else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(l.text)) text = text.slice(0, -1) + l.text; // re-join hyphenated words
      else text += ` ${l.text}`;
    }
    return {
      box: { x: x0, y: bottom, width: x1 - x0, height: top - bottom },
      lines: ls.map(({ x0: a, x1: b, y, size: s, text: t }) => ({ x0: a, x1: b, y, size: s, text: t })),
      text,
      size,
      lineGap: gaps.length ? gaps[0] : 0,
      fontName,
    };
  });
}

/** The block containing a point (PDF user space), if any. */
export function blockAt(blocks: Block[], x: number, y: number): Block | undefined {
  return blocks.find((b) => {
    const pad = b.size * 0.3;
    return x >= b.box.x - pad && x <= b.box.x + b.box.width + pad && y >= b.box.y - pad && y <= b.box.y + b.box.height + pad;
  });
}
