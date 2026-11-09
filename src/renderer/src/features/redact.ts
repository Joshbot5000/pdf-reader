/**
 * Redact: mark areas (by drawing, searching, or detecting personal data),
 * then apply. Applying flattens each marked page to an image with the marked
 * areas painted black and clears document metadata, so the hidden content is
 * removed from the file rather than merely covered.
 */
import { findAll, findRegexInPage, SENSITIVE_PATTERNS } from '../../../shared/search';
import { replacePageWithImage, scrubMetadata, type Rect } from '../../../shared/pdfOps';
import { applyEdit, doc, on, pageText } from '../core/doc';
import { drag, getView, scrollToPage, setDecorator, setInteraction, toPdf, toViewport, type Interaction, type PageView } from '../core/viewer';
import { button, h, icon, uid } from '../ui/dom';
import { openModal, progress, toast } from '../ui/overlays';
import { matchPdfRects } from './search';
import { ocrPages } from './ocr';

interface Mark {
  id: string;
  page: number;
  rect: Rect;
  label: string;
}

let marks: Mark[] = [];
let panelEl: HTMLElement | null = null;

on('opened', () => {
  marks = [];
  renderPanel();
});
on('closed', () => (marks = []));

function addMarks(next: Mark[]) {
  const pad = 1.2;
  marks = marks.concat(next.map((m) => ({ ...m, rect: { x: m.rect.x - pad, y: m.rect.y - pad, width: m.rect.width + 2 * pad, height: m.rect.height + 2 * pad } })));
  renderPanel();
  setDecorator('redact', decorator);
}

