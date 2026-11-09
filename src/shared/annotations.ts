/**
 * Pen strokes and highlights are stored as real PDF annotations (Ink and
 * Highlight) with their own appearance streams, rather than painted into the
 * page. That keeps the original document untouched underneath, lets the
 * Eraser remove them individually, and lets other PDF apps (Acrobat, Preview)
 * show, move or delete them too.
 *
 * Annotations created here carry an /NM (unique name) starting with
 * "pdfreader-", so the Eraser only ever removes marks made in this app.
 */
import {
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  PDFHexString,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  fill,
} from 'pdf-lib';
import { EditError, type Bytes, type Color, type Point } from './pdfOps';

export const OWN_PREFIX = 'pdfreader-';

async function load(bytes: Bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) throw new EditError('This PDF is encrypted. It can be viewed but not edited.');
    throw err;
  }
}

const uid = () => OWN_PREFIX + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const pdfDate = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

function pageOf(doc: PDFDocument, index: number) {
  if (index < 0 || index >= doc.getPageCount()) throw new EditError(`Page ${index + 1} does not exist.`);
  return doc.getPage(index);
}

function addAnnot(doc: PDFDocument, pageIndex: number, dict: Record<string, unknown>) {
  const page = pageOf(doc, pageIndex);
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      F: 4, // print
      NM: PDFString.of(uid()),
      T: PDFString.of('PDF Reader'),
      M: PDFString.of(pdfDate()),
      P: page.ref,
      ...dict,
    } as never),
  );
  // Add to /Annots directly: pdf-lib's addAnnot() also rewrites the page's
  // content streams, and the original page content must stay untouched.
  const annots = page.node.Annots();
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
  return ref;
}

export interface InkAnnotation {
  page: number;
  /** One or more strokes, in PDF user space. */
  strokes: Point[][];
  width: number;
  color: Color;
}

export async function addInkAnnotation(bytes: Bytes, ink: InkAnnotation): Promise<Bytes> {
  const strokes = ink.strokes.filter((s) => s.length);
  if (!strokes.length) return bytes;
  const doc = await load(bytes);
  const pts = strokes.flat();
  const pad = ink.width / 2 + 1;
  const x0 = Math.min(...pts.map((p) => p.x)) - pad;
  const y0 = Math.min(...pts.map((p) => p.y)) - pad;
  const x1 = Math.max(...pts.map((p) => p.x)) + pad;
  const y1 = Math.max(...pts.map((p) => p.y)) + pad;
  const { r, g, b } = ink.color;
  const ops = [pushGraphicsState(), setStrokingRgbColor(r, g, b), setLineWidth(ink.width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
  for (const s of strokes) {
    const path = s.length === 1 ? [s[0], { x: s[0].x + 0.01, y: s[0].y }] : s;
    ops.push(moveTo(path[0].x, path[0].y), ...path.slice(1).map((p) => lineTo(p.x, p.y)), stroke());
  }
  ops.push(popGraphicsState());
  const ap = doc.context.register(doc.context.formXObject(ops, { BBox: [x0, y0, x1, y1] }));
  addAnnot(doc, ink.page, {
    Subtype: 'Ink',
    Rect: [x0, y0, x1, y1],
    InkList: strokes.map((s) => s.flatMap((p) => [p.x, p.y])),
    C: [r, g, b],
    BS: { W: ink.width, S: 'S' },
    AP: { N: ap },
  });
  return doc.save();
}

export interface HighlightAnnotation {
  page: number;
  a: Point;
  b: Point;
  color: Color;
}

export async function addHighlightAnnotation(bytes: Bytes, hl: HighlightAnnotation): Promise<Bytes> {
  const x0 = Math.min(hl.a.x, hl.b.x);
  const y0 = Math.min(hl.a.y, hl.b.y);
  const x1 = Math.max(hl.a.x, hl.b.x);
  const y1 = Math.max(hl.a.y, hl.b.y);
  if (x1 - x0 < 1 || y1 - y0 < 1) return bytes;
  const doc = await load(bytes);
  const { r, g, b } = hl.color;
  const gs = doc.context.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 0.4, CA: 0.4 });
  const ap = doc.context.register(
    doc.context.formXObject(
      [pushGraphicsState(), setGraphicsState('GS0'), setFillingRgbColor(r, g, b), rectangle(x0, y0, x1 - x0, y1 - y0), fill(), popGraphicsState()],
      { BBox: [x0, y0, x1, y1], Resources: { ExtGState: { GS0: gs } } },
    ),
  );
  addAnnot(doc, hl.page, {
    Subtype: 'Highlight',
    Rect: [x0, y0, x1, y1],
    QuadPoints: [x0, y1, x1, y1, x0, y0, x1, y0],
    C: [r, g, b],
    CA: 0.4,
    AP: { N: ap },
  });
  return doc.save();
}

