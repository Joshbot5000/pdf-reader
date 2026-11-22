import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkLaw, parseFeed, pickItem, provisionText, sectionParts } from '../src/main/legislation';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const res = (status: number, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('checking statutes on legislation.gov.uk', () => {
  it('reads the search feed and picks the right Act', () => {
    const items = parseFeed(fx('leg-feed.xml'));
    expect(items).toContainEqual({ path: 'ukpga/1967/7', title: 'Misrepresentation Act 1967' });
    expect(items.some((i) => i.path.startsWith('apni/'))).toBe(true); // the Northern Ireland Act is listed too, and must not be picked
    expect(pickItem(items, 'Misrepresentation Act 1967')?.path).toBe('ukpga/1967/7');
    expect(pickItem(items, 'Misrepresentation Act')?.path).toBe('ukpga/1967/7');
    expect(pickItem(items, 'Misrepresentation Act 1999')).toBeUndefined();
    expect(pickItem([{ path: 'ukpga/1995/28', title: 'Sale of Goods (Amendment) Act 1995' }, { path: 'ukpga/1979/54', title: 'Sale of Goods Act 1979' }], 'Sale of Goods Act')?.path).toBe('ukpga/1979/54');
  });
  it('turns a section into readable official text', () => {
    const p = provisionText(fx('leg-section.xml'))!;
    expect(p.heading).toBe('Damages for misrepresentation.');
    expect(p.text).toMatch(/^\(1\) Where a person has entered into a contract/);
    expect(p.text).toMatch(/\n\(2\) Where a person/);
    expect(sectionParts('2(1)(a)')).toEqual(['2', '1', 'a']);
  });
  it('verifies a section, and falls back to the whole section when the subsection has no page', async () => {
    const urls: string[] = [];
    const fetcher = async (u: string) => {
      urls.push(u);
      if (u.includes('/search/')) return res(200, fx('leg-feed.xml'));
      if (u.endsWith('/section/2/1/data.xml')) return res(404);
      if (u.endsWith('/section/2/data.xml')) return res(200, fx('leg-section.xml'));
      return res(404);
    };
    const c = await checkLaw('Misrepresentation Act 1967', '2(1)', fetcher);
    expect(c).toMatchObject({ status: 'verified', title: 'Misrepresentation Act 1967', url: 'https://www.legislation.gov.uk/ukpga/1967/7/section/2', heading: 'Damages for misrepresentation.' });
    expect(urls[0]).toContain('title=Misrepresentation+Act');
  });
  it('says so when a section or Act does not exist, and when offline', async () => {
    const fetcher = async (u: string) => (u.includes('/search/') ? res(200, fx('leg-feed.xml')) : res(404));
    expect((await checkLaw('Misrepresentation Act 1967', '99', fetcher)).status).toBe('section-missing');
    expect((await checkLaw('Misrepresentashun Act 1867', undefined, async () => res(200, '<feed></feed>'))).status).toBe('not-found');
    const off = await checkLaw('Sale of Goods Act 1979', '14', async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    expect(off.status).toBe('offline');
  });
});