const decorator = (pv: PageView) =>
  marks
    .filter((m) => m.page === pv.index)
    .map((m) => {
      const [x0, y0] = toViewport(pv, { x: m.rect.x, y: m.rect.y });
      const [x1, y1] = toViewport(pv, { x: m.rect.x + m.rect.width, y: m.rect.y + m.rect.height });
      return h('div', {
        class: 'redact-mark',
        title: m.label,
        style: { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` },
      });
    });

const markTool: Interaction = {
  cursor: 'crosshair',
  async down(pv, e, x0, y0) {
    const box = h('div', { class: 'redact-mark draft' });
    pv.overlay.append(box);
    const place = (x1: number, y1: number) =>
      Object.assign(box.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    place(x0, y0);
    const [x1, y1] = await drag(pv, e, place);
    box.remove();
    if (Math.abs(x1 - x0) < 3 || Math.abs(y1 - y0) < 3) return;
    const a = toPdf(pv, x0, y0);
    const b = toPdf(pv, x1, y1);
    addMarks([{ id: uid(), page: pv.index, label: 'Area', rect: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) } }]);
  },
};

export function activateRedact() {
  setDecorator('redact', decorator);
  setInteraction(markTool);
}

export function leaveRedact() {
  setDecorator('redact', null);
  setInteraction(null);
}

async function findAndMark() {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'e.g. a name, case number or account' });
  let query = '';
  const m = openModal({
    title: 'Find text to redact',
    icon: 'scanSearch',
    body: h('label', { class: 'field' }, h('span', {}, 'Every occurrence will be marked'), input),
    actions: [{ label: 'Cancel' }, { label: 'Mark all', kind: 'primary', onClick: () => (query = input.value) }],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      query = input.value;
      m.close();
    }
  });
  await m.result;
  if (!query.trim() || !doc.pdf) return;
  const pages = await pageText();
  const found = findAll(pages.map((p) => p.items), query);
  addMarks(found.flatMap((f) => matchPdfRects(pages[f.page], f).map((rect) => ({ id: uid(), page: f.page, rect, label: `“${query.trim()}”` }))));
  toast(found.length ? `Marked ${found.length} occurrence${found.length > 1 ? 's' : ''} of “${query.trim()}”` : `No matches for “${query.trim()}”`, found.length ? 'success' : 'info');
}

async function markSensitive() {
  if (!doc.pdf) return;
  const checks = SENSITIVE_PATTERNS.map((p) => ({ p, box: h('input', { type: 'checkbox', checked: ['email', 'phone', 'card', 'nino'].includes(p.id) }) }));
  let go = false;
  await openModal({
    title: 'Find personal information',
    icon: 'shield',
    body: h(
      'div',
      { class: 'check-list' },
      h('p', { class: 'modal-text' }, 'Search the document for common kinds of personal data and mark every match for redaction. Review the marks before applying.'),
      ...checks.map(({ p, box }) => h('label', { class: 'check' }, box, h('span', {}, p.label))),
    ),
    actions: [{ label: 'Cancel' }, { label: 'Find & mark', kind: 'primary', onClick: () => (go = true) }],
  }).result;
  if (!go) return;
  const pages = await pageText();
  let count = 0;
  const next: Mark[] = [];
  for (const { p, box } of checks) {
    if (!box.checked) continue;
    pages.forEach((page, i) => {
      for (const m of findRegexInPage(i, page.items, p.pattern)) {
        count++;
        for (const rect of matchPdfRects(page, m)) next.push({ id: uid(), page: i, rect, label: p.one });
      }
    });
  }
  addMarks(next);
  toast(count ? `Marked ${count} item${count > 1 ? 's' : ''}. Review them before applying.` : 'No personal information found with those patterns.', count ? 'success' : 'info');
}

/** Render a page with marks burned in, as PNG bytes. */
async function flattenPage(index: number, rects: Rect[]): Promise<Uint8Array> {
  const page = await doc.pdf!.getPage(index + 1);
  const vp = page.getViewport({ scale: 200 / 72 }); // 200 dpi
  const canvas = h('canvas', { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp }).promise;
  ctx.fillStyle = '#000';
  for (const r of rects) {
    const [x0, y0] = vp.convertToViewportPoint(r.x, r.y);
    const [x1, y1] = vp.convertToViewportPoint(r.x + r.width, r.y + r.height);
    ctx.fillRect(Math.floor(Math.min(x0, x1)), Math.floor(Math.min(y0, y1)), Math.ceil(Math.abs(x1 - x0)) + 1, Math.ceil(Math.abs(y1 - y0)) + 1);
  }
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not render page'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function applyRedactions() {
  if (!marks.length) return toast('Mark something to redact first.', 'info');
  const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);
  const ocrBox = h('input', { type: 'checkbox', checked: true });
  let go = false;
  await openModal({
    title: `Apply ${marks.length} redaction${marks.length > 1 ? 's' : ''}?`,
    icon: 'shield',
    body: h(
      'div',
      {},
      h('p', { class: 'modal-text' }, `${pages.length} page${pages.length > 1 ? 's' : ''} will be flattened into images with the marked areas permanently blacked out, and the document’s metadata (title, author, XMP) will be cleared. The hidden content is removed from the file, not just covered.`),
      h('label', { class: 'check' }, ocrBox, h('span', {}, 'Make the redacted pages searchable again (OCR)')),
    ),
    actions: [{ label: 'Cancel' }, { label: 'Apply redactions', kind: 'danger', onClick: () => (go = true) }],
  }).result;
  if (!go) return;

  const bar = progress('Applying redactions');
  const ok = await applyEdit(async (bytes) => {
    let b = bytes;
    for (const [n, i] of pages.entries()) {
      if (bar.cancelled) throw new Error('Redaction cancelled; nothing was changed.');
      bar.update(n / pages.length, `Flattening page ${i + 1}…`);
      const png = await flattenPage(i, marks.filter((m) => m.page === i).map((m) => m.rect));
      b = await replacePageWithImage(b, i, png);
    }
    bar.update(1, 'Clearing metadata…');
    return scrubMetadata(b);
  }, { label: 'Redactions applied' });
  bar.close();
  if (!ok) return;
  marks = [];
  renderPanel();
  setDecorator('redact', decorator);
  if (ocrBox.checked) await ocrPages(pages, { title: 'Making redacted pages searchable', force: true });
}

export function redactRibbon(): HTMLElement[] {
  const edit = (b: HTMLButtonElement) => ((b.dataset.needsEdit = ''), b);
  return [
    h(
      'div',
      { class: 'ribbon-group' },
      button({ icon: 'redact', label: 'Mark area', kind: 'tool', class: 'active', title: 'Drag on the page to mark an area' }),
      button({ icon: 'scanSearch', label: 'Find text', kind: 'tool', onClick: findAndMark }),
      button({ icon: 'shield', label: 'Personal info', kind: 'tool', onClick: markSensitive }),
    ),
    h('div', { class: 'ribbon-sep' }),
    edit(button({ icon: 'check', label: 'Apply redactions', kind: 'danger', onClick: applyRedactions })),
  ];
}

export function redactPanel(): HTMLElement {
  panelEl = h('div', { class: 'panel-body' });
  renderPanel();
  return panelEl;
}

function renderPanel() {
  if (!panelEl) return;
  const list = h('div', { class: 'list' });
  if (!marks.length) {
    list.append(
      h('div', { class: 'empty-hint' }, icon('redact', 28), h('p', {}, 'Drag on the page to mark an area, or use ', h('strong', {}, 'Find text'), ' and ', h('strong', {}, 'Personal info'), ' to mark matches automatically.')),
    );
  }
  for (const m of marks) {
    const row = h(
      'div',
      { class: 'list-row clickable' },
      h('span', { class: 'list-icon redact-dot' }),
      h('span', { class: 'list-main' }, h('strong', {}, m.label), h('small', {}, `Page ${m.page + 1}`)),
      button({
        icon: 'close',
        title: 'Remove mark',
        onClick: (e) => {
          e.stopPropagation();
          marks = marks.filter((x) => x.id !== m.id);
          renderPanel();
          setDecorator('redact', decorator);
        },
      }),
    );
    row.addEventListener('click', () => {
      const pv = getView(m.page);
      if (pv) scrollToPage(m.page);
    });
    list.append(row);
  }
  panelEl.replaceChildren(
    h('section', { class: 'panel-section' }, h('div', { class: 'panel-label' }, `Marked for redaction (${marks.length})`), list,
      marks.length ? button({ label: 'Clear all marks', kind: 'ghost', class: 'block', onClick: () => ((marks = []), renderPanel(), setDecorator('redact', decorator)) }) : null),
  );
}
