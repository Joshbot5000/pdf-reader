/** Compare: side-by-side view of two PDFs with word-level differences highlighted. */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { compareTexts, type Change, type Comparison, type Word } from '../../../shared/compare';
import { api, doc, extractText, loadPdf, type PageText } from '../core/doc';
import { renderToCanvas } from '../core/viewer';
import { runSliceBox } from '../geometry';
import { button, h, icon } from '../ui/dom';
import { toast } from '../ui/overlays';
import { measurerFor } from './search';

interface Side {
  name: string;
  pdf: PDFDocumentProxy;
  text: PageText[];
}

let root: HTMLElement;
let panelEl: HTMLElement | null = null;
let a: Side | null = null;
let b: Side | null = null;
let result: Comparison | null = null;
let focused = -1;

export function initCompare(container: HTMLElement) {
  root = container;
}

export function activateCompare(on: boolean) {
  root.hidden = !on;
  document.getElementById('viewer')!.hidden = on;
  if (on) render();
}

async function pick(): Promise<Side | null> {
  const [file] = await api.pickFiles([{ name: 'PDF', extensions: ['pdf'] }], false);
  if (!file) return null;
  try {
    const pdf = await loadPdf(file.data).promise;
    return { name: file.name, pdf, text: await extractText(pdf) };
  } catch (err) {
    toast(`Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function useCurrent(): Promise<Side | null> {
  if (!doc.pdf || !doc.bytes || !doc.file) return null;
  const pdf = await loadPdf(doc.bytes).promise;
  return { name: doc.file.name, pdf, text: await extractText(pdf) };
}

async function run() {
  if (!a || !b) return;
  result = compareTexts(a.text.map((p) => p.items), b.text.map((p) => p.items));
  focused = -1;
  render();
  renderPanel();
}

function slot(label: string, side: Side | null, choose: () => Promise<void>) {
  return h(
    'button',
    { class: `compare-slot${side ? ' filled' : ''}`, type: 'button', on: { click: () => void choose() } },
    h('span', { class: 'slot-label' }, label),
    h('span', { class: 'slot-name' }, icon(side ? 'file' : 'plus', 16), side ? side.name : 'Choose PDF…'),
    side ? h('small', {}, `${side.pdf.numPages} pages`) : null,
  );
}

function render() {
  if (!root.hidden && (!a || !b || !result)) {
    root.replaceChildren(
      h(
        'div',
        { class: 'compare-start' },
        h('div', { class: 'hero-icon' }, icon('compare', 30)),
        h('h2', {}, 'Compare two PDFs'),
        h('p', { class: 'muted' }, 'See every word that was added, removed or changed between two versions of a document.'),
        h(
          'div',
          { class: 'compare-slots' },
          slot('Original', a, async () => {
            a = (await pick()) ?? a;
            render();
          }),
          h('span', { class: 'slot-arrow' }, icon('right', 20)),
          slot('Revised', b, async () => {
            b = (await pick()) ?? b;
            render();
          }),
        ),
        h(
          'div',
          { class: 'row' },
          doc.pdf && !a
            ? button({ label: `Use “${doc.file?.name}” as original`, kind: 'ghost', onClick: async () => ((a = await useCurrent()), render()) })
            : null,
          (() => {
            const go = button({ label: 'Compare', icon: 'diff', kind: 'primary', onClick: run });
            go.disabled = !a || !b;
            return go;
          })(),
        ),
      ),
    );
    return;
  }
  if (!a || !b || !result) return;

  const colA = h('div', { class: 'compare-col' });
  const colB = h('div', { class: 'compare-col' });
  const header = h(
    'div',
    { class: 'compare-head' },
    h('div', { class: 'compare-title removed' }, h('span', { class: 'dot' }), a.name),
    h('div', { class: 'compare-title added' }, h('span', { class: 'dot' }), b.name),
    button({ icon: 'close', title: 'New comparison', onClick: () => ((result = null), (a = b = null), render(), renderPanel()) }),
  );
  const cols = h('div', { class: 'compare-cols' }, colA, colB);
  root.replaceChildren(header, cols);

  const width = Math.max(260, Math.min(620, (root.clientWidth - 80) / 2));
  const removedByPage = groupByPage(result.changes.flatMap((c, ci) => c.removed.map((w) => ({ w, ci }))));
  const addedByPage = groupByPage(result.changes.flatMap((c, ci) => c.added.map((w) => ({ w, ci }))));
  void fillColumn(colA, a, width, removedByPage, 'removed');
  void fillColumn(colB, b, width, addedByPage, 'added');

  // Keep the two columns aligned page by page while scrolling either one.
  let syncing = false;
  const sync = (from: HTMLElement, to: HTMLElement) => () => {
    if (syncing) return;
    syncing = true;
    const pagesFrom = [...from.querySelectorAll<HTMLElement>('.cmp-page')];
    const idx = pagesFrom.findIndex((p) => p.offsetTop + p.offsetHeight > from.scrollTop);
    const target = to.querySelectorAll<HTMLElement>('.cmp-page')[idx];
    if (idx >= 0 && target) {
      const within = (from.scrollTop - pagesFrom[idx].offsetTop) / pagesFrom[idx].offsetHeight;
      to.scrollTop = target.offsetTop + within * target.offsetHeight;
    }
    requestAnimationFrame(() => (syncing = false));
  };
  colA.addEventListener('scroll', sync(colA, colB), { passive: true });
  colB.addEventListener('scroll', sync(colB, colA), { passive: true });
}

function groupByPage(list: { w: Word; ci: number }[]) {
  const m = new Map<number, { w: Word; ci: number }[]>();
  for (const x of list) m.set(x.w.page, [...(m.get(x.w.page) ?? []), x]);
  return m;
}

async function fillColumn(col: HTMLElement, side: Side, width: number, marks: Map<number, { w: Word; ci: number }[]>, kind: 'added' | 'removed') {
  for (let i = 0; i < side.pdf.numPages; i++) {
    const page = await side.pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / base.width });
    const wrap = h('div', { class: 'cmp-page', style: { width: `${vp.width}px`, height: `${vp.height}px` } }, h('div', { class: 'page-number' }, String(i + 1)));
    col.append(wrap);
    void renderToCanvas(page, i, width).then((c) => wrap.prepend(c));
    const text = side.text[i];
    for (const { w, ci } of marks.get(i) ?? []) {
      for (const seg of w.segments) {
        const run = text.items[seg.item];
        const r = run && runSliceBox(run, seg.start, seg.end, (x, y) => vp.convertToViewportPoint(x, y) as [number, number], measurerFor(text.fonts[run.fontName]));
        if (!r) continue;
        wrap.append(
          h('div', {
            class: `diff-mark ${kind}`,
            dataset: { change: String(ci) },
            style: { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` },
          }),
        );
      }
    }
  }
}

