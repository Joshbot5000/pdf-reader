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

export type DocEvent = 'opened' | 'closed' | 'loaded' | 'current' | 'state' | 'tabs';
const bus = new EventTarget();
export const on = (e: DocEvent, fn: () => void) => bus.addEventListener(e, fn);
export const emit = (e: DocEvent) => bus.dispatchEvent(new Event(e));

export const isDirty = () => doc.bytes !== null && doc.bytes !== doc.savedBytes;

// ======================================================================= tabs

/** An open document. The active tab's state lives in `doc` while it is active. */
export interface Tab {
  id: string;
  file: { path: string | null; name: string };
  bytes: Bytes;
  savedBytes: Bytes;
  undo: Bytes[];
  redo: Bytes[];
  current: number;
  editable: boolean;
}

export const tabs: Tab[] = [];
let active: Tab | null = null;
let tabSeq = 0;

export const activeTab = () => active;
export const tabDirty = (t: Tab) => (t === active ? isDirty() : t.bytes !== t.savedBytes);
export const anyDirty = () => tabs.some(tabDirty);

/** Copy the live document state back into its tab. */
function stash() {
  if (!active || !doc.bytes || !doc.file) return;
  Object.assign(active, {
    file: doc.file,
    bytes: doc.bytes,
    savedBytes: doc.savedBytes ?? doc.bytes,
    undo: doc.undo,
    redo: doc.redo,
    current: doc.current,
    editable: doc.editable,
  });
}

/** Make a tab the live document. */
async function activate(tab: Tab) {
  stash();
  active = tab;
  Object.assign(doc, {
    file: tab.file,
    savedBytes: tab.savedBytes,
    undo: tab.undo,
    redo: tab.redo,
    current: tab.current,
    editable: tab.editable,
  });
  pendingScroll = tab.current;
  await setBytes(tab.bytes);
  emit('opened');
  emit('tabs');
  emit('state');
}

/** Switch to another open document (ignored while an edit is being applied). */
export async function switchTab(tab: Tab): Promise<void> {
  if (tab === active || doc.busy || !tabs.includes(tab)) return;
  await activate(tab);
}

/** Close a tab; asks to save it first if it has unsaved changes. Resolves false if cancelled. */
export async function closeTab(tab: Tab): Promise<boolean> {
  if (tabDirty(tab)) {
    if (tab !== active) await switchTab(tab);
    if (!(await confirmDiscard())) return false;
  }
  const i = tabs.indexOf(tab);
  if (i < 0) return true;
  tabs.splice(i, 1);
  if (tab === active) {
    active = null;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) await activate(next);
    else closeDocument();
  }
  emit('tabs');
  return true;
}

/** Save every document with unsaved changes (used when the window closes). */
export async function saveAll(): Promise<boolean> {
  stash();
  for (const t of tabs.filter(tabDirty)) {
    if (t === active) {
      if (!(await save())) return false;
      continue;
    }
    if (!t.file.path) return false;
    try {
      await api.save(t.file.path, t.bytes);
      t.savedBytes = t.bytes;
    } catch (err) {
      toast(`Could not save ${t.file.name}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  emit('tabs');
  emit('state');
  return true;
}
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

/** Open a file in a new tab (or switch to it if it's already open). */
export async function openFile(file: OpenedFile): Promise<boolean> {
  const existing = file.path ? tabs.find((t) => t.file.path === file.path) : undefined;
  if (existing) {
    await switchTab(existing);
    return true;
  }
  // Check it opens before giving it a tab.
  try {
    const probe = loadPdf(file.data);
    await probe.promise;
    void probe.destroy();
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'PasswordException'
        ? 'This PDF is password-protected, which is not supported yet.'
        : `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
    toast(msg);
    return false;
  }
  let editable = false;
  try {
    await assertEditable(file.data);
    editable = true;
  } catch (err) {
    toast(err instanceof EditError ? err.message : 'This PDF cannot be edited.', 'info');
  }
  const tab: Tab = {
    id: `tab-${++tabSeq}`,
    file: { path: file.path, name: file.name },
    bytes: file.data,
    savedBytes: file.data,
    undo: [],
    redo: [],
    current: 0,
    editable,
  };
  tabs.push(tab);
  await activate(tab);
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
  try {
    const f = await api.openDialog();
    return f ? openFile(f) : false;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function openPath(path: string): Promise<boolean> {
  try {
    return await openFile(await api.openPath(path));
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Asks whether to save the active document's changes; resolves true to continue. */
let confirmDiscard: () => Promise<boolean> = async () => true;
export const setDiscardConfirm = (fn: () => Promise<boolean>) => (confirmDiscard = fn);

/** Save to the file (or choose a new one). Resolves true once saved. */
export async function save(asNew = false): Promise<boolean> {
  if (!doc.bytes || !doc.file) return false;
  const bytes = doc.bytes;
  try {
    if (!asNew && doc.file.path) {
      await api.save(doc.file.path, bytes);
      toast(`Saved to ${doc.file.name}`, 'success', 2200);
    } else {
      const r = await api.saveAs(doc.file.name.replace(/\.pdf$/i, '') + (asNew ? ' (copy)' : '') + '.pdf', bytes);
      if (!r) return false;
      doc.file = { path: r.path, name: r.name };
      toast(`Saved as ${r.name}`, 'success');
    }
    doc.savedBytes = bytes;
    emit('state');
    return true;
  } catch (err) {
    toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    return false;
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
