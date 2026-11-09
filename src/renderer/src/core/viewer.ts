/**
 * Renders the open document: lazily rendered pages with a selectable text
 * layer, a decoration layer (search hits, redaction marks…) and an
 * interaction overlay that the active tool plugs into.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { movePage } from '../../../shared/pdfOps';
import type { Point } from '../../../shared/pdfOps';
import { h } from '../ui/dom';
import { applyEdit, doc, emit, on, setCurrent, takeScrollTarget } from './doc';

export interface PageView {
  index: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  decor: HTMLDivElement;
  overlay: HTMLDivElement;
  viewport: PageViewport;
  rendered: boolean;
}

export interface Interaction {
  cursor: string;
  /** Called on primary-button pointerdown over a page. */
  down(view: PageView, e: PointerEvent, x: number, y: number): void;
  /** Optional hover feedback. */
  move?(view: PageView, e: PointerEvent, x: number, y: number): void;
  leave?(view: PageView): void;
}

type Decorator = (view: PageView) => Node[] | Promise<Node[]>;

export const view = {
  scale: 1,
  fitWidth: true,
  baseWidth: 0,
  views: [] as PageView[],
  pages: [] as PDFPageProxy[],
};

let viewerEl: HTMLElement;
let pagesEl: HTMLElement;
let thumbsEl: HTMLElement;
let interaction: Interaction | null = null;
const decorators = new Map<string, Decorator>();
let observer: IntersectionObserver | null = null;
/** While we scroll programmatically, the chosen page stays current. */
let programmaticScroll = false;

export function initViewer(viewer: HTMLElement, pages: HTMLElement, thumbs: HTMLElement) {
  viewerEl = viewer;
  pagesEl = pages;
  thumbsEl = thumbs;

  on('loaded', () => void rebuild());
  on('closed', () => {
    observer?.disconnect();
    view.views = [];
    view.pages = [];
    pagesEl.replaceChildren();
    thumbsEl.replaceChildren();
  });
  on('current', () => highlightThumb());

  viewerEl.addEventListener('scroll', updateCurrentFromScroll, { passive: true });
  viewerEl.addEventListener('scrollend', () => (programmaticScroll = false));
  for (const ev of ['wheel', 'touchstart', 'keydown'] as const) {
    viewerEl.addEventListener(ev, () => (programmaticScroll = false), { passive: true });
  }
  // Ctrl/Cmd + wheel zooms.
  viewerEl.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !doc.pdf) return;
      e.preventDefault();
      void setZoom(view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );

  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (!view.fitWidth || !doc.pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (doc.busy || Math.abs(fitScale() - view.scale) < 0.01) return;
      void setZoom('fit');
    }, 200);
  }).observe(viewerEl);
}

function fitScale(): number {
  const available = viewerEl.clientWidth - 72;
  return Math.max(0.25, Math.min(3, available / Math.max(1, Math.min(view.baseWidth, 1100))));
}

async function rebuild() {
  const pdf = doc.pdf;
  if (!pdf) return;
  const gen = doc.generation;
  const scrollRatio = viewerEl.scrollTop / Math.max(1, viewerEl.scrollHeight);
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  if (gen !== doc.generation) return;
  view.pages = pages;
  view.baseWidth = Math.max(...pages.map((p) => p.getViewport({ scale: 1 }).width));
  if (view.fitWidth) view.scale = fitScale();
  buildViews(pages);
  buildThumbs(pages);
  const target = takeScrollTarget();
  if (target !== undefined) scrollToPage(target, 'instant');
  else viewerEl.scrollTop = scrollRatio * viewerEl.scrollHeight;
  emit('state');
}

function buildViews(pages: PDFPageProxy[]) {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const v = view.views[Number((entry.target as HTMLElement).dataset.index)];
        if (v && !v.rendered) void renderPage(v, pages[v.index]);
      }
    },
    { root: viewerEl, rootMargin: '150% 0px' },
  );

  view.views = pages.map((page, index) => {
    const viewport = page.getViewport({ scale: view.scale });
    const canvas = h('canvas', { class: 'render' });
    const textLayer = h('div', { class: 'textLayer' });
    const decor = h('div', { class: 'decor' });
    const overlay = h('div', { class: 'overlay' });
    const el = h(
      'div',
      {
        class: 'page',
        dataset: { index: String(index) },
        style: { width: `${Math.floor(viewport.width)}px`, height: `${Math.floor(viewport.height)}px` },
        attrs: { 'aria-label': `Page ${index + 1}` },
      },
      canvas,
      textLayer,
      decor,
      overlay,
      h('div', { class: 'page-number' }, String(index + 1)),
    );
    el.style.setProperty('--total-scale-factor', String(view.scale));
    const pv: PageView = { index, el, canvas, textLayer, decor, overlay, viewport, rendered: false };
    attachInteraction(pv);
    return pv;
  });
  pagesEl.replaceChildren(...view.views.map((v) => v.el));
  view.views.forEach((v) => observer!.observe(v.el));
}

