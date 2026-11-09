/**
 * The open document: its bytes, the pdf.js proxy used for rendering, undo
 * history and save state. Every edit is a `bytes → bytes` function; the
 * previous bytes go on the undo stack and the viewer re-renders, so the
 * screen always shows exactly what will be saved.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EditError, assertEditable, type Bytes } from '../../../shared/pdfOps';
import type { OpenedFile } from '../../../shared/ipc';
import { toast } from '../ui/overlays';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const assets = new URL('./pdfjs/', location.href).href;
export const api = window.api;

const MAX_UNDO = 40;
const MAX_UNDO_BYTES = 400 * 1024 * 1024;

export interface PageText {
  items: TextItem[];
  /** CSS font-family per pdf.js font name, for measuring character positions. */
  fonts: Record<string, string>;
}

export const doc = {
  file: null as { path: string | null; name: string } | null,
  bytes: null as Bytes | null,
  savedBytes: null as Bytes | null,
  pdf: null as PDFDocumentProxy | null,
  task: null as PDFDocumentLoadingTask | null,
  /** Incremented whenever a different set of bytes starts loading. */
  generation: 0,
  editable: false,
  undo: [] as Bytes[],
  redo: [] as Bytes[],
  current: 0,
  busy: false,
  text: null as Promise<PageText[]> | null,
};

export type DocEvent = 'opened' | 'closed' | 'loaded' | 'current' | 'state';
const bus = new EventTarget();
export const on = (e: DocEvent, fn: () => void) => bus.addEventListener(e, fn);
export const emit = (e: DocEvent) => bus.dispatchEvent(new Event(e));

export const isDirty = () => doc.bytes !== null && doc.bytes !== doc.savedBytes;
export const pageCount = () => doc.pdf?.numPages ?? 0;

/** Load any PDF bytes with pdf.js (also used for compare and Spaces previews). */
export function loadPdf(bytes: Bytes): PDFDocumentLoadingTask {
  // pdf.js transfers the buffer it is given to its worker, so pass a copy.
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  });
}

