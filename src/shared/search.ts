/**
 * Text search over pdf.js text content.
 *
 * pdf.js returns each page's text as a list of runs ("items"). We join them
 * into one searchable string per page, collapsing whitespace so a phrase still
 * matches when it is split across runs or wraps onto the next line, and keep
 * a map from every searchable character back to its run and offset. Each
 * match is returned as per-run segments so the renderer can draw a box for
 * each piece of the match.
 */

export interface TextRun {
  str: string;
  hasEOL?: boolean;
}

export interface MatchSegment {
  item: number;
  start: number; // inclusive offset into item.str
  end: number; // exclusive
}

export interface Match {
  page: number;
  segments: MatchSegment[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

interface Indexed {
  text: string;
  /** For each char of `text`: [item, offset] or null for synthetic whitespace. */
  map: ([number, number] | null)[];
}

const WS = /\s/;
const WORD = /[\p{L}\p{N}_]/u;

function fold(ch: string, caseSensitive: boolean): string {
  if (caseSensitive) return ch;
  const lower = ch.toLowerCase();
  // Keep a 1:1 char mapping; a few characters lower-case to two code units.
  return lower.length === ch.length ? lower : ch;
}

export function indexPage(items: TextRun[], caseSensitive = false): Indexed {
  let text = '';
  const map: Indexed['map'] = [];
  let lastWasSpace = true; // trims leading whitespace
  const pushSpace = (ref: [number, number] | null) => {
    if (!lastWasSpace) {
      text += ' ';
      map.push(ref);
      lastWasSpace = true;
    }
  };
  items.forEach((item, i) => {
    // Iterate by code unit so offsets match pdf.js string indices.
    for (let j = 0; j < item.str.length; j++) {
      const ch = item.str[j];
      if (WS.test(ch)) pushSpace([i, j]);
      else {
        text += fold(ch, caseSensitive);
        map.push([i, j]);
        lastWasSpace = false;
      }
    }
    if (item.hasEOL) pushSpace(null);
  });
  return { text, map };
}

function normalizeQuery(query: string, caseSensitive: boolean): string {
  const collapsed = query.trim().replace(/\s+/g, ' ');
  return Array.from(collapsed, (c) => fold(c, caseSensitive)).join('');
}

export function toSegments(map: Indexed['map'], from: number, to: number): MatchSegment[] {
  const segs: MatchSegment[] = [];
  for (let k = from; k < to; k++) {
    const ref = map[k];
    if (!ref) continue;
    const [item, off] = ref;
    const last = segs[segs.length - 1];
    if (last && last.item === item && last.end === off) last.end = off + 1;
    else segs.push({ item, start: off, end: off + 1 });
  }
  return segs;
}

export function findInPage(page: number, items: TextRun[], query: string, opts: SearchOptions = {}): Match[] {
  const cs = !!opts.caseSensitive;
  const q = normalizeQuery(query, cs);
  if (!q) return [];
  const { text, map } = indexPage(items, cs);
  const out: Match[] = [];
  let at = text.indexOf(q);
  while (at !== -1) {
    const end = at + q.length;
    const ok =
      !opts.wholeWord ||
      ((at === 0 || !WORD.test(text[at - 1])) && (end === text.length || !WORD.test(text[end])));
    if (ok) out.push({ page, segments: toSegments(map, at, end) });
    at = text.indexOf(q, ok ? end : at + 1);
  }
  return out;
}

export function findAll(pages: TextRun[][], query: string, opts: SearchOptions = {}): Match[] {
  return pages.flatMap((items, page) => findInPage(page, items, query, opts));
}

/** Find regular-expression matches in a page (case handling is up to the pattern's flags). */
export function findRegexInPage(page: number, items: TextRun[], pattern: RegExp): Match[] {
  const { text, map } = indexPage(items, true);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const out: Match[] = [];
  for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
    if (!m[0]) continue;
    out.push({ page, segments: toSegments(map, m.index!, m.index! + m[0].length) });
  }
  return out;
}

/** Common kinds of personal data, for one-click redaction. */
export const SENSITIVE_PATTERNS: { id: string; label: string; one: string; pattern: RegExp }[] = [
  { id: 'email', one: 'Email address', label: 'Email addresses', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'phone', one: 'Phone number', label: 'Phone numbers', pattern: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,5}\)[ .-]?)?\d{2,5}[ .-]\d{3,4}[ .-]?\d{3,4}\b/ },
  { id: 'card', one: 'Card number', label: 'Card numbers', pattern: /\b(?:\d{4}[ -]?){3}\d{4}\b/ },
  { id: 'nino', one: 'National Insurance number', label: 'UK National Insurance numbers', pattern: /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/ },
  { id: 'postcode', one: 'Postcode', label: 'UK postcodes', pattern: /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/ },
  { id: 'iban', one: 'IBAN', label: 'IBANs', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/ },
  { id: 'ssn', one: 'Social Security number', label: 'US Social Security numbers', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
];
