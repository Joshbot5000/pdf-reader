import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseContent, replaceText, inspectTextStyle } from '../src/shared/textEdit';
import { addInvisibleText } from '../src/shared/pdfOps';

const enc = (s: string) => new TextEncoder().encode(s);

async function items(bytes: Uint8Array, page = 0) {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const content = await (await doc.getPage(page + 1)).getTextContent();
  return content.items.flatMap((i) => ('str' in i && i.str.trim() ? [{ str: i.str, x: i.transform[4], y: i.transform[5] }] : []));
}
const text = async (b: Uint8Array) => (await items(b)).map((i) => i.str).join(' ');

/** A page whose content stream we write by hand (font resource /F1 = Helvetica). */
async function rawPage(stream: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(stream)));
  return doc.save();
}

describe('parseContent', () => {
  it('tokenizes operators, strings with escapes, arrays and inline images', () => {
    const ops = parseContent(enc('q 1 0 0 1 5 5 cm BT /F1 12 Tf (a\\(b\\)c \\101) Tj [(x) -250 <4142>] TJ ET BI /W 2 /H 1 ID \x00EI\xff EI Q % comment\n0.5 g'));
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q', 'g']);
    const tj = ops[4].args[0];
    expect(tj.t === 'str' && new TextDecoder().decode(tj.v)).toBe('a(b)c A');
    const arr = ops[5].args[0];
    expect(arr.t === 'arr' && arr.v.map((t) => t.t)).toEqual(['str', 'num', 'str']);
  });
});

describe('replaceText', () => {
  it('replaces a paragraph drawn by pdf-lib and keeps other text', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const font = await doc.embedFont(StandardFonts.TimesRomanBold);
    page.drawText('Original heading', { x: 50, y: 700, size: 20, font, color: rgb(0.2, 0.1, 0.6) });
    page.drawText('Body text stays', { x: 50, y: 600, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    const before = await doc.save();

    const box = { page: 0, box: { x: 48, y: 695, width: 200, height: 22 } };
    expect(await inspectTextStyle(before, box)).toMatchObject({ fontSize: 20, family: 'serif', bold: true, italic: false });

    const r = await replaceText(before, { ...box, text: 'New heading' });
    expect(r.method).toBe('edited');
    expect(r.removed).toBe(1);
    const after = await items(r.bytes);
    expect(after.map((i) => i.str)).toEqual(['Body text stays', 'New heading']);
    const heading = after.find((i) => i.str === 'New heading')!;
    expect(heading.x).toBeCloseTo(50, 1);
    expect(heading.y).toBeCloseTo(700, 1);
  });

  it('removes text when the new text is empty', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.drawText('Delete me', { x: 50, y: 700, size: 14 });
    const r = await replaceText(await doc.save(), { page: 0, box: { x: 45, y: 695, width: 120, height: 20 }, text: '' });
    expect(await text(r.bytes)).toBe('');
  });

  it('keeps later text on the same line in place when earlier text is removed', async () => {
    const before = await rawPage('BT /F1 12 Tf 50 300 Td (Hello ) Tj (World) Tj ET');
    const world = (await items(before)).find((i) => i.str.includes('World'));
    const r = await replaceText(before, { page: 0, box: { x: 49, y: 297, width: 20, height: 14 }, text: '' });
    const after = await items(r.bytes);
    expect(after.map((i) => i.str)).toEqual(['World']);
    // pdf.js may merge "Hello World" into one item; the World run started after "Hello ".
    expect(after[0].x).toBeGreaterThan(70);
    if (world && world.str === 'World') expect(after[0].x).toBeCloseTo(world.x, 1);
  });

  it('tracks TD, T*, quote operators and the CTM', async () => {
    const before = await rawPage('q 2 0 0 2 0 0 cm BT /F1 10 Tf 12 TL 20 100 Td (Line one) Tj T* (Line two) Tj (Line three) \' ET Q');
    // CTM doubles everything: line two baseline is at (100 - 12) * 2 = 176.
    const r = await replaceText(before, { page: 0, box: { x: 35, y: 170, width: 150, height: 16 }, text: 'Second' });
    const after = await items(r.bytes);
    expect(after.map((i) => i.str).sort()).toEqual(['Line one', 'Line three', 'Second']);
    const second = after.find((i) => i.str === 'Second')!;
    expect(second.x).toBeCloseTo(40, 1);
    expect(second.y).toBeCloseTo(176, 1);
  });

  it('covers text it cannot remove (OCR layer over a scan) and draws the new text', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const withOcr = await addInvisibleText(await doc.save(), 0, [{ text: 'Scanned', at: { x: 50, y: 700 }, width: 70, height: 14 }]);
    const r = await replaceText(withOcr, { page: 0, box: { x: 45, y: 695, width: 90, height: 20 }, text: 'Typed' });
    expect(r.method).toBe('covered');
    expect(await text(r.bytes)).toBe('Typed');
  });

  it('rejects characters the standard fonts cannot encode', async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText('Hi', { x: 50, y: 700, size: 12 });
    await expect(replaceText(await doc.save(), { page: 0, box: { x: 45, y: 695, width: 40, height: 20 }, text: '你好' })).rejects.toThrow(/standard fonts/);
  });
});

describe('matching the original font', () => {
  const fontPath = 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf';

  /** A PDF using an embedded *subset* font, like most PDFs from Word or a browser. */
  async function subsetPdf(text: string) {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const { readFileSync } = await import('node:fs');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(fontPath), { subset: true });
    doc.addPage([600, 800]).drawText(text, { x: 50, y: 700, size: 14, font });
    return doc.save();
  }
  const fontsOf = async (b: Uint8Array) => {
    const doc = await PDFDocument.load(b);
    const res = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font')) as any;
    return res.keys().map((k: any) => (doc.context.lookup(res.get(k)) as any).get(PDFName.of('BaseFont')).decodeText());
  };
  const box = { page: 0, box: { x: 45, y: 695, width: 300, height: 20 } };

  it('reuses the embedded subset font when it has every character', async () => {
    const before = await subsetPdf('Payment is due within thirty days');
    const r = await replaceText(before, { ...box, text: 'Payment is due within ten days' });
    expect(r.font.kind).toBe('original');
    expect(await text(r.bytes)).toBe('Payment is due within ten days');
    expect(await fontsOf(r.bytes)).toHaveLength(1); // no second font added
  });

  it('uses the same typeface from the computer when the subset lacks a character', async () => {
    const { readFileSync } = await import('node:fs');
    const before = await subsetPdf('Payment is due');
    const r = await replaceText(before, { ...box, text: 'Payment is quick', fontData: readFileSync(fontPath) });
    expect(r.font.kind).toBe('system');
    expect(r.font.name).toMatch(/LiberationSans/);
    expect(await text(r.bytes)).toBe('Payment is quick');
  });

  it('falls back to a standard font when no matching font is available', async () => {
    const before = await subsetPdf('Payment is due');
    const r = await replaceText(before, { ...box, text: 'Payment is quick' });
    expect(r.font.kind).toBe('standard');
    expect(await text(r.bytes)).toBe('Payment is quick');
  });

  it('parses ToUnicode bfchar and bfrange entries', async () => {
    const { parseToUnicode } = await import('../src/shared/textEdit');
    const map = parseToUnicode('beginbfchar\n<0003> <0020>\nendbfchar\nbeginbfrange\n<0010> <0012> <0041>\n<0020> <0021> [<0061> <0062>]\nendbfrange');
    expect([...map]).toEqual([[' ', 3], ['A', 16], ['B', 17], ['C', 18], ['a', 32], ['b', 33]]);
  });
});
