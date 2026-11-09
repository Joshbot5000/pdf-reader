/**
 * Pure PDF editing operations built on pdf-lib.
 *
 * Every operation takes the current document bytes and returns new bytes, so
 * the renderer can keep an undo stack of snapshots and re-render with pdf.js.
 * All coordinates are in PDF user space (points, origin bottom-left of the
 * unrotated page), which the renderer obtains from pdf.js
 * `viewport.convertToPdfPoint`, so page rotation and crop offsets are handled
 * before they reach this module.
 */
import {
  BlendMode,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';

export type Bytes = Uint8Array;
export interface Point {
  x: number;
  y: number;
}
export interface Color {
  r: number;
  g: number;
  b: number;
}

export class EditError extends Error {}

async function load(bytes: Bytes): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) {
      throw new EditError('This PDF is encrypted. It can be viewed but not edited.');
    }
    throw err;
  }
}

function pageAt(doc: PDFDocument, index: number) {
  const count = doc.getPageCount();
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new EditError(`Page ${index + 1} does not exist (document has ${count}).`);
  }
  return doc.getPage(index);
}

const save = (doc: PDFDocument): Promise<Bytes> => doc.save();

/** Throws EditError if the document cannot be edited (e.g. encrypted). */
export async function assertEditable(bytes: Bytes): Promise<void> {
  await load(bytes);
}

// ---------------------------------------------------------------- pages

export async function rotatePage(bytes: Bytes, index: number, delta: 90 | -90 | 180): Promise<Bytes> {
  const doc = await load(bytes);
  const page = pageAt(doc, index);
  const next = (((page.getRotation().angle + delta) % 360) + 360) % 360;
  page.setRotation(degrees(next));
  return save(doc);
}

export async function deletePage(bytes: Bytes, index: number): Promise<Bytes> {
  const doc = await load(bytes);
  pageAt(doc, index);
  if (doc.getPageCount() === 1) throw new EditError('A PDF must keep at least one page.');
  doc.removePage(index);
  return save(doc);
}

/** Move the page at `from` so that it ends up at position `to`. */
export async function movePage(bytes: Bytes, from: number, to: number): Promise<Bytes> {
  const doc = await load(bytes);
  pageAt(doc, from);
  pageAt(doc, to);
  if (from === to) return bytes;
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);
  return save(doc);
}

/** Insert a blank page after `afterIndex` (-1 = at the start), sized like its neighbour. */
export async function insertBlankPage(bytes: Bytes, afterIndex: number): Promise<Bytes> {
  const doc = await load(bytes);
  const ref = doc.getPage(Math.max(0, Math.min(afterIndex, doc.getPageCount() - 1)));
  const { width, height } = ref.getSize();
  doc.insertPage(afterIndex + 1, [width, height]);
  return save(doc);
}

/** Insert every page of `other` after `afterIndex` (-1 = at the start). */
export async function insertPdf(bytes: Bytes, other: Bytes, afterIndex: number): Promise<Bytes> {
  const doc = await load(bytes);
  const src = await load(other);
  const pages = await doc.copyPages(src, src.getPageIndices());
  pages.forEach((p, i) => doc.insertPage(afterIndex + 1 + i, p));
  return save(doc);
}

// ---------------------------------------------------------------- drawing

export interface TextEdit {
  page: number;
  /** Baseline start of each line, in PDF user space. */
  lines: { text: string; at: Point }[];
  size: number;
  color: Color;
}

export async function addText(bytes: Bytes, edit: TextEdit): Promise<Bytes> {
  const doc = await load(bytes);
  const page = pageAt(doc, edit.page);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Counter-rotate so the text reads upright on a rotated page.
  const rotate = degrees(page.getRotation().angle);
  for (const line of edit.lines) {
    if (!line.text) continue;
    try {
      page.drawText(line.text, {
        x: line.at.x,
        y: line.at.y,
        size: edit.size,
        font,
        color: rgb(edit.color.r, edit.color.g, edit.color.b),
        rotate,
      });
    } catch (err) {
      if (err instanceof Error && /cannot encode/i.test(err.message)) {
        throw new EditError(
          'That text contains characters the built-in Helvetica font cannot show (it covers Western European characters only).',
        );
      }
      throw err;
    }
  }
  return save(doc);
}

export interface RectEdit {
  page: number;
  a: Point;
  b: Point;
  kind: 'highlight' | 'whiteout';
  color?: Color;
}

export async function addRect(bytes: Bytes, edit: RectEdit): Promise<Bytes> {
  const doc = await load(bytes);
  const page = pageAt(doc, edit.page);
  const x = Math.min(edit.a.x, edit.b.x);
  const y = Math.min(edit.a.y, edit.b.y);
  const width = Math.abs(edit.a.x - edit.b.x);
  const height = Math.abs(edit.a.y - edit.b.y);
  if (width < 1 || height < 1) return bytes;
  if (edit.kind === 'highlight') {
    const c = edit.color ?? { r: 1, g: 0.92, b: 0.23 };
    page.drawRectangle({
      x, y, width, height,
      color: rgb(c.r, c.g, c.b),
      opacity: 0.4,
      blendMode: BlendMode.Multiply,
    });
  } else {
    page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1) });
  }
  return save(doc);
}

export interface InkEdit {
  page: number;
  points: Point[];
  width: number;
  color: Color;
}

export async function addInk(bytes: Bytes, edit: InkEdit): Promise<Bytes> {
  if (edit.points.length < 2) return bytes;
  const doc = await load(bytes);
  const page = pageAt(doc, edit.page);
  const color = rgb(edit.color.r, edit.color.g, edit.color.b);
  for (let i = 1; i < edit.points.length; i++) {
    page.drawLine({
      start: edit.points[i - 1],
      end: edit.points[i],
      thickness: edit.width,
      color,
      lineCap: 1, // round, so segments join smoothly
    });
  }
  return save(doc);
}

// ---------------------------------------------------------------- forms

export type FormField =
  | { name: string; type: 'text'; value: string; multiline: boolean; readOnly: boolean }
  | { name: string; type: 'checkbox'; value: boolean; readOnly: boolean }
  | { name: string; type: 'choice'; value: string; options: string[]; readOnly: boolean };

export async function getFormFields(bytes: Bytes): Promise<FormField[]> {
  let doc: PDFDocument;
  try {
    doc = await load(bytes);
  } catch {
    return [];
  }
  const out: FormField[] = [];
  for (const f of doc.getForm().getFields()) {
    const name = f.getName();
    const readOnly = f.isReadOnly();
    if (f instanceof PDFTextField) {
      out.push({ name, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline(), readOnly });
    } else if (f instanceof PDFCheckBox) {
      out.push({ name, type: 'checkbox', value: f.isChecked(), readOnly });
    } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
      out.push({ name, type: 'choice', value: f.getSelected()[0] ?? '', options: f.getOptions(), readOnly });
    } else if (f instanceof PDFRadioGroup) {
      out.push({ name, type: 'choice', value: f.getSelected() ?? '', options: f.getOptions(), readOnly });
    }
    // Buttons and signature fields are not editable here.
  }
  return out;
}

export async function setFormFields(bytes: Bytes, values: Record<string, string | boolean>): Promise<Bytes> {
  const doc = await load(bytes);
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f || f.isReadOnly()) continue;
    if (f instanceof PDFTextField) f.setText(String(value));
    else if (f instanceof PDFCheckBox) (value ? f.check() : f.uncheck());
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) {
      if (value === '') f.clear();
      else f.select(String(value));
    }
  }
  return save(doc);
}