export interface OwnAnnotation {
  /** Object reference, e.g. "12 0 R". */
  ref: string;
  page: number;
  kind: 'ink' | 'highlight';
  rect: [number, number, number, number];
  strokes: Point[][];
  width: number;
}

function nameOf(dict: PDFDict): string {
  const nm = dict.get(PDFName.of('NM'));
  return nm instanceof PDFString || nm instanceof PDFHexString ? nm.decodeText() : '';
}

const nums = (doc: PDFDocument, o: unknown): number[] => {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (!(v instanceof PDFArray)) return [];
  return v.asArray().map((x) => {
    const n = x instanceof PDFRef ? doc.context.lookup(x) : x;
    return n instanceof PDFNumber ? n.asNumber() : 0;
  });
};

/** Annotations created by this app, per page, for hit-testing by the Eraser. */
export async function listOwnAnnotations(bytes: Bytes): Promise<OwnAnnotation[]> {
  let doc: PDFDocument;
  try {
    doc = await load(bytes);
  } catch {
    return [];
  }
  const out: OwnAnnotation[] = [];
  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (const item of annots.asArray()) {
      const dict = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (!(dict instanceof PDFDict) || !(item instanceof PDFRef)) continue;
      if (!nameOf(dict).startsWith(OWN_PREFIX)) continue;
      const subtype = (dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText();
      if (subtype !== 'Ink' && subtype !== 'Highlight') continue;
      const rect = nums(doc, dict.get(PDFName.of('Rect'))) as [number, number, number, number];
      let strokes: Point[][] = [];
      if (subtype === 'Ink') {
        const list = dict.lookup(PDFName.of('InkList'));
        if (list instanceof PDFArray) {
          strokes = list.asArray().map((s) => {
            const flat = nums(doc, s);
            return Array.from({ length: flat.length / 2 }, (_, k) => ({ x: flat[2 * k], y: flat[2 * k + 1] }));
          });
        }
      }
      const bs = dict.lookup(PDFName.of('BS'));
      const w = bs instanceof PDFDict ? bs.lookup(PDFName.of('W')) : undefined;
      const width = w instanceof PDFNumber ? w.asNumber() : 1;
      out.push({ ref: item.toString(), page: index, kind: subtype === 'Ink' ? 'ink' : 'highlight', rect, strokes, width });
    }
  });
  return out;
}

/** Remove annotations made in this app (others are left untouched). */
export async function removeOwnAnnotations(bytes: Bytes, refs: string[]): Promise<Bytes> {
  if (!refs.length) return bytes;
  const doc = await load(bytes);
  const wanted = new Set(refs);
  let removed = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const item = annots.get(i);
      if (!(item instanceof PDFRef) || !wanted.has(item.toString())) continue;
      const dict = doc.context.lookup(item);
      if (!(dict instanceof PDFDict) || !nameOf(dict).startsWith(OWN_PREFIX)) continue;
      annots.remove(i);
      doc.context.delete(item);
      removed++;
    }
  }
  return removed ? doc.save() : bytes;
}

/** Distance from a point to an annotation, in PDF units (0 = on it). */
export function distanceTo(a: OwnAnnotation, p: Point): number {
  if (a.kind === 'highlight') {
    const [x0, y0, x1, y1] = a.rect;
    const dx = Math.max(x0 - p.x, 0, p.x - x1);
    const dy = Math.max(y0 - p.y, 0, p.y - y1);
    return Math.hypot(dx, dy);
  }
  let best = Infinity;
  for (const s of a.strokes) {
    for (let k = 0; k < s.length; k++) {
      const q = s[k];
      const r = s[k + 1] ?? q;
      const vx = r.x - q.x;
      const vy = r.y - q.y;
      const len = vx * vx + vy * vy;
      const t = len ? Math.max(0, Math.min(1, ((p.x - q.x) * vx + (p.y - q.y) * vy) / len)) : 0;
      best = Math.min(best, Math.hypot(p.x - (q.x + t * vx), p.y - (q.y + t * vy)));
    }
  }
  return Math.max(0, best - a.width / 2);
}
