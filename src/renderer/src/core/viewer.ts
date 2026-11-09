/**
 * Renders the open document: pages with a selectable text layer, a
 * decoration layer (search hits, redaction marks…) and an interaction overlay
 * that the active tool plugs into.
 *
 * Updates are flicker-free: every page is drawn into a detached canvas and
 * swapped in only when complete. After an edit that keeps the page layout,
 * existing page elements are reused and only the pages that changed are
 * redrawn; zooming stretches the current pixels immediately and sharpens them
 * when the new rendering is ready.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { movePage } from '../../../shared/pdfOps';
import type { Point } from '../../../shared/pdfOps';
import { h } from '../ui/dom';
import { applyEdit, doc, emit, on, setCurrent, takeChangedPages, takeScrollTarget } from './doc';

export interface PageView {
  index: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  decor: HTMLDivElement;
  overlay: HTMLDivElement;
  page: PDFPageProxy;
  viewport: PageViewport;
  /** The content shown is up to date for the current document version and scale. */
  rendered: boolean;
  /** Incremented per render request so stale renders are dropped. */
  token: number;
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
  /** Unscaled size + rotation of each page, to detect layout changes. */
  layout: [] as string[],
};

let viewerEl: HTMLElement;
let pagesEl: HTMLElement;
let thumbsEl: HTMLElement;
let interaction: Interaction | null = null;
const decorators = new Map<string, Decorator>();
let observer: IntersectionObserver | null = null;
/** Pages currently within (or near) the viewport. */
const near = new Set<number>();
/** While we scroll programmatically, the chosen page stays current. */
let programmaticScroll = false;

export function initViewer(viewer: HTMLElement, pages: HTMLElement, thumbs: HTMLElement) {
  viewerEl = viewer;
  pagesEl = pages;
  thumbsEl = thumbs;

  on('loaded', () => void refresh());
  on('closed', () => {
    observer?.disconnect();
    near.clear();
    view.views = [];
    view.pages = [];
    view.layout = [];
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
    }, 150);
  }).observe(viewerEl);
}

function fitScale(): number {
  const available = viewerEl.clientWidth - 72;
  return Math.max(0.25, Math.min(3, available / Math.max(1, Math.min(view.baseWidth, 1100))));
}

const layoutKey = (p: PDFPageProxy) => {
  const v = p.getViewport({ scale: 1 });
  return `${v.width.toFixed(2)}x${v.height.toFixed(2)}`;
};

/** Called whenever a new version of the document has loaded. */
async function refresh() {
  const pdf = doc.pdf;
  if (!pdf) return;
  const gen = doc.generation;
  const changed = takeChangedPages();
  const target = takeScrollTarget();
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  if (gen !== doc.generation) return;
  const layout = pages.map(layoutKey);
  const sameLayout = view.views.length > 0 && layout.length === view.layout.length && layout.every((k, i) => k === view.layout[i]);
  view.pages = pages;
  view.layout = layout;
  view.baseWidth = Math.max(...pages.map((p) => p.getViewport({ scale: 1 }).width));

  if (sameLayout) {
    // Same pages, same sizes: keep everything on screen and redraw only what changed.
    view.views.forEach((pv, i) => {
      pv.page = pages[i];
      pv.viewport = pages[i].getViewport({ scale: view.scale });
      if (changed && !changed.has(i)) return;
      pv.rendered = false;
      if (near.has(i)) void renderPage(pv);
    });
    refreshThumbs(pages, changed);
    redecorate();
    if (target !== undefined) scrollToPage(target, 'instant');
  } else {
    if (view.fitWidth) view.scale = fitScale();
    const anchor = target ?? doc.current;
    await replaceViews(pages, anchor);
    if (gen !== doc.generation) return;
    await buildThumbs(pages);
  }
  emit('state');
}

function createView(page: PDFPageProxy, index: number): PageView {
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
  const pv: PageView = { index, el, canvas, textLayer, decor, overlay, page, viewport, rendered: false, token: 0 };
  attachInteraction(pv);
  return pv;
}

function observe() {
  observer?.disconnect();
  near.clear();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const i = Number((entry.target as HTMLElement).dataset.index);
        if (entry.isIntersecting) {
          near.add(i);
          const pv = view.views[i];
          if (pv && !pv.rendered) void renderPage(pv);
        } else near.delete(i);
      }
    },
    { root: viewerEl, rootMargin: '120% 0px' },
  );
  view.views.forEach((v) => observer!.observe(v.el));
}

/**
 * The page layout changed (pages added, removed, rotated or resized): build
 * the new pages off-screen, draw the ones that will be visible, then swap.
 */
async function replaceViews(pages: PDFPageProxy[], anchor: number) {
  const gen = doc.generation;
  const views = pages.map((p, i) => createView(p, i));
  const visible = [anchor - 1, anchor, anchor + 1, anchor + 2].filter((i) => i >= 0 && i < views.length);
  // Draw what will be on screen first (bounded, so a slow page can't stall the swap).
  await Promise.race([Promise.all(visible.map((i) => renderPage(views[i], true))), new Promise((r) => setTimeout(r, 700))]);
  if (gen !== doc.generation) return;
  view.views = views;
  pagesEl.replaceChildren(...views.map((v) => v.el));
  scrollToPage(Math.min(anchor, views.length - 1), 'instant');
  observe();
}

