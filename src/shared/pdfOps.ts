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
  PDFDict,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
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

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

// ---------------------------------------------------------------- images, links & stamps

/**
 * Map a point given in the page's *visual* frame (points from the visual
 * bottom-left, after /Rotate is applied) to user space.
 */
export function visualFrame(page: PDFPage) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const { x: x0, y: y0, width: w, height: h } = box;
  const swap = rot === 90 || rot === 270;
  return {
    width: swap ? h : w,
    height: swap ? w : h,
    rotation: rot,
    toUser(vx: number, vy: number): Point {
      switch (rot) {
        case 90:
          return { x: x0 + w - vy, y: y0 + vx };
        case 180:
          return { x: x0 + w - vx, y: y0 + h - vy };
        case 270:
          return { x: x0 + vy, y: y0 + h - vx };
        default:
          return { x: x0 + vx, y: y0 + vy };
      }
    },
  };
}

async function embedImage(doc: PDFDocument, data: Bytes) {
  const isPng = data[0] === 0x89 && data[1] === 0x50;
  const isJpg = data[0] === 0xff && data[1] === 0xd8;
  if (isPng) return doc.embedPng(data);
  if (isJpg) return doc.embedJpg(data);
  throw new EditError('Images must be PNG or JPEG.');
}

export interface ImageEdit {
  page: number;
  image: Bytes;
  /** Visual bottom-left corner of the image, in user space. */
  at: Point;
  /** Visual size in points. */
  width: number;
  height: number;
}

/** Draw an image (signature, stamp, logo) upright on a possibly rotated page. */
export async function addImage(bytes: Bytes, edit: ImageEdit): Promise<Bytes> {
  const doc = await load(bytes);
  const page = pageAt(doc, edit.page);
  const img = await embedImage(doc, edit.image);
  page.drawImage(img, {
    x: edit.at.x,
    y: edit.at.y,
    width: edit.width,
    height: edit.height,
    rotate: degrees(page.getRotation().angle),
  });
  return save(doc);
}

function addLinkAnnotation(doc: PDFDocument, page: PDFPage, rect: [number, number, number, number], url: string) {
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
  });
  page.node.addAnnot(doc.context.register(annot));
}

export interface BrandOptions {
  logo: Bytes | null;
  url: string;
  text: string;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  logoHeight: number;
  pages: 'all' | 'first';
}

/** Stamp a logo, a line of text and a clickable URL in a corner of each page. */
export async function applyBrand(bytes: Bytes, opts: BrandOptions): Promise<Bytes> {
  if (!opts.logo && !opts.url.trim() && !opts.text.trim()) throw new EditError('Add a logo, text or a URL first.');
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = opts.logo ? await embedImage(doc, opts.logo) : null;
  const url = opts.url.trim();
  const href = url && !/^https?:\/\//i.test(url) ? `https://${url}` : url;
  const pages = opts.pages === 'first' ? [doc.getPage(0)] : doc.getPages();
  const margin = 28;
  const textSize = 9;
  const top = opts.position.startsWith('top');
  const right = opts.position.endsWith('right');

  for (const page of pages) {
    const frame = visualFrame(page);
    const rotate = degrees(frame.rotation);
    const logoH = logo ? opts.logoHeight : 0;
    const logoW = logo ? (logo.width / logo.height) * logoH : 0;
    const lines = [opts.text.trim(), url].filter(Boolean);
    const lineW = lines.map((l, i) => (i === 0 && opts.text.trim() ? bold : font).widthOfTextAtSize(l, textSize));
    const textW = Math.max(0, ...lineW);
    const gap = logo && lines.length ? 8 : 0;
    const blockW = logoW + gap + textW;
    const blockH = Math.max(logoH, lines.length * (textSize + 3));
    const vx = right ? frame.width - margin - blockW : margin;
    const vy = top ? frame.height - margin - blockH : margin;

    if (logo) {
      const at = frame.toUser(vx, vy + (blockH - logoH) / 2);
      page.drawImage(logo, { x: at.x, y: at.y, width: logoW, height: logoH, rotate });
    }
    lines.forEach((line, i) => {
      const isTitle = i === 0 && !!opts.text.trim();
      const lx = vx + logoW + gap + (right ? textW - lineW[i] : 0);
      const totalH = lines.length * (textSize + 3);
      const ly = vy + (blockH - totalH) / 2 + (lines.length - 1 - i) * (textSize + 3) + 2;
      const at = frame.toUser(lx, ly);
      page.drawText(line, {
        x: at.x,
        y: at.y,
        size: textSize,
        font: isTitle ? bold : font,
        color: isTitle ? rgb(0.13, 0.13, 0.18) : rgb(0.33, 0.24, 0.85),
        rotate,
      });
      if (line === url && href) {
        const a = frame.toUser(lx, ly - 2);
        const b = frame.toUser(lx + lineW[i], ly + textSize);
        addLinkAnnotation(doc, page, [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)], href);
      }
    });
  }
  return save(doc);
}

