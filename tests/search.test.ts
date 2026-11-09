import { describe, expect, it } from 'vitest';
import { findAll, findInPage, indexPage } from '../src/shared/search';

const runs = (...s: string[]) => s.map((str) => ({ str }));

describe('indexPage', () => {
  it('collapses whitespace and treats line ends as spaces', () => {
    const { text } = indexPage([{ str: '  Hello ' }, { str: '  world', hasEOL: true }, { str: 'again' }]);
    expect(text).toBe('hello world again');
  });
});

describe('findInPage', () => {
  it('is case-insensitive by default and case-sensitive on request', () => {
    const items = runs('Contract and contract');
    expect(findInPage(0, items, 'CONTRACT')).toHaveLength(2);
    expect(findInPage(0, items, 'Contract', { caseSensitive: true })).toHaveLength(1);
  });

  it('maps a match back to offsets in each run it spans', () => {
    const [m] = findInPage(4, [{ str: 'the quick', hasEOL: true }, { str: 'brown fox' }], 'quick brown');
    expect(m).toEqual({ page: 4, segments: [{ item: 0, start: 4, end: 9 }, { item: 1, start: 0, end: 5 }] });
  });

  it('matches across runs split mid-word', () => {
    const [m] = findInPage(0, runs('neg', 'ligence'), 'negligence');
    expect(m.segments).toEqual([{ item: 0, start: 0, end: 3 }, { item: 1, start: 0, end: 7 }]);
  });

  it('honours whole-word matching', () => {
    const items = runs('tort tortious tort.');
    expect(findInPage(0, items, 'tort')).toHaveLength(3);
    expect(findInPage(0, items, 'tort', { wholeWord: true })).toHaveLength(2);
  });

  it('finds overlapping candidates without skipping', () => {
    expect(findInPage(0, runs('aaaa'), 'aa')).toHaveLength(2);
    expect(findInPage(0, runs('xab ab'), 'ab', { wholeWord: true })).toHaveLength(1);
  });

  it('ignores empty queries', () => {
    expect(findInPage(0, runs('abc'), '   ')).toEqual([]);
  });
});

describe('findAll', () => {
  it('numbers pages in document order', () => {
    const m = findAll([runs('x'), runs('no'), runs('x x')], 'x');
    expect(m.map((x) => x.page)).toEqual([0, 2, 2]);
  });
});
