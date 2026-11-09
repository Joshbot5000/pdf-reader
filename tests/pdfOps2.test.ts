import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as ops from '../src/shared/pdfOps';
import { makePdf, widths } from './fixtures';

// 2x1 opaque PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwnwEIGGAMAEX6Bfu6Ai1UAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

async function pageText(bytes: Uint8Array, page = 0): Promise<string> {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const content = await (await doc.getPage(page + 1)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

describe('visualFrame', () => {
  it('maps the visual bottom-left corner for every rotation', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 100]);
    const expectations: Record<number, [number, number, number, number]> = {
      0: [200, 100, 0, 0],
      90: [100, 200, 200, 0],
      180: [200, 100, 200, 100],
      270: [100, 200, 0, 100],
    };
    for (const [rot, [w, h, x, y]] of Object.entries(expectations)) {
      page.setRotation(degrees(Number(rot)));
      const f = ops.visualFrame(page);
      expect([f.width, f.height]).toEqual([w, h]);
      expect(f.toUser(0, 0)).toEqual({ x, y });
    }
  });
});

describe('images and branding', () => {
  it('draws an image and rejects other formats', async () => {
    const b = await ops.addImage(await makePdf(1), { page: 0, image: PNG, at: { x: 10, y: 10 }, width: 40, height: 20 });
    expect((await PDFDocument.load(b)).getPageCount()).toBe(1);
    await expect(
      ops.addImage(await makePdf(1), { page: 0, image: new Uint8Array([1, 2, 3]), at: { x: 0, y: 0 }, width: 1, height: 1 }),
    ).rejects.toThrow(/PNG or JPEG/);
  });

  it('stamps text and a clickable link on every page', async () => {
    const b = await ops.applyBrand(await makePdf(2), {
      logo: PNG, url: 'example.com', text: 'Acme Legal', position: 'bottom-right', logoHeight: 24, pages: 'all',
    });
    for (const i of [0, 1]) {
      expect(await pageText(b, i)).toMatch(/Acme Legal.*example\.com/);
      const annots = (await PDFDocument.load(b)).getPage(i).node.Annots();
      expect(annots?.size()).toBe(1);
    }
  });

  it('requires something to stamp', async () => {
    await expect(
      ops.applyBrand(await makePdf(1), { logo: null, url: ' ', text: '', position: 'top-left', logoHeight: 20, pages: 'all' }),
    ).rejects.toThrow(/logo, text or a URL/);
  });
});

describe('form building and templates', () => {
  it('creates fields, reads their layout back and removes them', async () => {
    let b = await ops.createFields(await makePdf(2), [
      { type: 'text', name: 'Name', page: 0, rect: { x: 50, y: 500, width: 200, height: 20 } },
      { type: 'checkbox', name: 'Agree', page: 1, rect: { x: 50, y: 450, width: 14, height: 14 } },
      { type: 'dropdown', name: 'Plan', page: 1, rect: { x: 50, y: 400, width: 120, height: 20 }, options: ['A', 'B'] },
      { type: 'signature', name: 'Signature', page: 1, rect: { x: 50, y: 300, width: 180, height: 36 } },
      { type: 'text', name: 'Name', page: 0, rect: { x: 50, y: 470, width: 200, height: 20 } },
    ]);
    const layout = await ops.getFieldLayouts(b);
    expect(layout.map((f) => [f.name, f.type, f.page])).toEqual([
      ['Name', 'text', 0],
      ['Agree', 'checkbox', 1],
      ['Plan', 'dropdown', 1],
      ['Signature', 'signature', 1],
      ['Name 2', 'text', 0],
    ]);
    expect(layout[2].options).toEqual(['A', 'B']);
    expect(layout[0].rect).toEqual({ x: 50, y: 500, width: 200, height: 20 });

    // Re-applying the layout to a fresh document reproduces it.
    const again = await ops.createFields(await makePdf(2), layout);
    expect((await ops.getFieldLayouts(again)).map((f) => f.name)).toEqual(layout.map((f) => f.name));

    b = await ops.removeField(b, 'Plan');
    expect((await ops.getFormFields(b)).map((f) => f.name)).not.toContain('Plan');
  });
});

describe('redaction', () => {
  it('replaces the page with an image so the original text is gone', async () => {
    const before = await makePdf(2);
    expect(await pageText(before, 0)).toContain('Page 1');
    let b = await ops.replacePageWithImage(before, 0, PNG);
    b = await ops.scrubMetadata(b);
    expect(await pageText(b, 0)).toBe('');
    expect(await pageText(b, 1)).toContain('Page 2');
    expect(await widths(b)).toEqual([600, 601]);
    const doc = await PDFDocument.load(b, { updateMetadata: false });
    expect(doc.getTitle() ?? '').toBe('');
    expect(doc.catalog.get(doc.context.obj('Metadata') as never)).toBeUndefined();
  });
});

describe('OCR text layer', () => {
  it('adds invisible text that pdf.js can extract', async () => {
    const b = await ops.addInvisibleText(await makePdf(1), 0, [
      { text: 'Donoghue', at: { x: 50, y: 300 }, width: 90, height: 14 },
      { text: 'v', at: { x: 145, y: 300 }, width: 8, height: 14 },
      { text: 'Stevenson’s', at: { x: 158, y: 300 }, width: 100, height: 14 },
      { text: '漢字', at: { x: 300, y: 300 }, width: 30, height: 14 },
    ]);
    expect(await pageText(b)).toMatch(/Donoghue\s*v\s*Stevenson's/);
  });
});

describe('extractPages', () => {
  it('builds a new PDF from selected pages in order', async () => {
    expect(await widths(await ops.extractPages(await makePdf(4), [3, 1]))).toEqual([603, 601]);
  });
});