function focusChange(ci: number) {
  focused = ci;
  root.querySelectorAll('.diff-mark').forEach((m) => m.classList.toggle('focus', (m as HTMLElement).dataset.change === String(ci)));
  for (const col of root.querySelectorAll<HTMLElement>('.compare-col')) {
    const mark = col.querySelector<HTMLElement>(`.diff-mark[data-change="${ci}"]`);
    if (mark) {
      const page = mark.parentElement!;
      col.scrollTo({ top: page.offsetTop + mark.offsetTop - col.clientHeight / 3, behavior: 'smooth' });
    }
  }
  panelEl?.querySelectorAll('.change').forEach((el, i) => el.classList.toggle('active', i === ci));
}

export function comparePanel(): HTMLElement {
  panelEl = h('div', { class: 'panel-body' });
  renderPanel();
  return panelEl;
}

const words = (ws: Word[]) => {
  const t = ws.map((w) => w.text).join(' ');
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
};

function renderPanel() {
  if (!panelEl) return;
  if (!result || !a || !b) {
    panelEl.replaceChildren(h('section', { class: 'panel-section' }, h('div', { class: 'empty-hint' }, icon('diff', 28), h('p', {}, 'Choose two PDFs to see what changed between them.'))));
    return;
  }
  const counts = { added: 0, removed: 0, changed: 0 };
  result.changes.forEach((c) => counts[c.kind]++);
  const stats = h(
    'div',
    { class: 'stats' },
    h('div', { class: 'stat changed' }, h('strong', {}, String(counts.changed)), 'changed'),
    h('div', { class: 'stat added' }, h('strong', {}, String(counts.added)), 'added'),
    h('div', { class: 'stat removed' }, h('strong', {}, String(counts.removed)), 'removed'),
  );
  const list = h('div', { class: 'change-list' });
  if (result.identicalText) list.append(h('div', { class: 'empty-hint ok' }, icon('badge', 26), h('p', {}, 'The text of both documents is identical. Differences, if any, are in layout or images only.')));
  result.changes.forEach((c: Change, ci) => {
    const page = (c.removed[0] ?? c.added[0]).page + 1;
    const item = h(
      'button',
      { class: `change ${c.kind}${ci === focused ? ' active' : ''}`, type: 'button', on: { click: () => focusChange(ci) } },
      h('span', { class: 'change-meta' }, `${c.kind[0].toUpperCase()}${c.kind.slice(1)} · page ${page}`),
      c.removed.length ? h('del', {}, words(c.removed)) : null,
      c.added.length ? h('ins', {}, words(c.added)) : null,
    );
    list.append(item);
  });
  const pagesNote =
    result.pagesA !== result.pagesB ? h('p', { class: 'fine' }, `Page count changed: ${result.pagesA} → ${result.pagesB}.`) : null;
  panelEl.replaceChildren(h('section', { class: 'panel-section' }, stats, pagesNote), h('section', { class: 'panel-section grow' }, list));
}
