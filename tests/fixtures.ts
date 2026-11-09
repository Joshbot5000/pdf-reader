import { PDFDocument, StandardFonts } from 'pdf-lib';

/** A small PDF whose pages say "Page 1", "Page 2", ... with distinct widths. */
export async function makePdf(pages = 3, opts: { form?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([600 + i, 800]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 24, font });
  }
  if (opts.form) {
    const form = doc.getForm();
    const page = doc.getPage(0);
    form.createTextField('name').addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
    form.createCheckBox('agree').addToPage(page, { x: 50, y: 560, width: 16, height: 16 });
    const dd = form.createDropdown('colour');
    dd.addOptions(['Red', 'Green', 'Blue']);
    dd.addToPage(page, { x: 50, y: 520, width: 120, height: 24 });
  }
  return doc.save();
}

export const widths = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));
