import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as ops from '../src/shared/pdfOps';
import { makePdf, widths } from './fixtures';

describe('page operations', () => {
  it('rotates a page and wraps at 360', async () => {
    let b = await makePdf(2);
    b = await ops.rotatePage(b, 1, 90);
    b = await ops.rotatePage(b, 1, -90);
    b = await ops.rotatePage(b, 1, -90);
    const doc = await PDFDocument.load(b);
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getRotation().angle).toBe(270);
  });

  it('deletes a page but refuses to delete the last one', async () => {
    const b = await ops.deletePage(await makePdf(3), 1);
    expect(await widths(b)).toEqual([600, 602]);
    await expect(ops.deletePage(await makePdf(1), 0)).rejects.toBeInstanceOf(ops.EditError);
  });

  it('moves pages forwards and backwards', async () => {
    const b = await makePdf(4);
    expect(await widths(await ops.movePage(b, 0, 2))).toEqual([601, 602, 600, 603]);
    expect(await widths(await ops.movePage(b, 3, 0))).toEqual([603, 600, 601, 602]);
  });

  it('rejects out-of-range pages', async () => {
    await expect(ops.rotatePage(await makePdf(1), 5, 90)).rejects.toThrow(/does not exist/);
  });

  it('inserts a blank page sized like its neighbour', async () => {
    const b = await ops.insertBlankPage(await makePdf(2), 0);
    expect(await widths(b)).toEqual([600, 600, 601]);
    expect(await widths(await ops.insertBlankPage(await makePdf(2), -1))).toEqual([600, 600, 601]);
  });

  it('inserts pages from another PDF', async () => {
    const b = await ops.insertPdf(await makePdf(2), await makePdf(1), 0);
    expect(await widths(b)).toEqual([600, 600, 601]);
  });
});

describe('drawing', () => {
  const red = { r: 1, g: 0, b: 0 };

  it('adds text, highlights, white-out and ink to the page content', async () => {
    const before = await makePdf(1);
    let b = await ops.addText(before, { page: 0, lines: [{ text: 'Hello', at: { x: 50, y: 400 } }], size: 12, color: red });
    b = await ops.addRect(b, { page: 0, a: { x: 10, y: 10 }, b: { x: 100, y: 40 }, kind: 'highlight' });
    b = await ops.addRect(b, { page: 0, a: { x: 10, y: 50 }, b: { x: 100, y: 80 }, kind: 'whiteout' });
    b = await ops.addInk(b, { page: 0, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 2 }], width: 2, color: red });
    expect(b.byteLength).toBeGreaterThan(before.byteLength);
    expect((await PDFDocument.load(b)).getPageCount()).toBe(1);
  });

  it('ignores zero-size rectangles and single-point ink', async () => {
    const b = await makePdf(1);
    expect(await ops.addRect(b, { page: 0, a: { x: 5, y: 5 }, b: { x: 5, y: 50 }, kind: 'highlight' })).toBe(b);
    expect(await ops.addInk(b, { page: 0, points: [{ x: 1, y: 1 }], width: 2, color: red })).toBe(b);
  });

  it('explains when text cannot be encoded by Helvetica', async () => {
    await expect(
      ops.addText(await makePdf(1), { page: 0, lines: [{ text: '你好', at: { x: 0, y: 0 } }], size: 12, color: red }),
    ).rejects.toThrow(/Helvetica/);
  });
});

describe('forms', () => {
  it('reads and fills text, checkbox and choice fields', async () => {
    const b = await makePdf(1, { form: true });
    expect(await ops.getFormFields(b)).toEqual([
      { name: 'name', type: 'text', value: '', multiline: false, readOnly: false },
      { name: 'agree', type: 'checkbox', value: false, readOnly: false },
      { name: 'colour', type: 'choice', value: '', options: ['Red', 'Green', 'Blue'], readOnly: false },
    ]);
    const filled = await ops.setFormFields(b, { name: 'Josh', agree: true, colour: 'Green', missing: 'x' });
    const values = Object.fromEntries((await ops.getFormFields(filled)).map((f) => [f.name, f.value]));
    expect(values).toEqual({ name: 'Josh', agree: true, colour: 'Green' });
  });

  it('returns no fields for a PDF without a form', async () => {
    expect(await ops.getFormFields(await makePdf(1))).toEqual([]);
  });
});