async function renderPage(pv: PageView, detached = false) {
  const token = ++pv.token;
  pv.rendered = true;
  const gen = doc.generation;
  const dpr = window.devicePixelRatio || 1;
  const { viewport, page } = pv;
  const scale = view.scale;
  const canvas = h('canvas', { class: 'render' });
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  try {
    await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
  } catch (err) {
    if (!(err instanceof Error && err.name === 'RenderingCancelledException')) console.error(err);
    if (token === pv.token) pv.rendered = false;
    return;
  }
  if (token !== pv.token || gen !== doc.generation) return;
  // Swap the finished canvas in; the old one stays visible until now.
  pv.canvas.replaceWith(canvas);
  pv.canvas = canvas;
  pv.el.style.setProperty('--total-scale-factor', String(scale));
  const textLayer = h('div', { class: 'textLayer' });
  try {
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render();
  } catch {
    /* text selection is best-effort */
  }
  if (token !== pv.token) return;
  pv.textLayer.replaceWith(textLayer);
  pv.textLayer = textLayer;
  if (!detached) void decorate(pv);
  else queueMicrotask(() => void decorate(pv));
}

/** Render a page to a canvas of the given CSS width (thumbnails, grids, compare). */
export async function renderToCanvas(pdf: PDFDocumentProxy | PDFPageProxy, index: number, cssWidth: number, canvas = h('canvas')) {
  const page = 'getPage' in pdf ? await pdf.getPage(index + 1) : pdf;
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (cssWidth / base.width) * Math.min(2, window.devicePixelRatio || 1) });
  // Draw off-screen, then copy, so an existing thumbnail never blanks.
  const off = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  await page.render({ canvas: off, viewport: vp }).promise.catch(() => {});
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.getContext('2d')!.drawImage(off, 0, 0);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
  return canvas;
}

// ---------------------------------------------------------------- thumbnails

function thumbTile(i: number, canvas: HTMLCanvasElement) {
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
  return t;
}

let thumbObserver: IntersectionObserver | null = null;

async function buildThumbs(pages: PDFPageProxy[]) {
  const gen = doc.generation;
  thumbObserver?.disconnect();
  const canvases = pages.map((page) => {
    const vp = page.getViewport({ scale: 112 / page.getViewport({ scale: 1 }).width });
    return h('canvas', { style: { width: '112px', height: `${vp.height}px` } });
  });
  // Draw the thumbnails around the current page before swapping the list in.
  const first = Math.max(0, doc.current - 3);
  const visible = canvases.slice(first, first + 8).map((c, k) => renderToCanvas(pages[first + k], first + k, 112, c));
  await Promise.race([Promise.all(visible), new Promise((r) => setTimeout(r, 400))]);
  if (gen !== doc.generation) return;
  const done = new Set(Array.from({ length: Math.min(8, pages.length - first) }, (_, k) => first + k));
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver!.unobserve(entry.target);
        const i = Number((entry.target as HTMLElement).dataset.index);
        if (!done.has(i)) void renderToCanvas(pages[i], i, 112, canvases[i]);
      }
    },
    { root: thumbsEl, rootMargin: '300px 0px' },
  );
  const tiles = pages.map((_, i) => thumbTile(i, canvases[i]));
  thumbsEl.replaceChildren(...tiles);
  tiles.forEach((t) => thumbObserver!.observe(t));
  highlightThumb();
}

/** Same layout: redraw only the changed thumbnails, in place. */
function refreshThumbs(pages: PDFPageProxy[], changed: Set<number> | null) {
  thumbsEl.querySelectorAll<HTMLElement>('.thumb').forEach((t, i) => {
    if (changed && !changed.has(i)) return;
    const canvas = t.querySelector('canvas');
    if (canvas && canvas.width) void renderToCanvas(pages[i], i, 112, canvas);
  });
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

let zoomTimer = 0;

/**
 * Zoom: resize the pages immediately (the current pixels stretch to fit),
 * keep the same spot in view, then re-render visible pages sharply.
 */
export async function setZoom(scale: number | 'fit') {
  if (!doc.pdf || !view.views.length) return;
  view.fitWidth = scale === 'fit';
  const next = scale === 'fit' ? fitScale() : Math.max(0.25, Math.min(4, scale));
  if (Math.abs(next - view.scale) < 1e-3) return emit('state');
  const page = doc.current;
  const anchorEl = view.views[page]?.el;
  const within = anchorEl ? (viewerEl.scrollTop - anchorEl.offsetTop) / Math.max(1, anchorEl.offsetHeight) : 0;
  view.scale = next;
  for (const pv of view.views) {
    pv.viewport = pv.page.getViewport({ scale: next });
    pv.el.style.width = `${Math.floor(pv.viewport.width)}px`;
    pv.el.style.height = `${Math.floor(pv.viewport.height)}px`;
    pv.rendered = false;
    pv.token++; // drop in-flight renders at the old scale
    pv.textLayer.style.visibility = 'hidden'; // re-created at the new scale
  }
  const el = view.views[page]?.el;
  if (el) viewerEl.scrollTop = el.offsetTop + within * el.offsetHeight;
  redecorate();
  emit('state');
  // Re-render once zooming pauses (Ctrl+wheel sends many steps).
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => {
    for (const i of near) {
      const pv = view.views[i];
      if (pv && !pv.rendered) void renderPage(pv);
    }
  }, 120);
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
  for (const pv of view.views) void decorate(pv);
}

async function decorate(pv: PageView) {
  const gen = doc.generation;
  const scale = view.scale;
  const nodes = (await Promise.all([...decorators.values()].map((fn) => fn(pv)))).flat();
  if (gen === doc.generation && scale === view.scale) pv.decor.replaceChildren(...nodes);
}

export const getView = (i: number) => view.views[i];
