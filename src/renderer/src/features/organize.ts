/** Organize mode: a page grid with multi-select, rotate, delete, insert, reorder and extract. */
import { deletePage, extractPages, insertBlankPage, insertPdf, movePage, rotatePage, EditError } from '../../../shared/pdfOps';
import { api, applyEdit, doc, on, pageCount, setCurrent } from '../core/doc';
import { renderToCanvas, scrollToPage, wireReorder } from '../core/viewer';
import { button, h, icon } from '../ui/dom';
import { confirmModal, toast } from '../ui/overlays';

let grid: HTMLElement;
const selected = new Set<number>();
let anchor = 0;
let tileWidth = 170;
let active = false;

export function initOrganizer(container: HTMLElement) {
  grid = container;
  on('loaded', () => {
    for (const i of [...selected]) if (i >= pageCount()) selected.delete(i);
    if (active) void build();
  });
  on('closed', () => selected.clear());
}

export function activateOrganizer(on: boolean) {
  active = on;
  grid.hidden = !on;
  document.getElementById('viewer')!.hidden = on;
  if (on) void build();
}

const targets = () => (selected.size ? [...selected].sort((a, b) => a - b) : [doc.current]);

/** Render a page so it fits inside the tile frame whatever its orientation. */
async function fitTile(pdf: NonNullable<typeof doc.pdf>, i: number) {
  const page = await pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const width = vp.width > vp.height ? tileWidth : Math.min(tileWidth, (tileWidth * 1.414 * vp.width) / vp.height);
  return renderToCanvas(page, i, width);
}

async function build() {
  const pdf = doc.pdf;
  if (!pdf) return grid.replaceChildren();
  const gen = doc.generation;
  const tiles = Array.from({ length: pdf.numPages }, (_, i) => {
    // A fixed portrait frame keeps the grid aligned; landscape (rotated) pages are centred in it.
    const canvasWrap = h('div', { class: 'tile-canvas', style: { width: `${tileWidth}px`, height: `${Math.round(tileWidth * 1.414)}px` } });
    const tile = h(
      'div',
      {
        class: 'tile',
        draggable: true,
        tabIndex: 0,
        dataset: { index: String(i) },
        attrs: { role: 'option', 'aria-selected': String(selected.has(i)), 'aria-label': `Page ${i + 1}` },
      },
      canvasWrap,
      h(
        'div',
        { class: 'tile-actions' },
        button({ icon: 'rotateL', title: 'Rotate left', onClick: (e) => (e.stopPropagation(), void rotate(-90, [i])) }),
        button({ icon: 'rotateR', title: 'Rotate right', onClick: (e) => (e.stopPropagation(), void rotate(90, [i])) }),
        button({ icon: 'trash', title: 'Delete page', onClick: (e) => (e.stopPropagation(), void remove([i])) }),
      ),
      h('div', { class: 'tile-num' }, String(i + 1)),
      h('span', { class: 'tile-check' }, icon('check', 14)),
    );
    tile.classList.toggle('selected', selected.has(i));
    tile.classList.toggle('current', i === doc.current);
    tile.addEventListener('click', (e) => select(i, e));
    tile.addEventListener('dblclick', () => {
      setCurrent(i);
      document.dispatchEvent(new CustomEvent('app:mode', { detail: 'edit' }));
      requestAnimationFrame(() => scrollToPage(i, 'instant'));
    });
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') void remove(targets());
    });
    wireReorder(tile, i, true);
    void fitTile(pdf, i).then((c) => gen === doc.generation && canvasWrap.append(c));
    return tile;
  });
  grid.replaceChildren(h('div', { class: 'tile-grid', role: 'listbox', attrs: { 'aria-multiselectable': 'true' } }, ...tiles));
  updateSelectionUi();
}

function select(i: number, e: MouseEvent) {
  if (e.shiftKey) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    for (let k = a; k <= b; k++) selected.add(k);
  } else if (e.metaKey || e.ctrlKey) {
    if (selected.has(i)) selected.delete(i);
    else selected.add(i);
    anchor = i;
  } else {
    const only = selected.size === 1 && selected.has(i);
    selected.clear();
    if (!only) selected.add(i);
    anchor = i;
  }
  setCurrent(i);
  updateSelectionUi();
}

function updateSelectionUi() {
  grid.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
    const i = Number(t.dataset.index);
    t.classList.toggle('selected', selected.has(i));
    t.classList.toggle('current', i === doc.current);
    t.setAttribute('aria-selected', String(selected.has(i)));
  });
  updateSelectionNote();
}

