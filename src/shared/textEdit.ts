/**
 * Editing a PDF's existing text.
 *
 * A page's text lives in its content stream as text-showing operators
 * (Tj, TJ, ', ") inside BT…ET blocks. To edit a paragraph we:
 *
 *  1. tokenize the page's content stream(s);
 *  2. simulate the graphics and text state (CTM, text matrix, font, size,
 *     spacing, fill colour…) to find where each text-showing operator starts
 *     on the page and how it is styled;
 *  3. remove the operators that start inside the selected box, replacing each
 *     with an empty `[n] TJ` of the same advance so any text that follows on
 *     the same line stays exactly where it was;
 *  4. draw the new text with the closest standard font, size and colour.
 *
 * Text drawn inside form XObjects or as images (scans) can't be removed this
 * way; it is covered with white and the new text drawn on top instead.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';
import { EditError, type Bytes, type Color, type Rect } from './pdfOps';

// ======================================================================= tokenizer

export type Token =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'name'; v: string; s: number; e: number }
  | { t: 'str'; v: Uint8Array; s: number; e: number }
  | { t: 'arr'; v: Token[]; s: number; e: number }
  | { t: 'dict'; s: number; e: number }
  | { t: 'kw'; v: string; s: number; e: number }; // operators, true/false/null

export interface Op {
  op: string;
  args: Token[];
  /** Byte range of the whole operation (operands + operator). */
  s: number;
  e: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);

class Lexer {
  i = 0;
  constructor(readonly b: Uint8Array) {}

  skipWs() {
    const b = this.b;
    while (this.i < b.length) {
      const c = b[this.i];
      if (WS.has(c)) this.i++;
      else if (c === 0x25) {
        while (this.i < b.length && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++;
      } else break;
    }
  }

  next(): Token | null {
    this.skipWs();
    const b = this.b;
    if (this.i >= b.length) return null;
    const s = this.i;
    const c = b[this.i];
    if (c === 0x28) return { t: 'str', v: this.literal(), s, e: this.i };
    if (c === 0x3c && b[this.i + 1] === 0x3c) {
      // Dictionary (only appears as BDC/DP operands and inline images): skip it.
      let depth = 0;
      while (this.i < b.length) {
        if (b[this.i] === 0x3c && b[this.i + 1] === 0x3c) {
          depth++;
          this.i += 2;
        } else if (b[this.i] === 0x3e && b[this.i + 1] === 0x3e) {
          depth--;
          this.i += 2;
          if (!depth) break;
        } else if (b[this.i] === 0x28) this.literal();
        else this.i++;
      }
      return { t: 'dict', s, e: this.i };
    }
    if (c === 0x3c) return { t: 'str', v: this.hex(), s, e: this.i };
    if (c === 0x5b) {
      this.i++;
      const v: Token[] = [];
      for (;;) {
        this.skipWs();
        if (this.i >= b.length) break;
        if (b[this.i] === 0x5d) {
          this.i++;
          break;
        }
        const t = this.next();
        if (!t) break;
        v.push(t);
      }
      return { t: 'arr', v, s, e: this.i };
    }
    if (c === 0x2f) {
      this.i++;
      while (this.i < b.length && isRegular(b[this.i])) this.i++;
      const raw = String.fromCharCode(...b.subarray(s + 1, this.i));
      return { t: 'name', v: raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), s, e: this.i };
    }
    if (c === 0x5d || c === 0x29 || c === 0x3e || c === 0x7b || c === 0x7d) {
      this.i++; // stray delimiter: ignore
      return this.next();
    }
    while (this.i < b.length && isRegular(b[this.i])) this.i++;
    const word = String.fromCharCode(...b.subarray(s, this.i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word), s, e: this.i };
    return { t: 'kw', v: word, s, e: this.i };
  }