async function renderPage(pv: PageView, page: PDFPageProxy) {
  pv.rendered = true;
  const gen = doc.generation;
  const dpr = window.devicePixelRatio || 1;
  const { viewport, canvas } = pv;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  try {
    await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    if (gen !== doc.generation) return;
    pv.el.classList.add('ready');
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: pv.textLayer, viewport }).render();
  } catch (err) {
    if (gen === doc.generation && !(err instanceof Error && err.name === 'RenderingCancelledException')) console.error(err);
  }
  if (gen === doc.generation) void decorate(pv);
}

/** Render a page to a canvas of the given CSS width (thumbnails, grids, compare). */
export async function renderToCanvas(pdf: PDFDocumentProxy | PDFPageProxy, index: number, cssWidth: number, canvas = h('canvas')) {
  const page = 'getPage' in pdf ? await pdf.getPage(index + 1) : pdf;
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (cssWidth / base.width) * Math.min(2, window.devicePixelRatio || 1) });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
  await page.render({ canvas, viewport: vp }).promise.catch(() => {});
  return canvas;
}

// ---------------------------------------------------------------- thumbnails

function buildThumbs(pages: PDFPageProxy[]) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        const i = Number((entry.target as HTMLElement).dataset.index);
        void renderToCanvas(pages[i], i, 112, entry.target.querySelector('canvas')!);
      }
    },
    { root: thumbsEl, rootMargin: '300px 0px' },
  );

  const thumbs = pages.map((page, i) => {
    const vp = page.getViewport({ scale: 112 / page.getViewport({ scale: 1 }).width });
    const canvas = h('canvas', { style: { width: '112px', height: `${vp.height}px` } });
    const t = h(
      'div',
      { class: 'thumb', dataset: { index: String(i) }, draggable: true, title: 'Click to go to page · drag to reorder' },
      h('div', { class: 'thumb-frame' }, canvas),
      h('span', { class: 'thumb-num' }, String(i + 1)),
    );
    t.addEventListener('click', () => {
      setCurrent(i);
      scrollToPage(i);
    });
    wireReorder(t, i);
    io.observe(t);
    return t;
  });
  thumbsEl.replaceChildren(...thumbs);
  highlightThumb();
}

/** Drag-to-reorder on any list of page tiles; dropping moves the page in the document. */
export function wireReorder(tile: HTMLElement, index: number, horizontal = false) {
  const MIME = 'application/x-page-index';
  tile.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData(MIME, String(index));
    e.dataTransfer!.effectAllowed = 'move';
    tile.classList.add('dragging');
  });
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
  tile.addEventListener('dragover', (e) => {
    if (!e.dataTransfer!.types.includes(MIME) || !doc.editable) return;
    e.preventDefault();
    const r = tile.getBoundingClientRect();
    const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    tile.classList.toggle('drop-after', after);
    tile.classList.toggle('drop-before', !after);
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-before', 'drop-after'));
  tile.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const after = tile.classList.contains('drop-after');
    tile.classList.remove('drop-before', 'drop-after');
    const from = Number(e.dataTransfer!.getData(MIME));
    let to = index + (after ? 1 : 0);
    if (from < to) to -= 1;
    if (Number.isNaN(from) || from === to) return;
    void applyEdit((b) => movePage(b, from, to), { scrollTo: to, label: `Moved page ${from + 1} to position ${to + 1}` });
  });
}

function highlightThumb() {
  thumbsEl.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('current', i === doc.current));
  thumbsEl.querySelectorAll('.thumb')[doc.current]?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- scrolling & zoom

