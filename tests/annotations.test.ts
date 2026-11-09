import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addHighlightAnnotation, addInkAnnotation, distanceTo, listOwnAnnotations, removeOwnAnnotations } from '../src/shared/annotations';
import { makePdf } from './fixtures';

const red = { r: 1, g: 0, b: 0 };

async function pdfjsAnnots(bytes: Uint8Array, page = 0) {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return (await doc.getPage(page + 1)).getAnnotations();
}

describe('annotations', () => {
  it('adds ink and highlight annotations that pdf.js can render, leaving page content alone', async () => {
    const before = await makePdf(2);
    const contentBefore = (await PDFDocument.load(before)).getPage(1).node.Contents()?.toString();
    let b = await addInkAnnotation(before, { page: 1, strokes: [[{ x: 10, y: 10 }, { x: 50, y: 40 }, { x: 90, y: 10 }]], width: 2, color: red });
    b = await addHighlightAnnotation(b, { page: 1, a: { x: 40, y: 690 }, b: { x: 200, y: 730 }, color: { r: 1, g: 0.9, b: 0.2 } });
    const annots = await pdfjsAnnots(b, 1);
    expect(annots.map((a) => a.subtype).sort()).toEqual(['Highlight', 'Ink']);
    expect(annots.every((a) => a.hasAppearance)).toBe(true);
    expect((await PDFDocument.load(b)).getPage(1).node.Contents()?.toString()).toBe(contentBefore);
    const own = await listOwnAnnotations(b);
    expect(own.map((a) => [a.page, a.kind])).toEqual([[1, 'ink'], [1, 'highlight']]);
    expect(own[0].strokes[0]).toHaveLength(3);
    expect(own[0].width).toBe(2);
  });

  it('erases only annotations made in this app', async () => {
    let b = await addInkAnnotation(await makePdf(1), { page: 0, strokes: [[{ x: 10, y: 10 }, { x: 30, y: 30 }]], width: 3, color: red });
    // Someone else's comment on the same page.
    const doc = await PDFDocument.load(b);
    const foreign = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [0, 0, 50, 50], InkList: [[10, 10, 30, 30]], NM: PDFString.of('acrobat-123') }));
    doc.getPage(0).node.addAnnot(foreign);
    b = await doc.save();
    const own = await listOwnAnnotations(b);
    expect(own).toHaveLength(1);
    const after = await removeOwnAnnotations(b, [own[0].ref, foreign.toString()]);
    const left = (await PDFDocument.load(after)).getPage(0).node.Annots()!.asArray();
    expect(left).toHaveLength(1);
    expect(left[0].toString()).toBe(foreign.toString());
    expect(await listOwnAnnotations(after)).toEqual([]);
  });

  it('measures distance to strokes and highlight boxes', async () => {
    const b = await addInkAnnotation(await makePdf(1), { page: 0, strokes: [[{ x: 0, y: 0 }, { x: 100, y: 0 }]], width: 4, color: red });
    const [ink] = await listOwnAnnotations(b);
    expect(distanceTo(ink, { x: 50, y: 1 })).toBe(0);
    expect(distanceTo(ink, { x: 50, y: 12 })).toBeCloseTo(10);
    const h = await addHighlightAnnotation(await makePdf(1), { page: 0, a: { x: 0, y: 0 }, b: { x: 10, y: 10 }, color: red });
    const [hl] = await listOwnAnnotations(h);
    expect(distanceTo(hl, { x: 5, y: 5 })).toBe(0);
    expect(distanceTo(hl, { x: 13, y: 14 })).toBeCloseTo(5);
    expect((await PDFDocument.load(h)).getPage(0).node.Annots()?.size()).toBe(1);
    expect(PDFName.of('Highlight')).toBeTruthy();
  });
});