// ---------------------------------------------------------------- form building

export type NewFieldType = 'text' | 'checkbox' | 'dropdown' | 'signature';

export interface NewField {
  type: NewFieldType;
  name: string;
  page: number;
  rect: Rect;
  options?: string[];
}

function uniqueName(doc: PDFDocument, base: string): string {
  const form = doc.getForm();
  let name = base;
  for (let i = 2; form.getFieldMaybe(name); i++) name = `${base} ${i}`;
  return name;
}

/** Create AcroForm fields. Signature placeholders are text fields named "Signature…". */
export async function createFields(bytes: Bytes, fields: NewField[]): Promise<Bytes> {
  const doc = await load(bytes);
  const form = doc.getForm();
  for (const f of fields) {
    const page = pageAt(doc, f.page);
    const name = uniqueName(doc, f.name.trim() || f.type);
    const opts = { x: f.rect.x, y: f.rect.y, width: f.rect.width, height: f.rect.height, rotate: page.getRotation() };
    if (f.type === 'checkbox') {
      form.createCheckBox(name).addToPage(page, { ...opts, borderColor: rgb(0.45, 0.4, 0.95) });
    } else if (f.type === 'dropdown') {
      const dd = form.createDropdown(name);
      dd.addOptions(f.options?.length ? f.options : ['Option 1', 'Option 2']);
      dd.addToPage(page, { ...opts, borderColor: rgb(0.45, 0.4, 0.95) });
    } else {
      const tf = form.createTextField(name);
      tf.addToPage(page, {
        ...opts,
        borderColor: rgb(0.45, 0.4, 0.95),
        backgroundColor: f.type === 'signature' ? rgb(0.96, 0.95, 1) : undefined,
      });
      if (f.type === 'signature') tf.setFontSize(Math.max(8, Math.min(18, f.rect.height * 0.55)));
    }
  }
  return save(doc);
}

export async function removeField(bytes: Bytes, name: string): Promise<Bytes> {
  const doc = await load(bytes);
  const form = doc.getForm();
  const field = form.getFieldMaybe(name);
  if (!field) return bytes;
  form.removeField(field);
  return save(doc);
}