export function scrollToPage(index: number, behavior: ScrollBehavior = 'smooth', offsetY = 0) {
  const pv = view.views[index];
  if (!pv) return;
  const top = Math.max(0, Math.min(pv.el.offsetTop - 16 + offsetY, viewerEl.scrollHeight - viewerEl.clientHeight));
  if (Math.abs(viewerEl.scrollTop - top) >= 1) {
    programmaticScroll = behavior === 'smooth';
    viewerEl.scrollTo({ top, behavior });
  }
}

export function scrollIntoViewport(pv: PageView, y: number) {
  programmaticScroll = true;
  viewerEl.scrollTo({ top: pv.el.offsetTop + y - viewerEl.clientHeight / 3, behavior: 'smooth' });
}

function updateCurrentFromScroll() {
  if (!view.views.length || programmaticScroll) return;
  const mid = viewerEl.scrollTop + viewerEl.clientHeight / 3;
  let current = 0;
  for (const v of view.views) {
    if (v.el.offsetTop <= mid) current = v.index;
    else break;
  }
  setCurrent(current);
}

export async function setZoom(scale: number | 'fit') {
  if (!doc.pdf || !doc.bytes) return;
  view.fitWidth = scale === 'fit';
  view.scale = scale === 'fit' ? fitScale() : Math.max(0.25, Math.min(4, scale));
  const page = doc.current;
  const within = (viewerEl.scrollTop - (view.views[page]?.el.offsetTop ?? 0)) / Math.max(1, view.views[page]?.el.offsetHeight ?? 1);
  buildViews(view.pages);
  scrollToPage(page, 'instant', within * (view.views[page]?.el.offsetHeight ?? 0));
  emit('state');
}

// ---------------------------------------------------------------- tools & decorations

export function setInteraction(next: Interaction | null) {
  interaction = next;
  document.body.classList.toggle('interacting', !!next);
  document.body.style.setProperty('--tool-cursor', next?.cursor ?? 'default');
}

function attachInteraction(pv: PageView) {
  pv.overlay.addEventListener('pointerdown', (e) => {
    if (!interaction || e.button !== 0) return;
    const [x, y] = localPoint(pv, e);
    interaction.down(pv, e, x, y);
  });
  pv.overlay.addEventListener('pointermove', (e) => {
    if (!interaction?.move) return;
    const [x, y] = localPoint(pv, e);
    interaction.move(pv, e, x, y);
  });
  pv.overlay.addEventListener('pointerleave', () => interaction?.leave?.(pv));
}

export function localPoint(pv: PageView, e: { clientX: number; clientY: number }): [number, number] {
  const r = pv.el.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

export function toPdf(pv: PageView, x: number, y: number): Point {
  const [px, py] = pv.viewport.convertToPdfPoint(x, y);
  return { x: px, y: py };
}

export function toViewport(pv: PageView, p: Point): [number, number] {
  return pv.viewport.convertToViewportPoint(p.x, p.y) as [number, number];
}

/** Track a drag from pointerdown until release; returns a promise of the end point. */
export function drag(
  pv: PageView,
  e: PointerEvent,
  onMove: (x: number, y: number) => void,
): Promise<[number, number]> {
  e.preventDefault();
  pv.overlay.setPointerCapture(e.pointerId);
  return new Promise((resolve) => {
    let last = localPoint(pv, e);
    const move = (ev: PointerEvent) => {
      last = localPoint(pv, ev);
      last = [Math.max(0, Math.min(pv.viewport.width, last[0])), Math.max(0, Math.min(pv.viewport.height, last[1]))];
      onMove(...last);
    };
    const up = () => {
      pv.overlay.removeEventListener('pointermove', move);
      pv.overlay.removeEventListener('pointerup', up);
      pv.overlay.removeEventListener('pointercancel', up);
      resolve(last);
    };
    pv.overlay.addEventListener('pointermove', move);
    pv.overlay.addEventListener('pointerup', up);
    pv.overlay.addEventListener('pointercancel', up);
  });
}

/** Register a named decoration layer; call `redecorate()` when its data changes. */
export function setDecorator(key: string, fn: Decorator | null) {
  if (fn) decorators.set(key, fn);
  else decorators.delete(key);
  redecorate();
}

export function redecorate() {
  for (const pv of view.views) if (pv.rendered) void decorate(pv);
}

async function decorate(pv: PageView) {
  const gen = doc.generation;
  const nodes = (await Promise.all([...decorators.values()].map((fn) => fn(pv)))).flat();
  if (gen === doc.generation) pv.decor.replaceChildren(...nodes);
}

export const getView = (i: number) => view.views[i];
