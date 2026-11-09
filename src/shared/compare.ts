/**
 * Word-level comparison of two documents' text.
 *
 * Each document's pages are indexed with the same whitespace rules as search,
 * split into words that remember where they came from (page, run, offsets),
 * then diffed. Changes come back grouped, with the source words on each side
 * so the UI can highlight them on the rendered pages.
 */
import { diffArrays } from 'diff';
import { indexPage, type MatchSegment, type TextRun } from './search';

export interface Word {
  page: number;
  text: string;
  segments: MatchSegment[];
}

export interface Change {
  kind: 'added' | 'removed' | 'changed';
  removed: Word[];
  added: Word[];
}

export interface Comparison {
  changes: Change[];
  wordsA: number;
  wordsB: number;
  pagesA: number;
  pagesB: number;
  identicalText: boolean;
}

export function tokenize(pages: TextRun[][]): Word[] {
  const words: Word[] = [];
  pages.forEach((items, page) => {
    const { text, map } = indexPage(items, true);
    for (const m of text.matchAll(/\S+/g)) {
      const segments: MatchSegment[] = [];
      for (let k = m.index!; k < m.index! + m[0].length; k++) {
        const ref = map[k];
        if (!ref) continue;
        const last = segments[segments.length - 1];
        if (last && last.item === ref[0] && last.end === ref[1]) last.end++;
        else segments.push({ item: ref[0], start: ref[1], end: ref[1] + 1 });
      }
      words.push({ page, text: m[0], segments });
    }
  });
  return words;
}

export function compareTexts(a: TextRun[][], b: TextRun[][]): Comparison {
  const wa = tokenize(a);
  const wb = tokenize(b);
  const parts = diffArrays(wa, wb, { comparator: (x: Word, y: Word) => x.text === y.text });
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) continue;
    const next = parts[i + 1];
    if (p.removed && next?.added) {
      changes.push({ kind: 'changed', removed: p.value, added: next.value });
      i++;
    } else if (p.removed) changes.push({ kind: 'removed', removed: p.value, added: [] });
    else changes.push({ kind: 'added', removed: [], added: p.value });
  }
  return {
    changes,
    wordsA: wa.length,
    wordsB: wb.length,
    pagesA: a.length,
    pagesB: b.length,
    identicalText: changes.length === 0,
  };
}
