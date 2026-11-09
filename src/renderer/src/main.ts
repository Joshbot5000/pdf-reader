import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  EditError,
  addInk,
  addRect,
  addText,
  assertEditable,
  deletePage,
  getFormFields,
  insertBlankPage,
  insertPdf,
  movePage,
  rotatePage,
  setFormFields,
  type Bytes,
  type Color,
  type FormField,
  type Point,
} from '../../shared/pdfOps';
import { findAll, type Match } from '../../shared/search';
import type { DesktopApi, MenuAction, OpenedFile } from '../../shared/ipc';
import { runSliceBox } from './geometry';

declare global {
  interface Window {
    api: DesktopApi;
  }
}
const api = window.api;

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const assets = new URL('./pdfjs/', location.href).href;

// ======================================================================= state

type Tool = 'select' | 'text' | 'highlight' | 'whiteout' | 'ink';

interface PageView {
  index: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  hlLayer: HTMLDivElement;
  overlay: HTMLDivElement;
  viewport: PageViewport;
  rendered: boolean;
}

interface PageText {
  items: TextItem[];
  /** CSS font-family per pdf.js font name, for measuring character positions. */
  fonts: Record<string, string>;
}

const MAX_UNDO = 40;
const MAX_UNDO_BYTES = 400 * 1024 * 1024;

const state = {
  file: null as { path: string | null; name: string } | null,
  bytes: null as Bytes | null,
  savedBytes: null as Bytes | null,
  doc: null as PDFDocumentProxy | null,
  task: null as PDFDocumentLoadingTask | null,
  generation: 0,
  editable: false,
  undo: [] as Bytes[],
  redo: [] as Bytes[],
  tool: 'select' as Tool,
  scale: 1,
  fitWidth: true,
  /** Widest page at scale 1, for fit-width. */
  baseWidth: 0,
  current: 0,
  views: [] as PageView[],
  busy: false,
  // search
  text: null as Promise<PageText[]> | null,
  matches: [] as Match[],
  matchIndex: -1,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const viewerEl = $('viewer');
const pagesEl = $('pages');
const thumbsEl = $('thumbs');
const searchInput = $<HTMLInputElement>('search');
const colorInput = $<HTMLInputElement>('color');
const sizeSelect = $<HTMLSelectElement>('size');

const isDirty = () => state.bytes !== null && state.bytes !== state.savedBytes;

// ======================================================================= ui helpers

let toastTimer = 0;
function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}

function status(message: string) {
  $('status-msg').textContent = message;
}

function refreshChrome() {
  const hasDoc = !!state.doc;
  const canEdit = hasDoc && state.editable && !state.busy;
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-needs-doc]').forEach((b) => (b.disabled = !hasDoc));
  document.querySelectorAll<HTMLButtonElement>('[data-needs-edit]').forEach((b) => (b.disabled = !canEdit));
  ($('btn-save') as HTMLButtonElement).disabled = !canEdit || !isDirty();
  ($('btn-undo') as HTMLButtonElement).disabled = !canEdit || !state.undo.length;
  ($('btn-redo') as HTMLButtonElement).disabled = !canEdit || !state.redo.length;
  const count = state.views.length;
  ($('btn-up') as HTMLButtonElement).disabled ||= state.current === 0;
  ($('btn-down') as HTMLButtonElement).disabled ||= state.current >= count - 1;
  ($('btn-delete') as HTMLButtonElement).disabled ||= count <= 1;
  $('empty').hidden = hasDoc;
  $('zoom-label').textContent = state.fitWidth ? 'Fit' : `${Math.round(state.scale * 100)}%`;
  $('status-file').textContent = state.file ? `${state.file.name}${isDirty() ? ' (edited)' : ''}` : 'No document';
  $('status-page').textContent = hasDoc ? `Page ${state.current + 1} of ${count}` : '';
  document.title = state.file ? `${state.file.name}${isDirty() ? ' •' : ''} — PDF Reader` : 'PDF Reader';
  thumbsEl.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('current', i === state.current));
  api.setDirty(isDirty());
}

function setTool(tool: Tool) {
  if (tool !== 'select' && !state.editable) return;
  state.tool = tool;
  document.body.dataset.tool = tool;
  document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
    b.setAttribute('aria-checked', String(b.dataset.tool === tool));
  });
}