/** Positions of every widget, for saving a reusable template. */
export async function getFieldLayouts(bytes: Bytes): Promise<NewField[]> {
  let doc: PDFDocument;
  try {
    doc = await load(bytes);
  } catch {
    return [];
  }
  const pageIndex = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageIndex.set(p.ref.toString(), i));
  const out: NewField[] = [];
  for (const field of doc.getForm().getFields()) {
    const type: NewFieldType | null =
      field instanceof PDFCheckBox
        ? 'checkbox'
        : field instanceof PDFDropdown
          ? 'dropdown'
          : field instanceof PDFTextField
            ? /^signature/i.test(field.getName()) ? 'signature' : 'text'
            : null;
    if (!type) continue;
    for (const widget of field.acroField.getWidgets()) {
      const pRef = widget.P();
      let page = pRef instanceof PDFRef ? pageIndex.get(pRef.toString()) : undefined;
      if (page === undefined) {
        // Widgets without /P: find the page that lists this widget.
        const wRef = doc.context.getObjectRef(widget.dict);
        page = doc.getPages().findIndex((p) => p.node.Annots()?.asArray().some((a) => a === wRef));
      }
      if (page === undefined || page < 0) continue;
      // pdf-lib grows the widget rectangle by half the border width on each
      // side; undo that so re-applying a template keeps the same size.
      const r = widget.getRectangle();
      const inset = (widget.getBorderStyle()?.getWidth() ?? 0) / 2;
      out.push({
        type,
        name: field.getName(),
        page,
        rect: { x: r.x + inset, y: r.y + inset, width: r.width - 2 * inset, height: r.height - 2 * inset },
        options: field instanceof PDFDropdown ? field.getOptions() : undefined,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- redaction

/**
 * Replace a page with a flattened image of itself. Used to apply redactions:
 * the original text, vectors and images on the page are discarded, so the
 * redacted content cannot be recovered from the file.
 */
export async function replacePageWithImage(bytes: Bytes, index: number, png: Bytes): Promise<Bytes> {
  const doc = await load(bytes);
  const old = pageAt(doc, index);
  const { width, height } = visualFrame(old);
  const img = await doc.embedPng(png);
  // Remove the old page first so its form widgets go with it.
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const onPage = field.acroField.getWidgets().some((w) => w.P() === old.ref);
    if (onPage) form.removeField(field);
  }
  doc.removePage(index);
  const page = doc.insertPage(index, [width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });
  return save(doc);
}

/** Clear document metadata (title, author, XMP) that can leak redacted information. */
export async function scrubMetadata(bytes: Bytes): Promise<Bytes> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setCreator('');
  doc.setProducer('');
  doc.catalog.delete(PDFName.of('Metadata'));
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const key of info.keys()) info.delete(key);
  }
  return doc.save();
}

// ---------------------------------------------------------------- OCR text layer

export interface OcrPlacement {
  text: string;
  /** Visual bottom-left of the word's box, in user space. */
  at: Point;
  /** Visual width and height of the word's box, in points. */
  width: number;
  height: number;
}

/** Keep only characters Helvetica (WinAnsi) can encode. */
function winAnsi(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '');
}

/**
 * Add invisible, selectable text over a scanned page so it can be searched
 * and copied. Each word is stretched to the width of its box on the image.
 */
export async function addInvisibleText(bytes: Bytes, index: number, words: OcrPlacement[]): Promise<Bytes> {
  const doc = await load(bytes);
  const page = pageAt(doc, index);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const key = page.node.newFontDictionary(font.name, font.ref);
  const angle = (page.getRotation().angle * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of words) {
    const text = winAnsi(w.text);
    if (!text || w.width <= 0 || w.height <= 0) continue;
    const size = w.height * 0.82;
    const natural = font.widthOfTextAtSize(text, size);
    if (natural <= 0) continue;
    ops.push(
      setFontAndSize(key, size),
      setCharacterSqueeze((100 * w.width) / natural),
      // Baseline sits a little above the bottom of the box (descenders).
      setTextMatrix(cos, sin, -sin, cos, w.at.x - sin * w.height * 0.18, w.at.y + cos * w.height * 0.18),
      showText(PDFHexString.of(Array.from(font.encodeText(text).asBytes(), (b) => b.toString(16).padStart(2, '0')).join(''))),
    );
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
  return save(doc);
}

// ---------------------------------------------------------------- export

/** A new PDF containing only the given pages, in the given order. */
export async function extractPages(bytes: Bytes, indices: number[]): Promise<Bytes> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}
