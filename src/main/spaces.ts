/** PDF Spaces: named collections of PDFs, documents and web pages to chat across. */
import { net } from 'electron';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, SpaceSource } from '../shared/ipc';
import { loadState, spacesDir, updateState } from './store';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

export const SPACE_FILE_FILTERS = [
  { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
];

async function spaceFolder(spaceId: string) {
  const dir = join(spacesDir(), spaceId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function requireSpace(spaceId: string) {
  if (!(await loadState()).spaces.some((s) => s.id === spaceId)) throw new Error('That Space no longer exists.');
}

/** Copy or convert a local file into the Space. */
export async function addFile(spaceId: string, path: string): Promise<SpaceSource> {
  await requireSpace(spaceId);
  const ext = extname(path).toLowerCase();
  const { size } = await stat(path);
  if (size > MAX_SOURCE_BYTES) throw new Error(`${basename(path)} is larger than 25 MB.`);
  const dir = await spaceFolder(spaceId);
  const id = randomUUID();
  const title = basename(path, ext);
  if (ext === '.pdf') {
    await copyFile(path, join(dir, `${id}.pdf`));
    return { id, kind: 'pdf', title, file: `${id}.pdf`, size, addedAt: Date.now() };
  }
  let text: string;
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ path })).value;
  } else if (ext === '.txt' || ext === '.md') {
    text = await readFile(path, 'utf8');
  } else {
    throw new Error(`${basename(path)}: only PDF, Word (.docx), text and Markdown files can be added.`);
  }
  text = text.slice(0, MAX_TEXT_CHARS);
  await writeFile(join(dir, `${id}.txt`), text);
  return { id, kind: 'text', title, file: `${id}.txt`, size: text.length, addedAt: Date.now() };
}

function decodeEntities(s: string) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** Readable text from an HTML page: drops scripts, styles and navigation chrome. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

export async function addUrl(spaceId: string, raw: string): Promise<SpaceSource> {
  await requireSpace(spaceId);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('That does not look like a web address.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https links can be added.');
  const res = await net.fetch(url.toString(), { headers: { 'User-Agent': 'PDFReader/0.2 (desktop app)' } });
  if (!res.ok) throw new Error(`The page could not be fetched (HTTP ${res.status}).`);
  const type = res.headers.get('content-type') ?? '';
  const dir = await spaceFolder(spaceId);
  const id = randomUUID();
  if (type.includes('application/pdf')) {
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > MAX_SOURCE_BYTES) throw new Error('That PDF is larger than 25 MB.');
    await writeFile(join(dir, `${id}.pdf`), data);
    const title = decodeURIComponent(basename(url.pathname)) || url.hostname;
    return { id, kind: 'pdf', title, file: `${id}.pdf`, url: url.toString(), size: data.byteLength, addedAt: Date.now() };
  }
  const html = await res.text();
  const { title, text } = type.includes('html') ? htmlToText(html) : { title: '', text: html };
  if (!text.trim()) throw new Error('No readable text was found on that page.');
  const body = text.slice(0, MAX_TEXT_CHARS);
  await writeFile(join(dir, `${id}.txt`), body);
  return { id, kind: 'url', title: title || url.hostname, file: `${id}.txt`, url: url.toString(), size: body.length, addedAt: Date.now() };
}

export async function appendSources(spaceId: string, sources: SpaceSource[]): Promise<AppState> {
  return updateState((s) => {
    const space = s.spaces.find((x) => x.id === spaceId);
    if (space) space.sources.push(...sources);
  });
}

export async function removeSource(spaceId: string, sourceId: string): Promise<AppState> {
  const state = await updateState((s) => {
    const space = s.spaces.find((x) => x.id === spaceId);
    if (!space) return;
    const src = space.sources.find((x) => x.id === sourceId);
    space.sources = space.sources.filter((x) => x.id !== sourceId);
    if (src) void rm(join(spacesDir(), spaceId, src.file), { force: true });
  });
  return state;
}

export async function deleteSpace(spaceId: string): Promise<AppState> {
  await rm(join(spacesDir(), spaceId), { recursive: true, force: true });
  return updateState((s) => {
    s.spaces = s.spaces.filter((x) => x.id !== spaceId);
  });
}
