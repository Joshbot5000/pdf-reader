import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { materialCases, materialsOutline, readMaterial, relevantPages } from '../src/main/materials';

const fx = (f: string) => path.join(__dirname, 'fixtures', f);

describe('lecture materials', () => {
  it('reads PowerPoint slides in order', async () => {
    const m = await readMaterial(fx('slides.pptx'));
    expect(m.kind).toBe('pptx');
    expect(m.pages).toHaveLength(5);
    expect(m.pages[0]).toMatch(/Offer and Acceptance/);
    expect(m.pages[3]).toMatch(/Hyde v Wrench/);
  });
  it('reads PDF pages', async () => {
    const m = await readMaterial(fx('handout.pdf'));
    expect(m.pages).toHaveLength(2);
    expect(m.pages[1]).toMatch(/counter-offer destroys/);
  });
  it('finds case names on slides, with where they are', async () => {
    const cases = materialCases([await readMaterial(fx('slides.pptx'))]);
    const names = cases.map((c) => c.name);
    expect(names.some((n) => /^Hyde v Wrench/.test(n))).toBe(true);
    expect(names.some((n) => /^Butler Machine Tool/.test(n))).toBe(true);
    expect(cases.find((c) => /^Fisher/.test(c.name))?.where).toBe('slides.pptx, slide 2');
  });
  it('picks the pages that match a question', async () => {
    const mats = [await readMaterial(fx('slides.pptx')), await readMaterial(fx('handout.pdf'))];
    const top = relevantPages(mats, 'what does a counter-offer do to the original offer?', 900);
    expect(top).toMatch(/counter-offer/i);
    expect(top.length).toBeLessThanOrEqual(900);
    expect(materialsOutline(mats, 500).length).toBeLessThanOrEqual(500);
  });
  it('refuses files it cannot read', async () => {
    await expect(readMaterial(fx('nope.key'))).rejects.toThrow(/export as PDF/);
  });
});

describe('Word handouts', () => {
  it('reads paragraphs from a .docx', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { markdownToDocx } = await import('../src/main/docx');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hark-')), 'handout.docx');
    fs.writeFileSync(f, await markdownToDocx('# Remedies\n\nDamages under s 2(1) of the Misrepresentation Act 1967.\n\n- Royscot Trust v Rogerson', 'Remedies'));
    const m = await readMaterial(f);
    expect(m.pages.join('\n')).toMatch(/Royscot Trust v Rogerson/);
    expect(materialCases([m])[0].name).toMatch(/^Royscot Trust v Rogerson/);
  });
});

describe('notes as PDF', () => {
  it('turns markdown notes into printable HTML', async () => {
    const { markdownToHtml } = await import('../src/shared/text');
    const html = markdownToHtml('# Offer\n\n- **Rule**: an offer [1:05]\n  - nested <b>\n1. first\n\n| Case | Point |\n|---|---|\n| Fisher v Bell | display |\n\n> quote', 'Offer');
    expect(html).toContain('<h1>Offer</h1>');
    expect(html).toContain('<li><b>Rule</b>: an offer <code>[1:05]</code></li>');
    expect(html).toMatch(/<ul>\n<li>nested &lt;b&gt;<\/li>\n<\/ul>/);
    expect(html).toContain('<ol>');
    expect(html).toContain('<th>Case</th>');
    expect(html).toContain('<blockquote>quote</blockquote>');
  });
});