  private literal(): Uint8Array {
    const b = this.b;
    const out: number[] = [];
    this.i++; // (
    let depth = 1;
    while (this.i < b.length) {
      const c = b[this.i++];
      if (c === 0x5c) {
        const n = b[this.i++];
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (n in map) out.push(map[n]);
        else if (n >= 0x30 && n <= 0x37) {
          let oct = n - 0x30;
          for (let k = 0; k < 2 && b[this.i] >= 0x30 && b[this.i] <= 0x37; k++) oct = oct * 8 + (b[this.i++] - 0x30);
          out.push(oct & 0xff);
        } else if (n === 0x0d) {
          if (b[this.i] === 0x0a) this.i++;
        } else if (n !== 0x0a) out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }

  private hex(): Uint8Array {
    const b = this.b;
    this.i++; // <
    let digits = '';
    while (this.i < b.length && b[this.i] !== 0x3e) {
      const ch = String.fromCharCode(b[this.i++]);
      if (/[0-9a-fA-F]/.test(ch)) digits += ch;
    }
    this.i++; // >
    if (digits.length % 2) digits += '0';
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(digits.slice(k * 2, k * 2 + 2), 16);
    return out;
  }

  /** Skip inline image data after `ID` up to and including `EI`. */
  skipInlineImage() {
    const b = this.b;
    this.i++; // single whitespace after ID
    while (this.i < b.length) {
      if (
        b[this.i] === 0x45 && b[this.i + 1] === 0x49 &&
        WS.has(b[this.i - 1]) && (this.i + 2 >= b.length || WS.has(b[this.i + 2]))
      ) {
        this.i += 2;
        return;
      }
      this.i++;
    }
  }
}

/** Split a content stream into operations. */
export function parseContent(bytes: Uint8Array): Op[] {
  const lex = new Lexer(bytes);
  const ops: Op[] = [];
  let args: Token[] = [];
  for (let t = lex.next(); t; t = lex.next()) {
    if (t.t !== 'kw' || t.v === 'true' || t.v === 'false' || t.v === 'null') {
      args.push(t);
      continue;
    }
    const s = args.length ? args[0].s : t.s;
    if (t.v === 'BI') {
      // Inline image: BI <key value pairs> ID <binary> EI
      for (let k = lex.next(); k && !(k.t === 'kw' && k.v === 'ID'); k = lex.next());
      lex.skipInlineImage();
      ops.push({ op: 'BI', args: [], s, e: lex.i });
    } else {
      ops.push({ op: t.v, args, s, e: t.e });
    }
    args = [];
  }
  return ops;
}

// ======================================================================= fonts

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const I: Matrix = [1, 0, 0, 1, 0, 0];

interface FontInfo {
  codeLength: 1 | 2;
  /** Glyph width in thousandths of an em. */
  width(code: number): number;
  baseFont: string;
  serif: boolean;
  mono: boolean;
}

function num(doc: PDFDocument, o: unknown, fallback = 0): number {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

function lookupDict(doc: PDFDocument, o: unknown): PDFDict | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFDict ? v : undefined;
}

function lookupArray(doc: PDFDocument, o: unknown): PDFArray | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFArray ? v : undefined;
}

function fontInfo(doc: PDFDocument, dict: PDFDict | undefined): FontInfo {
  const fallback: FontInfo = { codeLength: 1, width: () => 500, baseFont: '', serif: false, mono: false };
  if (!dict) return fallback;
  const base = (dict.get(PDFName.of('BaseFont')) as PDFName | undefined)?.decodeText?.() ?? '';
  const subtype = (dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText?.() ?? '';
  let descriptor = lookupDict(doc, dict.get(PDFName.of('FontDescriptor')));
  let widthFn: (code: number) => number;
  let codeLength: 1 | 2 = 1;
  if (subtype === 'Type0') {
    codeLength = 2;
    const desc = lookupDict(doc, lookupArray(doc, dict.get(PDFName.of('DescendantFonts')))?.get(0));
    descriptor = lookupDict(doc, desc?.get(PDFName.of('FontDescriptor'))) ?? descriptor;
    const dw = num(doc, desc?.get(PDFName.of('DW')), 1000);
    const widths = new Map<number, number>();
    const w = lookupArray(doc, desc?.get(PDFName.of('W')));
    if (w) {
      for (let k = 0; k < w.size(); ) {
        const first = num(doc, w.get(k));
        const second = w.get(k + 1);
        const list = lookupArray(doc, second);
        if (list) {
          for (let j = 0; j < list.size(); j++) widths.set(first + j, num(doc, list.get(j)));
          k += 2;
        } else {
          const last = num(doc, second);
          const width = num(doc, w.get(k + 2));
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    widthFn = (c) => widths.get(c) ?? dw;
  } else {
    const first = num(doc, dict.get(PDFName.of('FirstChar')), 0);
    const ws = lookupArray(doc, dict.get(PDFName.of('Widths')));
    const missing = num(doc, descriptor?.get(PDFName.of('MissingWidth')), /Courier/i.test(base) ? 600 : /Times/i.test(base) ? 500 : 556);
    const table = ws ? Array.from({ length: ws.size() }, (_, k) => num(doc, ws.get(k), missing)) : [];
    widthFn = (c) => table[c - first] ?? missing;
  }
  const flags = num(doc, descriptor?.get(PDFName.of('Flags')), 0);
  const name = base.replace(/^[A-Z]{6}\+/, '');
  return {
    codeLength,
    width: widthFn,
    baseFont: name,
    serif: /times|serif|georgia|garamond|cambria|book|palatino|minion|baskerville|caslon/i.test(name) && !/sans/i.test(name) ? true : !!(flags & 2) && !/sans|arial|helvet/i.test(name),
    mono: /courier|mono|consol|menlo/i.test(name) || !!(flags & 1),
  };
}

// ======================================================================= simulation

export interface TextShow {
  index: number; // operation index
  /** Baseline start in user space. */
  x: number;
  y: number;
  /** Effective font size in user space and horizontal-ness. */
  size: number;
  horizontal: boolean;
  /** Advance in text space before horizontal scaling (for the replacement TJ). */
  displacement: number;
  fontSize: number;
  color: Color;
  font: FontInfo;
  renderMode: number;
  text: string;
}

interface GState {
  ctm: Matrix;
  fill: Color;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  font: FontInfo;
  fontSize: number;
  tr: number;
  rise: number;
}

const cmykToRgb = (c: number, m: number, y: number, k: number): Color => ({ r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) });

function colorFrom(nums: number[]): Color | null {
  if (nums.length === 1) return { r: nums[0], g: nums[0], b: nums[0] };
  if (nums.length === 3) return { r: nums[0], g: nums[1], b: nums[2] };
  if (nums.length === 4) return cmykToRgb(nums[0], nums[1], nums[2], nums[3]);
  return null;
}

/** Find every text-showing operation, its position on the page and its style. */
export function simulateText(doc: PDFDocument, ops: Op[], fonts: PDFDict | undefined): TextShow[] {
  const fontCache = new Map<string, FontInfo>();
  const getFont = (name: string) => {
    if (!fontCache.has(name)) fontCache.set(name, fontInfo(doc, lookupDict(doc, fonts?.get(PDFName.of(name)))));
    return fontCache.get(name)!;
  };
  let gs: GState = { ctm: I, fill: { r: 0, g: 0, b: 0 }, tc: 0, tw: 0, th: 1, tl: 0, font: fontInfo(doc, undefined), fontSize: 0, tr: 0, rise: 0 };
  const stack: GState[] = [];
  let tm: Matrix = I;
  let tlm: Matrix = I;
  const shows: TextShow[] = [];
  const nums = (args: Token[]) => args.filter((a): a is Extract<Token, { t: 'num' }> => a.t === 'num').map((a) => a.v);

  const moveLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const show = (index: number, items: Token[]) => {
    const trm = mul([gs.fontSize * gs.th, 0, 0, gs.fontSize, 0, gs.rise], mul(tm, gs.ctm));
    const vScale = Math.hypot(trm[2], trm[3]);
    let disp = 0;
    let text = '';
    for (const it of items) {
      if (it.t === 'num') {
        disp += (-it.v / 1000) * gs.fontSize;
      } else if (it.t === 'str') {
        const bytes = it.v;
        for (let k = 0; k + gs.font.codeLength <= bytes.length; k += gs.font.codeLength) {
          const code = gs.font.codeLength === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
          disp += (gs.font.width(code) / 1000) * gs.fontSize + gs.tc + (gs.font.codeLength === 1 && code === 32 ? gs.tw : 0);
          if (gs.font.codeLength === 1 && code >= 32) text += String.fromCharCode(code);
        }
      }
    }
    shows.push({
      index,
      x: trm[4],
      y: trm[5],
      size: vScale,
      horizontal: Math.abs(trm[1]) < 1e-3 * Math.abs(trm[0]) && Math.abs(trm[2]) < 1e-3 * Math.abs(trm[3]) && trm[0] > 0 && trm[3] > 0,
      displacement: disp,
      fontSize: gs.fontSize,
      color: gs.fill,
      font: gs.font,
      renderMode: gs.tr,
      text,
    });
    tm = mul([1, 0, 0, 1, disp * gs.th, 0], tm);
  };

  ops.forEach((o, index) => {
    const n = nums(o.args);
    switch (o.op) {
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        if (n.length === 6) gs.ctm = mul(n as Matrix, gs.ctm);
        break;
      case 'g':
      case 'rg':
      case 'k':
      case 'sc':
      case 'scn': {
        const c = colorFrom(n);
        if (c) gs.fill = c;
        break;
      }
      case 'BT':
        tm = tlm = I;
        break;
      case 'Tc':
        gs.tc = n[0] ?? 0;
        break;
      case 'Tw':
        gs.tw = n[0] ?? 0;
        break;
      case 'Tz':
        gs.th = (n[0] ?? 100) / 100;
        break;
      case 'TL':
        gs.tl = n[0] ?? 0;
        break;
      case 'Ts':
        gs.rise = n[0] ?? 0;
        break;
      case 'Tr':
        gs.tr = n[0] ?? 0;
        break;
      case 'Tf': {
        const name = o.args.find((a) => a.t === 'name');
        if (name && name.t === 'name') gs.font = getFont(name.v);
        gs.fontSize = n[0] ?? gs.fontSize;
        break;
      }
      case 'Td':
        moveLine(n[0] ?? 0, n[1] ?? 0);
        break;
      case 'TD':
        gs.tl = -(n[1] ?? 0);
        moveLine(n[0] ?? 0, n[1] ?? 0);
        break;
      case 'Tm':
        if (n.length === 6) tm = tlm = n as Matrix;
        break;
      case 'T*':
        moveLine(0, -gs.tl);
        break;
      case 'Tj':
        show(index, o.args.filter((a) => a.t === 'str'));
        break;
      case 'TJ': {
        const arr = o.args.find((a) => a.t === 'arr');
        show(index, arr && arr.t === 'arr' ? arr.v : []);
        break;
      }
      case "'":
        moveLine(0, -gs.tl);
        show(index, o.args.filter((a) => a.t === 'str'));
        break;
      case '"':
        gs.tw = n[0] ?? gs.tw;
        gs.tc = n[1] ?? gs.tc;
        moveLine(0, -gs.tl);
        show(index, o.args.filter((a) => a.t === 'str'));
        break;
    }
  });
  return shows;
}

// ======================================================================= page content I/O

function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.get(PDFName.of('Contents'));
  const streams: PDFStream[] = [];
  const add = (o: unknown) => {
    const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
    if (v instanceof PDFStream) streams.push(v);
    else if (v instanceof PDFArray) for (let k = 0; k < v.size(); k++) add(v.get(k));
  };
  add(contents);
  const parts = streams.map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

function setPageContent(doc: PDFDocument, page: PDFPage, bytes: Uint8Array) {
  const ref = doc.context.register(doc.context.flateStream(bytes));
  page.node.set(PDFName.of('Contents'), ref);
}

const fmt = (v: number) => (Math.abs(v) < 1e-4 ? '0' : Number(v.toFixed(4)).toString());

// ======================================================================= public API

export interface TextStyle {
  fontSize: number;
  color: Color;
  family: 'sans' | 'serif' | 'mono';
  bold: boolean;
  italic: boolean;
}

export interface TextRegion {
  page: number;
  /** Selected box in PDF user space. */
  box: Rect;
}

function inBox(s: TextShow, box: Rect): boolean {
  const pad = Math.max(1, s.size * 0.25);
  return s.x >= box.x - pad && s.x <= box.x + box.width + pad && s.y >= box.y - pad && s.y <= box.y + box.height + pad;
}

function styleOf(s: TextShow): TextStyle {
  const name = s.font.baseFont;
  return {
    fontSize: Math.round(s.size * 10) / 10,
    color: s.color,
    family: s.font.mono ? 'mono' : s.font.serif ? 'serif' : 'sans',
    bold: /bold|black|heavy|semibold|demi/i.test(name),
    italic: /italic|oblique/i.test(name),
  };
}

async function loadPage(bytes: Bytes, index: number) {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) throw new EditError('This PDF is encrypted. It can be viewed but not edited.');
    throw err;
  }
  if (index < 0 || index >= doc.getPageCount()) throw new EditError(`Page ${index + 1} does not exist.`);
  const page = doc.getPage(index);
  const content = pageContent(doc, page);
  const ops = parseContent(content);
  const fonts = lookupDict(doc, page.node.Resources()?.get(PDFName.of('Font')));
  const shows = simulateText(doc, ops, fonts);
  return { doc, page, content, ops, shows };
}

/** The style of the first text in a region, to match the editor to it. */
export async function inspectTextStyle(bytes: Bytes, region: TextRegion): Promise<TextStyle | null> {
  const { shows } = await loadPage(bytes, region.page);
  const hit = shows.filter((s) => s.renderMode !== 3 && inBox(s, region.box)).sort((a, b) => b.y - a.y || a.x - b.x)[0];
  return hit ? styleOf(hit) : null;
}

export interface ReplaceOptions extends TextRegion {
  /** New text; paragraphs separated by \n. Empty removes the text. */
  text: string;
  /** Override the detected style (e.g. when nothing is detected). */
  style?: Partial<TextStyle>;
}

export interface ReplaceResult {
  bytes: Bytes;
  /** 'edited': original text operators were removed; 'covered': it was covered with white. */
  method: 'edited' | 'covered';
  removed: number;
}

const FONTS: Record<TextStyle['family'], [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

/** Replace (or, with empty text, remove) the text inside a region of a page. */
export async function replaceText(bytes: Bytes, opts: ReplaceOptions): Promise<ReplaceResult> {
  const { doc, page, content, ops, shows } = await loadPage(bytes, opts.page);
  const hits = shows.filter((s) => inBox(s, opts.box));
  const visible = hits.filter((s) => s.renderMode !== 3);
  if (visible.some((s) => !s.horizontal)) {
    throw new EditError('Rotated or skewed text can’t be edited yet. Use White-out and Add text instead.');
  }

  // 1. Remove the matched operators, keeping their advance so the rest of each line stays put.
  if (hits.length) {
    const replace = new Map<number, string>();
    for (const s of hits) {
      const o = ops[s.index];
      const k = s.fontSize ? (-s.displacement * 1000) / s.fontSize : 0;
      const tj = s.fontSize ? `[${fmt(k)}] TJ` : '';
      const n = o.args.filter((a) => a.t === 'num').map((a) => (a as { v: number }).v);
      replace.set(
        s.index,
        o.op === "'" ? `T* ${tj}` : o.op === '"' ? `${fmt(n[0] ?? 0)} Tw ${fmt(n[1] ?? 0)} Tc T* ${tj}` : tj,
      );
    }
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let at = 0;
    ops.forEach((o, i) => {
      const r = replace.get(i);
      if (r === undefined) return;
      chunks.push(content.subarray(at, o.s), enc.encode(r));
      at = o.e;
    });
    chunks.push(content.subarray(at));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    setPageContent(doc, page, out);
  }

  // Nothing visible was removed (text in a form XObject, a scan with an OCR
  // layer, or an image): cover the area instead.
  const method: ReplaceResult['method'] = visible.length ? 'edited' : 'covered';
  if (method === 'covered') {
    const pad = 1.5;
    page.drawRectangle({
      x: opts.box.x - pad,
      y: opts.box.y - pad,
      width: opts.box.width + 2 * pad,
      height: opts.box.height + 2 * pad,
      color: rgb(1, 1, 1),
    });
  }

  // 2. Draw the new text in the closest standard font.
  const first = [...visible].sort((a, b) => b.y - a.y || a.x - b.x)[0];
  const detected = first ? styleOf(first) : null;
  const style: TextStyle = {
    fontSize: 11,
    color: { r: 0, g: 0, b: 0 },
    family: 'sans',
    bold: false,
    italic: false,
    ...(detected ?? {}),
    ...opts.style,
  };
  const text = opts.text.replace(/\r\n?/g, '\n');
  if (text.trim()) {
    const font = await doc.embedFont(FONTS[style.family][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]);
    const size = style.fontSize;
    const baselines = [...new Set(visible.map((s) => Math.round(s.y * 10) / 10))].sort((a, b) => b - a);
    const gaps = baselines.slice(1).map((y, i) => baselines[i] - y).filter((g) => g > size * 0.8 && g < size * 3);
    const lineHeight = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : size * 1.2;
    const x = first ? Math.min(...visible.filter((s) => Math.abs(s.y - first.y) < size * 0.5).map((s) => s.x)) : opts.box.x;
    let y = first ? first.y : opts.box.y + opts.box.height - size * 0.85;
    const maxWidth = Math.max(opts.box.width + size * 0.5, size * 4);
    const lines: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/ +/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    try {
      for (const line of lines) {
        if (line) page.drawText(line, { x, y, size, font, color: rgb(style.color.r, style.color.g, style.color.b) });
        y -= lineHeight;
      }
    } catch (err) {
      if (err instanceof Error && /cannot encode/i.test(err.message)) {
        throw new EditError('That text contains characters the standard fonts can’t show (they cover Western European characters only).');
      }
      throw err;
    }
  }
  return { bytes: await doc.save(), method, removed: hits.length };
}
