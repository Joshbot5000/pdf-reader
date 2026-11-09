/**
 * Find a font installed on this computer that matches a PDF's font name
 * (e.g. "TimesNewRomanPS-BoldMT", "Georgia-Italic", "Calibri"), so edited text
 * can use the same typeface as the document.
 *
 * Only each font file's `name` and `OS/2` tables are read to build the index,
 * so scanning is quick. Fonts whose licence forbids embedding (OS/2 fsType
 * "restricted") are skipped. Collections (.ttc) are split into a standalone
 * font for embedding.
 */
import { homedir } from 'node:os';
import { open, readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

interface Entry {
  path: string;
  /** Offset of this font's table directory within the file (non-zero inside .ttc). */
  offset: number;
  postscript: string;
  family: string;
  style: string;
}

function fontDirs(): string[] {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(home, 'Library/Fonts'),
        '/Applications/Microsoft Word.app/Contents/Resources/DFonts'];
    case 'win32':
      return [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Windows/Fonts')];
    default:
      return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.fonts'), join(home, '.local/share/fonts')];
  }
}

async function walk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth + 1, out);
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function readAt(fh: Awaited<ReturnType<typeof open>>, pos: number, len: number) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** Read names and embedding permission of the font whose table directory starts at `offset`. */
async function readFontNames(fh: Awaited<ReturnType<typeof open>>, offset: number) {
  const head = await readAt(fh, offset, 12);
  if (head.length < 12) return null;
  const numTables = head.readUInt16BE(4);
  if (numTables > 200) return null;
  const dir = await readAt(fh, offset + 12, numTables * 16);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i + 16 <= dir.length; i += 16) {
    tables.set(dir.toString('latin1', i, i + 4), { off: dir.readUInt32BE(i + 8), len: dir.readUInt32BE(i + 12) });
  }
  const os2 = tables.get('OS/2');
  if (os2) {
    const t = await readAt(fh, os2.off, 10);
    if (t.length >= 10 && (t.readUInt16BE(8) & 0x000f) === 0x0002) return null; // restricted licence
  }
  const nameT = tables.get('name');
  if (!nameT || nameT.len > 1 << 20) return null;
  const name = await readAt(fh, nameT.off, nameT.len);
  const count = name.readUInt16BE(2);
  const strOff = name.readUInt16BE(4);
  const names = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > name.length) break;
    const platform = name.readUInt16BE(r);
    const lang = name.readUInt16BE(r + 4);
    const id = name.readUInt16BE(r + 6);
    const len = name.readUInt16BE(r + 8);
    const off = strOff + name.readUInt16BE(r + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id) || off + len > name.length) continue;
    let value: string;
    if (platform === 3 || platform === 0) {
      if (platform === 3 && lang !== 0x409 && names.has(id)) continue; // prefer English
      value = '';
      for (let k = 0; k + 1 < len; k += 2) value += String.fromCharCode(name.readUInt16BE(off + k));
    } else if (platform === 1) {
      if (names.has(id)) continue;
      value = name.toString('latin1', off, off + len);
    } else continue;
    names.set(id, value);
  }
  const postscript = names.get(6) ?? '';
  if (!postscript) return null;
  return { postscript, family: names.get(16) ?? names.get(1) ?? '', style: names.get(17) ?? names.get(2) ?? '' };
}

let index: Promise<Entry[]> | null = null;

function buildIndex(): Promise<Entry[]> {
  index ??= (async () => {
    const files = (await Promise.all(fontDirs().map((d) => walk(d)))).flat();
    const entries: Entry[] = [];
    for (const path of files) {
      let fh;
      try {
        fh = await open(path, 'r');
        const tag = (await readAt(fh, 0, 12)).toString('latin1', 0, 4);
        const offsets: number[] = [];
        if (tag === 'ttcf') {
          const hdr = await readAt(fh, 0, 12);
          const n = Math.min(hdr.readUInt32BE(8), 64);
          const list = await readAt(fh, 12, n * 4);
          for (let i = 0; i + 4 <= list.length; i += 4) offsets.push(list.readUInt32BE(i));
        } else offsets.push(0);
        for (const offset of offsets) {
          const names = await readFontNames(fh, offset);
          if (names) entries.push({ path, offset, ...names });
        }
      } catch {
        /* unreadable font: skip */
      } finally {
        await fh?.close();
      }
    }
    return entries;
  })();
  return index;
}

/** Strip the subset tag and common suffixes: "ABCDEF+TimesNewRomanPS-BoldMT" → family "timesnewroman", style "bold". */
function parsePdfFontName(pdfName: string) {
  const name = pdfName.replace(/^[A-Z]{6}\+/, '');
  const [fam, style = ''] = name.split(/[-,]/);
  const family = norm(fam.replace(/(PS)?MT$|PS$/, ''));
  const s = (style + ' ' + name).toLowerCase();
  return {
    postscript: norm(name),
    family,
    bold: /bold|black|heavy|semibold|demi/.test(s),
    italic: /italic|oblique/.test(s),
  };
}

/** Extract one font from a .ttc collection as a standalone TrueType/OpenType file. */
function extractFromCollection(file: Buffer, offset: number): Buffer {
  const numTables = file.readUInt16BE(offset + 4);
  const records = Array.from({ length: numTables }, (_, i) => {
    const r = offset + 12 + i * 16;
    return { rec: file.subarray(r, r + 16), off: file.readUInt32BE(r + 8), len: file.readUInt32BE(r + 12) };
  });
  const headerLen = 12 + numTables * 16;
  let total = headerLen;
  for (const r of records) total += (r.len + 3) & ~3;
  const out = Buffer.alloc(total);
  file.copy(out, 0, offset, offset + 12);
  let pos = headerLen;
  records.forEach((r, i) => {
    r.rec.copy(out, 12 + i * 16);
    out.writeUInt32BE(pos, 12 + i * 16 + 8);
    file.copy(out, pos, r.off, r.off + r.len);
    pos += (r.len + 3) & ~3;
  });
  return out;
}

/** Bytes of an installed font matching a PDF font name, or null. */
export async function findFont(pdfName: string, hint: { bold?: boolean; italic?: boolean } = {}): Promise<Uint8Array | null> {
  if (!pdfName) return null;
  const want = parsePdfFontName(pdfName);
  const bold = hint.bold ?? want.bold;
  const italic = hint.italic ?? want.italic;
  const fonts = await buildIndex();
  let match = fonts.find((f) => norm(f.postscript) === want.postscript);
  if (!match) {
    const candidates = fonts.filter((f) => norm(f.family) === want.family || norm(f.postscript.split('-')[0]) === want.family);
    const score = (f: Entry) => {
      const s = f.style.toLowerCase();
      const b = /bold|black|heavy|semibold|demi/.test(s);
      const it = /italic|oblique/.test(s);
      return (b === bold ? 2 : 0) + (it === italic ? 2 : 0) + (/^(regular|roman|book|normal)$/.test(s) && !bold && !italic ? 1 : 0);
    };
    match = candidates.sort((a, b) => score(b) - score(a))[0];
  }
  if (!match || extname(match.path).toLowerCase() === '.otf' && match.offset) return null;
  const file = await readFile(match.path);
  const bytes = match.offset || file.toString('latin1', 0, 4) === 'ttcf' ? extractFromCollection(file, match.offset) : file;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Start indexing in the background so the first edit doesn't wait. */
export function warmFontIndex() {
  void buildIndex();
}
