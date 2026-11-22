/**
 * Course materials attached to a lecture: slides and handouts (PDF, PowerPoint, Word, text). Their
 * text is kept with the lecture so the notes and the tutor can use them alongside the transcript.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { uid, type Para } from '../shared/types';
import { findCaseNames } from '../shared/law';

export type Material = { id: string; name: string; kind: string; pages: string[]; at: number };
export const MATERIAL_TYPES = ['pdf', 'pptx', 'docx', 'txt', 'md'];

const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function pdfPages(file: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 400); i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let text = '';
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) text += (item.str ?? '') + (item.hasEOL ? '\n' : ' ');
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  }
  await doc.destroy();
  return pages;
}

async function officePages(file: string, kind: 'pptx' | 'docx'): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  if (kind === 'docx') {
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const paras = xml.split(/<\/w:p>/).map((p) => decode([...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))).filter((t) => t.trim());
    // Pages are not marked in Word files: group paragraphs into page-sized chunks.
    const out: string[] = [];
    let cur = '';
    for (const p of paras) {
      if (cur.length + p.length > 2500 && cur) (out.push(cur), (cur = ''));
      cur += (cur ? '\n' : '') + p;
    }
    if (cur) out.push(cur);
    return out;
  }
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/(\d+)\.xml$/)![1] - +b.match(/(\d+)\.xml$/)![1]);
  const out: string[] = [];
  for (const s of slides) {
    const xml = await zip.file(s)!.async('string');
    out.push(decode(xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter((t) => t.trim()).join('\n')));
  }
  return out;
}

/** Read a file's text, a page (or slide) at a time. */
export async function readMaterial(file: string): Promise<Material> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = path.basename(file);
  let pages: string[];
  if (ext === 'pdf') pages = await pdfPages(file);
  else if (ext === 'pptx' || ext === 'docx') pages = await officePages(file, ext);
  else if (ext === 'txt' || ext === 'md') pages = [fs.readFileSync(file, 'utf8')];
  else throw new Error(`${name}: Hark can read PDF, PowerPoint (.pptx), Word (.docx) and text files. For Keynote or older formats, export as PDF first.`);
  if (!pages.some((p) => p.trim().length > 20)) throw new Error(`${name} has no readable text (it may be scanned images). Export it with text, or add the text as a note.`);
  return { id: uid(), name, kind: ext, pages, at: Date.now() };
}

/** The pages of a lecture's materials that best match a question (by shared words), within a character budget. */
export function relevantPages(materials: Material[], query: string, budget = 3000): string {
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))];
  const scored = materials.flatMap((m) => m.pages.map((text, i) => ({ m, i, text, score: words.filter((w) => text.toLowerCase().includes(w)).length })));
  const out: string[] = [];
  let used = 0;
  for (const p of scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)) {
    const piece = `[${p.m.name}, ${p.m.kind === 'pptx' ? 'slide' : 'page'} ${p.i + 1}] ${p.text.slice(0, 1200)}`;
    if (used + piece.length > budget) break;
    out.push(piece);
    used += piece.length;
  }
  return out.join('\n---\n');
}

/** An outline of all materials (first lines of each page), for note-writing, within a budget. */
export function materialsOutline(materials: Material[], budget = 6000): string {
  const out: string[] = [];
  let used = 0;
  for (const m of materials)
    for (let i = 0; i < m.pages.length; i++) {
      const piece = `[${m.name}, ${m.kind === 'pptx' ? 'slide' : 'page'} ${i + 1}] ${m.pages[i].replace(/\s+/g, ' ').slice(0, 400)}`;
      if (used + piece.length > budget) return out.join('\n');
      out.push(piece);
      used += piece.length;
    }
  return out.join('\n');
}

const FILE = 'materials.json';
export function loadMaterials(folder: string): Material[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, FILE), 'utf8')) as Material[];
  } catch {
    return [];
  }
}
export function saveMaterials(folder: string, list: Material[]): void {
  const f = path.join(folder, FILE);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(list));
  fs.renameSync(`${f}.tmp`, f);
}

/** Case names printed on the slides, with where they appear. */
export function materialCases(materials: Material[]): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  for (const m of materials)
    m.pages.forEach((text, i) => {
      for (const h of findCaseNames(text.split('\n').map((line, k) => ({ id: `${i}-${k}`, sp: '', s: 0, e: 0, text: line, words: [] }) as Para)))
        if (!out.some((o) => o.name.toLowerCase() === h.name.toLowerCase())) out.push({ name: h.name, where: `${m.name}, ${m.kind === 'pptx' ? 'slide' : 'page'} ${i + 1}` });
    });
  return out;
}
