import { describe, expect, it } from 'vitest';
import { compareTexts, tokenize } from '../src/shared/compare';
import { SENSITIVE_PATTERNS, findRegexInPage } from '../src/shared/search';

const page = (...s: string[]) => s.map((str) => ({ str }));

describe('tokenize', () => {
  it('keeps word origins across runs', () => {
    const w = tokenize([page('neg', 'ligence is'), page('fault')]);
    expect(w.map((x) => [x.page, x.text])).toEqual([[0, 'negligence'], [0, 'is'], [1, 'fault']]);
    expect(w[0].segments).toEqual([{ item: 0, start: 0, end: 3 }, { item: 1, start: 0, end: 7 }]);
  });
});

describe('compareTexts', () => {
  it('reports changed, added and removed words', () => {
    const a = [page('The reasonable man standard applies to all drivers.')];
    const b = [page('The reasonable person standard applies to all learner drivers.'), page('New page')];
    const r = compareTexts(a, b);
    expect(r.changes.map((c) => [c.kind, c.removed.map((w) => w.text).join(' '), c.added.map((w) => w.text).join(' ')])).toEqual([
      ['changed', 'man', 'person'],
      ['added', '', 'learner'],
      ['added', '', 'New page'],
    ]);
    expect(r.pagesB).toBe(2);
    expect(r.identicalText).toBe(false);
  });

  it('treats layout-only differences as identical', () => {
    expect(compareTexts([[{ str: 'a  b', hasEOL: true }, { str: 'c' }]], [page('a b c')]).identicalText).toBe(true);
  });
});

describe('sensitive data patterns', () => {
  const find = (id: string, text: string) =>
    findRegexInPage(0, page(text), SENSITIVE_PATTERNS.find((p) => p.id === id)!.pattern).length;

  it('finds emails, phones, NI numbers and postcodes', () => {
    expect(find('email', 'Contact josh.l@example.co.uk or a@b.io today')).toBe(2);
    expect(find('phone', 'Call 020 7946 0958 or +44 7700 900123')).toBe(2);
    expect(find('nino', 'NI: AB 12 34 56 C')).toBe(1);
    expect(find('postcode', 'London SW1A 1AA and M1 1AE')).toBe(2);
    expect(find('card', 'Card 4111 1111 1111 1111')).toBe(1);
  });
});