function hexToColor(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ======================================================================= loading & rendering

async function openFile(file: OpenedFile) {
  if (isDirty() && !confirm('Discard unsaved changes to the current document?')) return;
  state.file = { path: file.path, name: file.name };
  state.undo = [];
  state.redo = [];
  state.savedBytes = file.data;
  state.current = 0;
  searchInput.value = '';
  try {
    await loadBytes(file.data, { scrollTo: 0 });
  } catch (err) {
    state.file = null;
    state.bytes = state.savedBytes = null;
    void state.task?.destroy();
    state.task = null;
    state.doc = null;
    pagesEl.replaceChildren();
    thumbsEl.replaceChildren();
    refreshChrome();
    const msg = err instanceof Error && err.name === 'PasswordException'
      ? 'This PDF is password-protected, which is not supported yet.'
      : `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
    toast(msg);
    return;
  }
  state.editable = false;
  setTool('select');
  status('');
  refreshChrome();
  try {
    await assertEditable(file.data);
    state.editable = true;
  } catch (err) {
    status(err instanceof EditError ? err.message : 'This PDF cannot be edited.');
  }
  refreshChrome();
}

interface LoadOptions {
  /** Page index to scroll to after loading; otherwise keep the scroll position. */
  scrollTo?: number;
}

async function loadBytes(bytes: Bytes, opts: LoadOptions = {}) {
  const gen = ++state.generation;
  // Record the target bytes immediately: a concurrent reload (e.g. a resize
  // re-fitting the page width) must render this version, not the previous one.
  state.bytes = bytes;
  const scrollRatio = viewerEl.scrollTop / Math.max(1, viewerEl.scrollHeight);
  // pdf.js transfers the buffer it is given to its worker, so pass a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  });
  const doc = await task.promise;
  if (gen !== state.generation) {
    void task.destroy();
    return;
  }
  const old = state.task;
  state.task = task;
  state.doc = doc;
  state.text = null;
  void old?.destroy();

  const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
  if (gen !== state.generation) return;
  if (state.fitWidth) state.scale = fitScale(pages);
  buildViews(pages);
  buildThumbs(pages);
  state.current = Math.min(state.current, doc.numPages - 1);

  if (opts.scrollTo !== undefined) {
    state.current = opts.scrollTo;
    scrollToPage(opts.scrollTo, 'instant');
  } else {
    viewerEl.scrollTop = scrollRatio * viewerEl.scrollHeight;
  }
  refreshChrome();
  if (searchInput.value.trim()) void runSearch({ keepIndex: true });
  if (!$('forms').hidden) void renderForms();
}

function fitScale(pages?: PDFPageProxy[]): number {
  if (pages) state.baseWidth = Math.max(...pages.map((p) => p.getViewport({ scale: 1 }).width));
  const available = viewerEl.clientWidth - 48;
  return Math.max(0.25, Math.min(4, available / Math.max(1, state.baseWidth)));
}

let observer: IntersectionObserver | null = null;

function buildViews(pages: PDFPageProxy[]) {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const view = state.views[Number((entry.target as HTMLElement).dataset.index)];
        if (view && !view.rendered) void renderPage(view, pages[view.index]);
      }
    },
    { root: viewerEl, rootMargin: '150% 0px' },
  );

  state.views = pages.map((page, index) => {
    const viewport = page.getViewport({ scale: state.scale });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = String(index);
    el.style.width = `${Math.floor(viewport.width)}px`;
    el.style.height = `${Math.floor(viewport.height)}px`;
    el.style.setProperty('--total-scale-factor', String(state.scale));
    el.setAttribute('aria-label', `Page ${index + 1}`);
    const canvas = document.createElement('canvas');
    canvas.className = 'render';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const hlLayer = document.createElement('div');
    hlLayer.className = 'hl-layer';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    el.append(canvas, textLayer, hlLayer, overlay);
    const view: PageView = { index, el, canvas, textLayer, hlLayer, overlay, viewport, rendered: false };
    attachTools(view);
    return view;
  });
  pagesEl.replaceChildren(...state.views.map((v) => v.el));
  state.views.forEach((v) => observer!.observe(v.el));
}

async function renderPage(view: PageView, page: PDFPageProxy) {
  view.rendered = true;
  const gen = state.generation;
  const dpr = window.devicePixelRatio || 1;
  const { viewport, canvas } = view;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  try {
    await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    if (gen !== state.generation) return;
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: view.textLayer,
      viewport,
    });
    await textLayer.render();
  } catch (err) {
    if (gen === state.generation && !(err instanceof Error && err.name === 'RenderingCancelledException')) {
      console.error(err);
    }
  }
  if (gen === state.generation) drawHighlights(view);
}

function buildThumbs(pages: PDFPageProxy[]) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        const i = Number((entry.target as HTMLElement).dataset.index);
        const canvas = entry.target.querySelector('canvas')!;
        const vp = pages[i].getViewport({ scale: (120 / pages[i].getViewport({ scale: 1 }).width) * 2 });
        canvas.width = vp.width;
        canvas.height = vp.height;
        void pages[i].render({ canvas, viewport: vp }).promise.catch(() => {});
      }
    },
    { root: thumbsEl, rootMargin: '200px 0px' },
  );

  const thumbs = pages.map((page, i) => {
    const vp = page.getViewport({ scale: 120 / page.getViewport({ scale: 1 }).width });
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.index = String(i);
    t.draggable = true;
    t.title = 'Click to go to page; drag to reorder';
    const canvas = document.createElement('canvas');
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    t.append(canvas, String(i + 1));
    t.addEventListener('click', () => {
      state.current = i;
      scrollToPage(i);
      refreshChrome();
    });
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('application/x-page-index', String(i));
      e.dataTransfer!.effectAllowed = 'move';
    });
    t.addEventListener('dragover', (e) => {
      if (!e.dataTransfer!.types.includes('application/x-page-index') || !state.editable) return;
      e.preventDefault();
      const after = e.offsetY > t.clientHeight / 2;
      t.classList.toggle('drop-after', after);
      t.classList.toggle('drop-before', !after);
    });
    t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = t.classList.contains('drop-after');
      t.classList.remove('drop-before', 'drop-after');
      const from = Number(e.dataTransfer!.getData('application/x-page-index'));
      let to = i + (after ? 1 : 0);
      if (from < to) to -= 1;
      if (Number.isNaN(from) || from === to) return;
      void applyEdit((b) => movePage(b, from, to), { scrollTo: to });
    });
    io.observe(t);
    return t;
  });
  thumbsEl.replaceChildren(...thumbs);
}

/** While we scroll programmatically, the chosen page stays current. */
let programmaticScroll = false;

function scrollToPage(index: number, behavior: ScrollBehavior = 'smooth') {
  const view = state.views[index];
  if (!view) return;
  const top = Math.max(0, Math.min(view.el.offsetTop - 12, viewerEl.scrollHeight - viewerEl.clientHeight));
  if (Math.abs(viewerEl.scrollTop - top) >= 1) {
    programmaticScroll = behavior === 'smooth';
    viewerEl.scrollTo({ top, behavior });
  }
  thumbsEl.querySelectorAll('.thumb')[index]?.scrollIntoView({ block: 'nearest' });
}

function updateCurrentFromScroll() {
  if (!state.views.length || programmaticScroll) return;
  const mid = viewerEl.scrollTop + viewerEl.clientHeight / 3;
  let current = 0;
  for (const v of state.views) {
    if (v.el.offsetTop <= mid) current = v.index;
    else break;
  }
  if (current !== state.current) {
    state.current = current;
    refreshChrome();
    thumbsEl.querySelectorAll('.thumb')[current]?.scrollIntoView({ block: 'nearest' });
  }
}

async function setZoom(scale: number | 'fit') {
  if (!state.doc || !state.bytes) return;
  state.fitWidth = scale === 'fit';
  if (scale !== 'fit') state.scale = Math.max(0.25, Math.min(4, scale));
  const page = state.current;
  await loadBytes(state.bytes, { scrollTo: page });
}

// ======================================================================= editing

async function applyEdit(fn: (bytes: Bytes) => Promise<Bytes>, opts: LoadOptions = {}) {
  if (!state.bytes || !state.editable || state.busy) return;
  state.busy = true;
  refreshChrome();
  status('Applying…');
  try {
    const before = state.bytes;
    const after = await fn(before);
    if (after === before) return;
    state.undo.push(before);
    let total = state.undo.reduce((n, b) => n + b.byteLength, 0);
    while (state.undo.length > MAX_UNDO || (total > MAX_UNDO_BYTES && state.undo.length > 1)) {
      total -= state.undo.shift()!.byteLength;
    }
    state.redo = [];
    await loadBytes(after, opts);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    if (!(err instanceof EditError)) console.error(err);
  } finally {
    state.busy = false;
    status('');
    refreshChrome();
  }
}

async function undo() {
  if (!state.undo.length || !state.bytes || state.busy) return;
  state.redo.push(state.bytes);
  await loadBytes(state.undo.pop()!);
}

async function redo() {
  if (!state.redo.length || !state.bytes || state.busy) return;
  state.undo.push(state.bytes);
  await loadBytes(state.redo.pop()!);
}

function toPdf(view: PageView, x: number, y: number): Point {
  const [px, py] = view.viewport.convertToPdfPoint(x, y);
  return { x: px, y: py };
}

function localPoint(view: PageView, e: PointerEvent | MouseEvent): [number, number] {
  const r = view.el.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function attachTools(view: PageView) {
  const { overlay } = view;

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.editable || state.busy) return;
    const tool = state.tool;
    if (tool === 'text') {
      e.preventDefault();
      startTextDraft(view, ...localPoint(view, e));
      return;
    }
    if (tool !== 'highlight' && tool !== 'whiteout' && tool !== 'ink') return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    const [x0, y0] = localPoint(view, e);

    if (tool === 'ink') {
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      const line = document.createElementNS(svgNS, 'polyline');
      const width = Number(sizeSelect.value) / 6;
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', colorInput.value);
      line.setAttribute('stroke-width', String(width * state.scale));
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-linejoin', 'round');
      svg.append(line);
      overlay.append(svg);
      const pts: [number, number][] = [[x0, y0]];
      const draw = () => line.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      draw();
      const move = (ev: PointerEvent) => {
        const p = localPoint(view, ev);
        const last = pts[pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) {
          pts.push(p);
          draw();
        }
      };
      const up = () => {
        overlay.removeEventListener('pointermove', move);
        overlay.removeEventListener('pointerup', up);
        overlay.removeEventListener('pointercancel', up);
        if (pts.length < 2) pts.push([x0 + 0.5, y0 + 0.5]); // a click makes a dot
        const points = pts.map(([x, y]) => toPdf(view, x, y));
        void applyEdit((b) =>
          addInk(b, { page: view.index, points, width, color: hexToColor(colorInput.value) }),
        ).finally(() => svg.remove());
      };
      overlay.addEventListener('pointermove', move);
      overlay.addEventListener('pointerup', up);
      overlay.addEventListener('pointercancel', up);
      return;
    }

    // highlight / white-out rectangle
    const box = document.createElement('div');
    box.className = `draft-rect ${tool}`;
    overlay.append(box);
    let x1 = x0;
    let y1 = y0;
    const place = () => {
      Object.assign(box.style, {
        left: `${Math.min(x0, x1)}px`,
        top: `${Math.min(y0, y1)}px`,
        width: `${Math.abs(x1 - x0)}px`,
        height: `${Math.abs(y1 - y0)}px`,
      });
    };
    place();
    const move = (ev: PointerEvent) => {
      [x1, y1] = localPoint(view, ev);
      x1 = Math.max(0, Math.min(view.viewport.width, x1));
      y1 = Math.max(0, Math.min(view.viewport.height, y1));
      place();
    };
    const up = () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', up);
      if (Math.abs(x1 - x0) < 3 || Math.abs(y1 - y0) < 3) {
        box.remove();
        return;
      }
      const a = toPdf(view, x0, y0);
      const b2 = toPdf(view, x1, y1);
      void applyEdit((b) => addRect(b, { page: view.index, a, b: b2, kind: tool })).finally(() => box.remove());
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', up);
  });
}

function startTextDraft(view: PageView, x: number, y: number) {
  document.querySelector('.text-draft')?.dispatchEvent(new Event('commit'));
  const size = Number(sizeSelect.value);
  const fontPx = size * state.scale;
  const ta = document.createElement('textarea');
  ta.className = 'text-draft';
  ta.rows = 1;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', 'New text');
  Object.assign(ta.style, {
    left: `${x - 1}px`,
    top: `${y - 1}px`,
    fontSize: `${fontPx}px`,
    color: colorInput.value,
  });
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
    ta.style.width = 'auto';
    ta.style.width = `${Math.max(ta.scrollWidth + 4, fontPx * 4)}px`;
  };
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const lines = ta.value.split('\n');
    ta.remove();
    if (!commit || !ta.value.trim()) return;
    const lineHeight = fontPx * 1.2;
    // Baseline of each line, matching where the textarea showed it.
    const edits = lines.map((text, i) => ({
      text,
      at: toPdf(view, x, y + i * lineHeight + fontPx * 0.1 + fontPx * 0.8),
    }));
    void applyEdit((b) => addText(b, { page: view.index, lines: edits, size, color: hexToColor(colorInput.value) }));
  };
  ta.addEventListener('input', resize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
  });
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('commit', () => finish(true));
  view.overlay.append(ta);
  resize();
  requestAnimationFrame(() => ta.focus());
}

// ======================================================================= page actions

function pageAction(action: 'rotL' | 'rotR' | 'up' | 'down' | 'blank' | 'delete') {
  const i = state.current;
  switch (action) {
    case 'rotL':
      return applyEdit((b) => rotatePage(b, i, -90), { scrollTo: i });
    case 'rotR':
      return applyEdit((b) => rotatePage(b, i, 90), { scrollTo: i });
    case 'up':
      return i > 0 && applyEdit((b) => movePage(b, i, i - 1), { scrollTo: i - 1 });
    case 'down':
      return i < state.views.length - 1 && applyEdit((b) => movePage(b, i, i + 1), { scrollTo: i + 1 });
    case 'blank':
      return applyEdit((b) => insertBlankPage(b, i), { scrollTo: i + 1 });
    case 'delete':
      if (!confirm(`Delete page ${i + 1}?`)) return;
      return applyEdit((b) => deletePage(b, i), { scrollTo: Math.max(0, i - 1) });
  }
}

async function insertFromPdf() {
  if (!state.editable) return;
  const other = await api.openDialog();
  if (!other) return;
  const i = state.current;
  await applyEdit((b) => insertPdf(b, other.data, i), { scrollTo: i + 1 });
}

// ======================================================================= files

async function doOpen() {
  try {
    const f = await api.openDialog();
    if (f) await openFile(f);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

async function doOpenPath(path: string) {
  try {
    await openFile(await api.openPath(path));
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

async function doSave(asNew = false) {
  if (!state.bytes || !state.file) return;
  try {
    if (!asNew && state.file.path) {
      await api.save(state.file.path, state.bytes);
      status('Saved');
    } else {
      const r = await api.saveAs(state.file.name, state.bytes);
      if (!r) return;
      state.file = { path: r.path, name: r.name };
      status(`Saved as ${r.name}`);
    }
    state.savedBytes = state.bytes;
    refreshChrome();
  } catch (err) {
    toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ======================================================================= search

function pageText(): Promise<PageText[]> {
  const doc = state.doc!;
  state.text ??= Promise.all(
    Array.from({ length: doc.numPages }, async (_, i) => {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      const fonts: Record<string, string> = {};
      for (const [name, style] of Object.entries(content.styles)) fonts[name] = style.fontFamily;
      return { items: content.items.filter((it): it is TextItem => 'str' in it), fonts };
    }),
  );
  return state.text;
}

const measureCtx = document.createElement('canvas').getContext('2d')!;
function measurerFor(fontFamily: string | undefined) {
  return (text: string) => {
    measureCtx.font = `100px ${fontFamily || 'sans-serif'}`;
    return measureCtx.measureText(text).width;
  };
}

let searchSeq = 0;

async function runSearch({ keepIndex = false } = {}) {
  const query = searchInput.value;
  const seq = ++searchSeq;
  const count = $('search-count');
  if (!state.doc || !query.trim()) {
    state.matches = [];
    state.matchIndex = -1;
    count.textContent = '';
    state.views.forEach(drawHighlights);
    return;
  }
  count.textContent = 'Searching…';
  const text = await pageText();
  if (seq !== searchSeq) return;
  state.matches = findAll(text.map((p) => p.items), query, {
    caseSensitive: $('btn-case').getAttribute('aria-pressed') === 'true',
    wholeWord: $('btn-word').getAttribute('aria-pressed') === 'true',
  });
  if (!state.matches.length) {
    state.matchIndex = -1;
  } else if (keepIndex && state.matchIndex >= 0) {
    state.matchIndex = Math.min(state.matchIndex, state.matches.length - 1);
  } else {
    // Start from the first match at or after the current page.
    const idx = state.matches.findIndex((m) => m.page >= state.current);
    state.matchIndex = idx === -1 ? 0 : idx;
  }
  updateSearchCount();
  state.views.forEach(drawHighlights);
  if (!keepIndex) revealMatch();
}

function updateSearchCount() {
  const n = state.matches.length;
  $('search-count').textContent = searchInput.value.trim() ? (n ? `${state.matchIndex + 1} of ${n}` : 'No matches') : '';
}

function stepMatch(delta: number) {
  const n = state.matches.length;
  if (!n) return;
  state.matchIndex = (state.matchIndex + delta + n) % n;
  updateSearchCount();
  state.views.forEach(drawHighlights);
  revealMatch();
}

function revealMatch() {
  const m = state.matches[state.matchIndex];
  if (!m) return;
  const view = state.views[m.page];
  state.current = m.page;
  refreshChrome();
  const box = view.hlLayer.querySelector<HTMLElement>('.hl.current');
  if (box) {
    programmaticScroll = true;
    viewerEl.scrollTo({ top: view.el.offsetTop + box.offsetTop - viewerEl.clientHeight / 3, behavior: 'smooth' });
  } else {
    scrollToPage(m.page);
  }
}

function drawHighlights(view: PageView) {
  view.hlLayer.replaceChildren();
  if (!state.matches.length || !state.text) return;
  void state.text.then((pages) => {
    const page = pages[view.index];
    if (!page) return;
    const { items, fonts } = page;
    const toViewport = (x: number, y: number) => view.viewport.convertToViewportPoint(x, y) as [number, number];
    const frag = document.createDocumentFragment();
    state.matches.forEach((m, mi) => {
      if (m.page !== view.index) return;
      for (const seg of m.segments) {
        const run = items[seg.item];
        const r = run && runSliceBox(run, seg.start, seg.end, toViewport, measurerFor(fonts[run.fontName]));
        if (!r) continue;
        const el = document.createElement('div');
        el.className = mi === state.matchIndex ? 'hl current' : 'hl';
        Object.assign(el.style, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
        frag.append(el);
      }
    });
    view.hlLayer.replaceChildren(frag);
  });
}

// ======================================================================= forms

async function toggleForms(force?: boolean) {
  const panel = $('forms');
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  $('btn-forms').setAttribute('aria-pressed', String(open));
  if (open) await renderForms();
}

async function renderForms() {
  const body = $('forms-body');
  if (!state.bytes) return body.replaceChildren();
  const fields = await getFormFields(state.bytes);
  if (!fields.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = state.editable ? 'This PDF has no fillable form fields.' : 'Form fields cannot be edited in this PDF.';
    return body.replaceChildren(p);
  }
  const inputs = new Map<string, () => string | boolean>();
  const rows = fields.map((f: FormField) => {
    const label = document.createElement('label');
    if (f.type === 'checkbox') {
      label.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.value;
      cb.disabled = f.readOnly;
      label.append(cb, f.name);
      inputs.set(f.name, () => cb.checked);
    } else if (f.type === 'choice') {
      label.append(f.name);
      const sel = document.createElement('select');
      sel.disabled = f.readOnly;
      for (const o of ['', ...f.options]) sel.add(new Option(o || '—', o, false, o === f.value));
      label.append(sel);
      inputs.set(f.name, () => sel.value);
    } else {
      label.append(f.name);
      const input = f.multiline ? document.createElement('textarea') : document.createElement('input');
      input.value = f.value;
      input.disabled = f.readOnly;
      label.append(input);
      inputs.set(f.name, () => input.value);
    }
    return label;
  });
  const apply = document.createElement('button');
  apply.className = 'apply';
  apply.textContent = 'Apply to document';
  apply.disabled = !state.editable;
  apply.addEventListener('click', async () => {
    const values: Record<string, string | boolean> = {};
    for (const [name, get] of inputs) values[name] = get();
    await applyEdit((b) => setFormFields(b, values));
    await renderForms();
  });
  body.replaceChildren(...rows, apply);
}

// ======================================================================= wiring

const on = (id: string, fn: () => unknown) => $(id).addEventListener('click', () => void fn());
on('btn-open', doOpen);
on('btn-open-empty', doOpen);
on('btn-save', () => doSave(false));
on('btn-save-as', () => doSave(true));
on('btn-undo', undo);
on('btn-redo', redo);
on('btn-rot-l', () => pageAction('rotL'));
on('btn-rot-r', () => pageAction('rotR'));
on('btn-up', () => pageAction('up'));
on('btn-down', () => pageAction('down'));
on('btn-blank', () => pageAction('blank'));
on('btn-delete', () => pageAction('delete'));
on('btn-insert', insertFromPdf);
on('btn-zoom-in', () => setZoom(state.scale * 1.2));
on('btn-zoom-out', () => setZoom(state.scale / 1.2));
on('btn-fit', () => setZoom('fit'));
on('btn-prev', () => stepMatch(-1));
on('btn-next', () => stepMatch(1));
on('btn-forms', () => toggleForms());
for (const id of ['btn-case', 'btn-word']) {
  on(id, () => {
    const b = $(id);
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    return runSearch();
  });
}
document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)),
);

let searchTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 200);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (!state.matches.length) void runSearch();
    else stepMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    void runSearch();
    viewerEl.focus();
  }
});

viewerEl.addEventListener('scroll', updateCurrentFromScroll, { passive: true });
viewerEl.addEventListener('scrollend', () => (programmaticScroll = false));
// A user scroll gesture takes over from any programmatic scroll.
for (const ev of ['wheel', 'touchstart', 'keydown'] as const) {
  viewerEl.addEventListener(ev, () => (programmaticScroll = false), { passive: true });
}

let resizeTimer = 0;
new ResizeObserver(() => {
  if (!state.fitWidth || !state.bytes) return;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (state.busy || Math.abs(fitScale() - state.scale) < 0.01) return;
    void setZoom('fit');
  }, 250);
}).observe(viewerEl);

// Drop a PDF anywhere in the viewer to open it.
viewerEl.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  viewerEl.classList.add('drag-over');
});
viewerEl.addEventListener('dragleave', () => viewerEl.classList.remove('drag-over'));
viewerEl.addEventListener('drop', (e) => {
  viewerEl.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  const path = api.pathForFile(file);
  if (path) void doOpenPath(path);
});

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

document.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    void (e.shiftKey ? redo() : undo());
  } else if (mod && key === 'y') {
    e.preventDefault();
    void redo();
  } else if (!mod && !e.altKey && state.doc) {
    const tools: Record<string, Tool> = { v: 'select', t: 'text', h: 'highlight', w: 'whiteout', d: 'ink' };
    if (key === 'escape') setTool('select');
    else if (tools[key]) setTool(tools[key]);
  }
});

const menuActions: Record<MenuAction, () => unknown> = {
  open: doOpen,
  save: () => doSave(false),
  saveAs: () => doSave(true),
  insertPdf: insertFromPdf,
  find: () => {
    searchInput.focus();
    searchInput.select();
  },
  zoomIn: () => setZoom(state.scale * 1.2),
  zoomOut: () => setZoom(state.scale / 1.2),
  fitWidth: () => setZoom('fit'),
};
api.onMenu((action) => void menuActions[action]?.());
api.onOpenRequest((path) => void doOpenPath(path));

setTool('select');
refreshChrome();
void api.takePendingOpen().then((p) => {
  if (p) void doOpenPath(p);
});
