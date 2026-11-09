import { findAll, type Match } from '../../../shared/search';
import type { Rect as PdfRect } from '../../../shared/pdfOps';
import { doc, on, pageText, setCurrent, type PageText } from '../core/doc';
import { getView, redecorate, scrollIntoViewport, scrollToPage, setDecorator, type PageView } from '../core/viewer';
import { runSliceBox } from '../geometry';
import { button, h, icon } from '../ui/dom';

const measureCtx = document.createElement('canvas').getContext('2d')!;
export function measurerFor(fontFamily: string | undefined) {
  return (text: string) => {
    measureCtx.font = `100px ${fontFamily || 'sans-serif'}`;
    return measureCtx.measureText(text).width;
  };
}

const state = {
  matches: [] as Match[],
  index: -1,
  caseSensitive: false,
  wholeWord: false,
  seq: 0,
};

let input: HTMLInputElement;
let count: HTMLElement;

/** Boxes (viewport px) for each segment of a match on a rendered page. */
function matchBoxes(pv: PageView, page: PageText, m: Match) {
  const toViewport = (x: number, y: number) => pv.viewport.convertToViewportPoint(x, y) as [number, number];
  return m.segments.flatMap((seg) => {
    const run = page.items[seg.item];
    const r = run && runSliceBox(run, seg.start, seg.end, toViewport, measurerFor(page.fonts[run.fontName]));
    return r ? [r] : [];
  });
}

/** Rectangles in PDF user space covering a match (used by find-and-redact). */
export function matchPdfRects(page: PageText, m: Match): PdfRect[] {
  const identity = (x: number, y: number): [number, number] => [x, y];
  return m.segments.flatMap((seg) => {
    const run = page.items[seg.item];
    const r = run && runSliceBox(run, seg.start, seg.end, identity, measurerFor(page.fonts[run.fontName]));
    return r ? [{ x: r.left, y: r.top, width: r.width, height: r.height }] : [];
  });
}

export function buildSearch(): HTMLElement {
  input = h('input', {
    id: 'search',
    type: 'search',
    placeholder: 'Search document',
    autocomplete: 'off',
    attrs: { 'aria-label': 'Search document' },
  });
  count = h('span', { class: 'search-count', attrs: { 'aria-live': 'polite' } });
  const toggle = (label: string, title: string, key: 'caseSensitive' | 'wholeWord') => {
    const b = h('button', { class: 'chip-toggle', title, type: 'button', attrs: { 'aria-pressed': 'false' } }, label);
    b.addEventListener('click', () => {
      state[key] = !state[key];
      b.setAttribute('aria-pressed', String(state[key]));
      void run();
    });
    return b;
  };
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (!state.matches.length) void run();
      else step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      input.value = '';
      void run();
      input.blur();
    }
  });

  on('loaded', () => {
    if (input.value.trim()) void run(true);
  });
  on('closed', () => {
    input.value = '';
    void run();
  });

  setDecorator('search', async (pv) => {
    if (!state.matches.length || !doc.pdf) return [];
    const pages = await pageText();
    const page = pages[pv.index];
    if (!page) return [];
    return state.matches.flatMap((m, mi) =>
      m.page !== pv.index
        ? []
        : matchBoxes(pv, page, m).map((r) =>
            h('div', {
              class: mi === state.index ? 'hit current' : 'hit',
              style: { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` },
            }),
          ),
    );
  });

  return h(
    'div',
    { class: 'searchbar', role: 'search' },
    icon('search', 16),
    input,
    count,
    toggle('Aa', 'Match case', 'caseSensitive'),
    toggle('ab|', 'Whole words', 'wholeWord'),
    button({ icon: 'up', title: 'Previous match (Shift+Enter)', onClick: () => step(-1) }),
    button({ icon: 'down', title: 'Next match (Enter)', onClick: () => step(1) }),
  );
}

export function focusSearch() {
  input.focus();
  input.select();
}

/** Search for an exact phrase programmatically (used by AI citations). */
export function searchFor(text: string) {
  input.value = text;
  void run();
}

async function run(keepIndex = false) {
  const seq = ++state.seq;
  const query = input.value;
  if (!doc.pdf || !query.trim()) {
    state.matches = [];
    state.index = -1;
    count.textContent = '';
    redecorate();
    return;
  }
  count.textContent = '…';
  const text = await pageText();
  if (seq !== state.seq) return;
  state.matches = findAll(
    text.map((p) => p.items),
    query,
    { caseSensitive: state.caseSensitive, wholeWord: state.wholeWord },
  );
  if (!state.matches.length) state.index = -1;
  else if (keepIndex && state.index >= 0) state.index = Math.min(state.index, state.matches.length - 1);
  else {
    const i = state.matches.findIndex((m) => m.page >= doc.current);
    state.index = i === -1 ? 0 : i;
  }
  updateCount();
  redecorate();
  if (!keepIndex) reveal();
}

function updateCount() {
  const n = state.matches.length;
  count.textContent = input.value.trim() ? (n ? `${state.index + 1}/${n}` : 'No results') : '';
  count.classList.toggle('none', !!input.value.trim() && !n);
}

function step(delta: number) {
  const n = state.matches.length;
  if (!n) return;
  state.index = (state.index + delta + n) % n;
  updateCount();
  redecorate();
  reveal();
}

async function reveal() {
  const m = state.matches[state.index];
  if (!m) return;
  setCurrent(m.page);
  const pv = getView(m.page);
  if (!pv) return;
  const page = (await pageText())[m.page];
  const box = page && matchBoxes(pv, page, m)[0];
  if (box) scrollIntoViewport(pv, box.top);
  else scrollToPage(m.page);
}

export const searchState = state;