export async function openFile(file: OpenedFile): Promise<boolean> {
  const prev = { ...doc };
  doc.file = { path: file.path, name: file.name };
  doc.undo = [];
  doc.redo = [];
  doc.savedBytes = file.data;
  doc.current = 0;
  doc.editable = false;
  try {
    await setBytes(file.data);
  } catch (err) {
    Object.assign(doc, { file: prev.file, undo: prev.undo, redo: prev.redo, savedBytes: prev.savedBytes, current: prev.current, editable: prev.editable });
    doc.bytes = prev.bytes; // the previous document (if any) is still loaded
    const msg =
      err instanceof Error && err.name === 'PasswordException'
        ? 'This PDF is password-protected, which is not supported yet.'
        : `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
    toast(msg);
    return false;
  }
  emit('opened');
  emit('state');
  try {
    await assertEditable(file.data);
    doc.editable = true;
  } catch (err) {
    toast(err instanceof EditError ? err.message : 'This PDF cannot be edited.', 'info');
  }
  emit('state');
  return true;
}

export function closeDocument() {
  void doc.task?.destroy();
  Object.assign(doc, {
    file: null, bytes: null, savedBytes: null, pdf: null, task: null, editable: false,
    undo: [], redo: [], current: 0, text: null,
  });
  doc.generation++;
  emit('closed');
  emit('state');
}

/** Make `bytes` the current document and reload pdf.js. */
export async function setBytes(bytes: Bytes) {
  const gen = ++doc.generation;
  // Record the target immediately: a concurrent reload must render this version.
  doc.bytes = bytes;
  const task = loadPdf(bytes);
  const pdf = await task.promise;
  if (gen !== doc.generation) {
    void task.destroy();
    return;
  }
  const old = doc.task;
  doc.task = task;
  doc.pdf = pdf;
  doc.text = null;
  doc.current = Math.min(doc.current, pdf.numPages - 1);
  void old?.destroy();
  emit('loaded');
}

export interface EditOptions {
  /** Page to show after the edit. */
  scrollTo?: number;
  label?: string;
  /** Pages the edit changed (others keep their rendering). Omit if unknown. */
  pages?: number[];
}
let pendingScroll: number | undefined;
let pendingChanged: Set<number> | null = null;
/** Pages changed by the last edit, or null when every page may have changed. */
export const takeChangedPages = () => {
  const c = pendingChanged;
  pendingChanged = null;
  return c;
};
export const takeScrollTarget = () => {
  const t = pendingScroll;
  pendingScroll = undefined;
  return t;
};

/** Apply an edit; returns false if nothing changed or it failed. */
export async function applyEdit(fn: (bytes: Bytes) => Promise<Bytes>, opts: EditOptions = {}): Promise<boolean> {
  if (!doc.bytes || !doc.editable || doc.busy) return false;
  doc.busy = true;
  emit('state');
  try {
    const before = doc.bytes;
    const after = await fn(before);
    if (after === before) return false;
    doc.undo.push(before);
    let total = doc.undo.reduce((n, b) => n + b.byteLength, 0);
    while (doc.undo.length > MAX_UNDO || (total > MAX_UNDO_BYTES && doc.undo.length > 1)) {
      total -= doc.undo.shift()!.byteLength;
    }
    doc.redo = [];
    if (opts.scrollTo !== undefined) {
      pendingScroll = opts.scrollTo;
      doc.current = opts.scrollTo;
    }
    pendingChanged = opts.pages ? new Set(opts.pages) : null;
    await setBytes(after);
    if (opts.label) toast(opts.label, 'success', 2200);
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    if (!(err instanceof EditError)) console.error(err);
    return false;
  } finally {
    doc.busy = false;
    emit('state');
  }
}

export async function undo() {
  if (!doc.undo.length || !doc.bytes || doc.busy) return;
  doc.redo.push(doc.bytes);
  await setBytes(doc.undo.pop()!);
  emit('state');
}

export async function redo() {
  if (!doc.redo.length || !doc.bytes || doc.busy) return;
  doc.undo.push(doc.bytes);
  await setBytes(doc.redo.pop()!);
  emit('state');
}

export function setCurrent(index: number) {
  if (index === doc.current || index < 0 || index >= pageCount()) return;
  doc.current = index;
  emit('current');
}

// ---------------------------------------------------------------- files

export async function openDialog(): Promise<boolean> {
  if (isDirty() && !(await confirmDiscard())) return false;
  try {
    const f = await api.openDialog();
    return f ? openFile(f) : false;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function openPath(path: string): Promise<boolean> {
  if (isDirty() && !(await confirmDiscard())) return false;
  try {
    return await openFile(await api.openPath(path));
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return false;
  }
}

let confirmDiscard: () => Promise<boolean> = async () => true;
export const setDiscardConfirm = (fn: () => Promise<boolean>) => (confirmDiscard = fn);

export async function save(asNew = false) {
  if (!doc.bytes || !doc.file) return;
  try {
    if (!asNew && doc.file.path) {
      await api.save(doc.file.path, doc.bytes);
      toast('Saved', 'success', 1800);
    } else {
      const r = await api.saveAs(doc.file.name, doc.bytes);
      if (!r) return;
      doc.file = { path: r.path, name: r.name };
      toast(`Saved as ${r.name}`, 'success');
    }
    doc.savedBytes = doc.bytes;
    emit('state');
  } catch (err) {
    toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- text

/** Text runs for every page (cached per document version). */
export function pageText(): Promise<PageText[]> {
  const pdf = doc.pdf!;
  doc.text ??= extractText(pdf);
  return doc.text;
}

export function extractText(pdf: PDFDocumentProxy): Promise<PageText[]> {
  return Promise.all(
    Array.from({ length: pdf.numPages }, async (_, i) => {
      const page = await pdf.getPage(i + 1);
      const content = await page.getTextContent();
      const fonts: Record<string, string> = {};
      for (const [name, style] of Object.entries(content.styles)) fonts[name] = style.fontFamily;
      return { items: content.items.filter((it): it is TextItem => 'str' in it), fonts };
    }),
  );
}
