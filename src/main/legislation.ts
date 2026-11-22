/**
 * Checking statutes against legislation.gov.uk, the official UK legislation service (open data, no key).
 * A reference is "verified" only when the Act (or statutory instrument) and the section are found there; the
 * official wording is then kept with it, separate from what the lecturer said.
 */
import { net } from 'electron';
import type { LawCheck } from '../shared/law';

const BASE = 'https://www.legislation.gov.uk';
type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const norm = (s: string): string => s.toLowerCase().replace(/^the\s+/, '').replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');

/** Entries of a legislation.gov.uk search feed: the item's id path (e.g. ukpga/1967/7) and its title. */
export function parseFeed(xml: string): { path: string; title: string }[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap((m) => {
    const id = m[1].match(/<id>https?:\/\/www\.legislation\.gov\.uk\/id\/([^<]+)<\/id>/)?.[1];
    const title = m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1];
    return id && title ? [{ path: id, title: decode(title.trim()) }] : [];
  });
}

/** The item whose title matches the name: exactly with its year when the lecturer gave one, else the newest principal Act of that name. */
export function pickItem(items: { path: string; title: string }[], name: string): { path: string; title: string } | undefined {
  const want = norm(name);
  const exact = items.find((i) => norm(i.title) === want);
  if (exact || /\d{4}$/.test(name.trim())) return exact;
  // No year given: the title must be the name plus a year, e.g. "Sale of Goods Act" -> "Sale of Goods Act 1979".
  return items.filter((i) => new RegExp(`^${want} \\d{4}$`).test(norm(i.title))).sort((a, b) => (/^ukpga\//.test(a.path) ? 0 : 1) - (/^ukpga\//.test(b.path) ? 0 : 1))[0];
}

/** The provision's official text as plain lines: "(1) Where a person…", with nested paragraphs indented. */
export function provisionText(xml: string): { heading: string; text: string } | null {
  const body = xml.match(/<(P1group|P1)\b[\s\S]*<\/\1>/)?.[0] ?? xml.match(/<P2\b[\s\S]*<\/P2>/)?.[0];
  if (!body) return null;
  const heading = decode(body.match(/<Title>([\s\S]*?)<\/Title>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '');
  const text = decode(
    body
      .replace(/<Title>[\s\S]*?<\/Title>/, '')
      .replace(/<(CommentaryRef|FootnoteRef)[^>]*\/>/g, '')
      .replace(/<P([2-6])\b[^>]*>/g, (_m, d) => `\n${'  '.repeat(Number(d) - 2)}`)
      .replace(/<Pnumber[^>]*>([\s\S]*?)<\/Pnumber>/g, '($1) ')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n'),
  )
    .replace(/^\(\w+\)\s*/, '') // the section's own number: the heading says which section it is
    .replace(/\((\w{1,5})\)\s*\n/g, '($1) ')
    // A line break only before a numbered provision; other breaks in the source are just wrapping.
    .replace(/\n(?!\s*\(\w{1,5}\) )/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*\n\s*\n\s*/g, '\n')
    .trim();
  return text ? { heading, text } : null;
}

/** "2(1)(a)" -> ["2", "1", "a"]. */
export const sectionParts = (section: string): string[] => [section.match(/^\s*(\d+[A-Z]*)/i)?.[1] ?? '', ...[...section.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])].filter(Boolean);

const cache = new Map<string, LawCheck>();

/** Look a reference up on legislation.gov.uk. Network failures give status "offline" and are not cached, so a later check can succeed. */
export async function checkLaw(name: string, section: string | undefined, fetcher: Fetch = (url) => net.fetch(url)): Promise<LawCheck> {
  const key = `${norm(name)}|${section ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const at = Date.now();
  try {
    const title = name.replace(/\s*\d{4}\s*$/, '').trim();
    const feed = await fetcher(`${BASE}/search/data.feed?${new URLSearchParams({ title })}`);
    if (!feed.ok) throw new Error(`legislation.gov.uk replied ${feed.status}`);
    const item = pickItem(parseFeed(await feed.text()), name);
    let result: LawCheck;
    if (!item) result = { status: 'not-found', at, note: 'No Act or regulations with this title were found on legislation.gov.uk. The name may have been misheard: check it.' };
    else if (!section) result = { status: 'verified', at, title: item.title, url: `${BASE}/${item.path}` };
    else {
      const parts = sectionParts(section);
      const unit = /^(uksi|ssi|wsi|nisr)\//.test(item.path) ? 'regulation' : 'section';
      // The subsection itself when the lecturer named one; the whole section otherwise (or if the subsection is not separately published).
      let found: { heading: string; text: string } | null = null;
      let url = '';
      for (const depth of parts.length > 1 ? [2, 1] : [1]) {
        const p = `${BASE}/${item.path}/${unit}/${parts.slice(0, depth).join('/')}`;
        const r = await fetcher(`${p}/data.xml`);
        if (r.status === 404) continue;
        if (!r.ok) throw new Error(`legislation.gov.uk replied ${r.status}`);
        found = provisionText(await r.text());
        url = p;
        if (found) break;
      }
      result = found
        ? { status: 'verified', at, title: item.title, url, heading: found.heading, text: found.text.slice(0, 3000) }
        : { status: 'section-missing', at, title: item.title, url: `${BASE}/${item.path}/contents`, note: `${item.title} was found, but it has no ${unit} ${section}. The number may have been misheard: check it.` };
    }
    cache.set(key, result);
    return result;
  } catch (err) {
    return { status: 'offline', at, note: `Could not reach legislation.gov.uk (${(err as Error).message}). Try again when online.` };
  }
}