let selectionNote: HTMLElement | null = null;
function updateSelectionNote() {
  if (selectionNote) selectionNote.textContent = selected.size ? `${selected.size} selected` : 'Click to select · Shift/Ctrl for more · drag to reorder';
}

async function rotate(delta: 90 | -90, pages = targets()) {
  await applyEdit(async (b) => {
    for (const i of pages) b = await rotatePage(b, i, delta);
    return b;
  }, { label: pages.length > 1 ? `Rotated ${pages.length} pages` : undefined });
}

async function remove(pages = targets()) {
  if (pages.length >= pageCount()) return toast('A PDF must keep at least one page.');
  const ok = await confirmModal(
    pages.length > 1 ? `Delete ${pages.length} pages?` : `Delete page ${pages[0] + 1}?`,
    'You can undo this with Ctrl+Z until you close the document.',
    'Delete',
    true,
  );
  if (!ok) return;
  const done = await applyEdit(async (b) => {
    for (const i of [...pages].sort((a, z) => z - a)) b = await deletePage(b, i);
    return b;
  }, { scrollTo: Math.max(0, Math.min(pages[0], pageCount() - pages.length - 1)) });
  if (done) selected.clear();
}

async function move(delta: -1 | 1) {
  const i = doc.current;
  const to = i + delta;
  if (to < 0 || to >= pageCount()) return;
  if (await applyEdit((b) => movePage(b, i, to), { scrollTo: to })) {
    if (selected.delete(i)) selected.add(to);
  }
}

export async function insertBlank() {
  await applyEdit((b) => insertBlankPage(b, doc.current), { scrollTo: doc.current + 1, label: 'Inserted a blank page' });
}

export async function insertFromPdf() {
  if (!doc.editable) return;
  const [other] = await api.pickFiles([{ name: 'PDF', extensions: ['pdf'] }], false);
  if (!other) return;
  const at = doc.current;
  await applyEdit((b) => insertPdf(b, other.data, at), { scrollTo: at + 1, label: `Inserted pages from ${other.name}` });
}

async function extract() {
  if (!doc.bytes || !doc.file) return;
  const pages = targets();
  try {
    const out = await extractPages(doc.bytes, pages);
    const base = doc.file.name.replace(/\.pdf$/i, '');
    const label = pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages`;
    const path = await api.exportFile(`${base} (${label}).pdf`, out, 'pdf', 'PDF');
    if (path) toast(`Extracted ${label} to a new PDF`, 'success');
  } catch (err) {
    toast(err instanceof EditError ? err.message : String(err));
  }
}

export function organizeRibbon(): HTMLElement[] {
  selectionNote = h('span', { class: 'ribbon-note' });
  updateSelectionNote();
  const count = selectionNote;
  const edit = (b: HTMLButtonElement) => ((b.dataset.needsEdit = ''), b);
  const zoom = h('input', {
    type: 'range',
    min: '110',
    max: '320',
    value: String(tileWidth),
    class: 'range',
    title: 'Thumbnail size',
    on: {
      input: (e) => {
        tileWidth = Number((e.target as HTMLInputElement).value);
        void build();
      },
    },
  });
  return [
    h(
      'div',
      { class: 'ribbon-group' },
      edit(button({ icon: 'rotateL', label: 'Rotate left', kind: 'tool', onClick: () => rotate(-90) })),
      edit(button({ icon: 'rotateR', label: 'Rotate right', kind: 'tool', onClick: () => rotate(90) })),
      edit(button({ icon: 'trash', label: 'Delete', kind: 'tool', onClick: () => remove() })),
    ),
    h('div', { class: 'ribbon-sep' }),
    h(
      'div',
      { class: 'ribbon-group' },
      edit(button({ icon: 'arrowUp', title: 'Move page earlier', kind: 'tool', onClick: () => move(-1) })),
      edit(button({ icon: 'arrowDown', title: 'Move page later', kind: 'tool', onClick: () => move(1) })),
      edit(button({ icon: 'filePlus', label: 'Blank page', kind: 'tool', onClick: insertBlank })),
      edit(button({ icon: 'insert', label: 'Insert PDF', kind: 'tool', onClick: insertFromPdf })),
      button({ icon: 'extract', label: 'Extract', kind: 'tool', title: 'Save selected pages as a new PDF', onClick: extract }),
    ),
    h('div', { class: 'ribbon-sep' }),
    h('label', { class: 'ribbon-group range-wrap' }, icon('zoomOut', 14), zoom, icon('zoomIn', 14)),
    count,
  ];
}
