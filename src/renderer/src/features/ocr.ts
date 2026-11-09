/** Scan & OCR: recognise text on scanned pages and add an invisible, searchable text layer. */
import { addInvisibleText, type OcrPlacement } from '../../../shared/pdfOps';
import { api, applyEdit, doc, on, pageText } from '../core/doc';
import { button, h, icon } from '../ui/dom';
import { progress, toast } from '../ui/overlays';

let banner: HTMLElement | null = null;
let panelEl: HTMLElement | null = null;
let textless: number[] = [];

/** Pages with (almost) no extractable text. */
async function findTextlessPages(): Promise<number[]> {
  const pages = await pageText();
  return pages.flatMap((p, i) => (p.items.reduce((n, it) => n + it.str.trim().length, 0) < 12 ? [i] : []));
}

export function initOcr(bannerHost: HTMLElement) {
  banner = bannerHost;
  on('opened', async () => {
    banner!.hidden = true;
    if (!doc.pdf) return;
    const gen = doc.generation;
    textless = await findTextlessPages();
    if (gen !== doc.generation || !textless.length) return;
    const all = textless.length === doc.pdf.numPages;
    banner!.replaceChildren(
      icon('scan', 18),
      h('span', {}, all ? 'This looks like a scanned document. Make it searchable and selectable?' : `${textless.length} page${textless.length > 1 ? 's look' : ' looks'} scanned (no text found).`),
      button({ label: 'Recognize text', kind: 'primary', onClick: () => void ocrPages(textless) }),
      button({ icon: 'close', title: 'Dismiss', onClick: () => (banner!.hidden = true) }),
    );
    banner!.hidden = false;
  });
  on('loaded', () => {
    if (panelEl?.isConnected) void renderPanel();
  });
}

export async function ocrPages(pages: number[], opts: { title?: string; force?: boolean } = {}) {
  if (!doc.pdf || !doc.editable) return;
  const textPages = new Set(opts.force ? [] : (await pageText()).flatMap((p, i) => (p.items.some((it) => it.str.trim()) ? [i] : [])));
  const todo = pages.filter((i) => !textPages.has(i));
  if (!todo.length) return toast('Those pages already contain text. Nothing to recognise.', 'info');
  const bar = progress(opts.title ?? 'Recognising text');
  const placements = new Map<number, OcrPlacement[]>();
  let words = 0;
  try {
    for (const [n, i] of todo.entries()) {
      if (bar.cancelled) return;
      bar.update(n / todo.length, `Reading page ${i + 1} (${n + 1} of ${todo.length})…`);
      const page = await doc.pdf.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(300 / 72, 3000 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = h('canvas', { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport: vp }).promise;
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/png'));
      const found = await api.ocr(new Uint8Array(await blob.arrayBuffer()));
      const list = found
        .filter((w) => w.confidence >= 35)
        .map((w): OcrPlacement => {
          const [x, y] = vp.convertToPdfPoint(w.bbox.x0, w.bbox.y1);
          return { text: w.text, at: { x, y }, width: (w.bbox.x1 - w.bbox.x0) / scale, height: (w.bbox.y1 - w.bbox.y0) / scale };
        });
      words += list.length;
      placements.set(i, list);
    }
    if (bar.cancelled) return;
    bar.update(1, 'Adding text layer…');
    const ok = await applyEdit(async (b) => {
      for (const [i, list] of placements) if (list.length) b = await addInvisibleText(b, i, list);
      return b;
    });
    if (ok) {
      toast(`Recognised ${words.toLocaleString()} words on ${todo.length} page${todo.length > 1 ? 's' : ''}. The document is now searchable.`, 'success', 5000);
      if (banner) banner.hidden = true;
    } else if (!words) toast('No text was recognised on those pages.', 'info');
  } catch (err) {
    toast(`Text recognition failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    bar.close();
  }
}

export function ocrRibbon(): HTMLElement[] {
  const edit = (b: HTMLButtonElement) => ((b.dataset.needsEdit = ''), b);
  return [
    h(
      'div',
      { class: 'ribbon-group' },
      edit(button({ icon: 'scan', label: 'Recognize all pages', kind: 'primary', onClick: () => ocrPages(Array.from({ length: doc.pdf?.numPages ?? 0 }, (_, i) => i)) })),
      edit(button({ icon: 'ocr', label: 'Current page', kind: 'tool', onClick: () => ocrPages([doc.current], { force: true }) })),
    ),
    h('div', { class: 'ribbon-sep' }),
    h('span', { class: 'ribbon-note' }, 'Runs on this computer · English · pages that already have text are skipped'),
  ];
}

export function ocrPanel(): HTMLElement {
  panelEl = h('div', { class: 'panel-body' });
  void renderPanel();
  return panelEl;
}

async function renderPanel() {
  if (!panelEl || !doc.pdf) return;
  textless = await findTextlessPages();
  const total = doc.pdf.numPages;
  const pct = Math.round(((total - textless.length) / total) * 100);
  panelEl.replaceChildren(
    h(
      'section',
      { class: 'panel-section' },
      h('div', { class: 'panel-label' }, 'Text coverage'),
      h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: `${pct}%` } })),
      h('p', { class: 'muted' }, textless.length ? `${total - textless.length} of ${total} pages have selectable text.` : `All ${total} pages have selectable text.`),
      textless.length
        ? h('div', { class: 'chips' }, ...textless.slice(0, 40).map((i) => h('span', { class: 'chip' }, `p.${i + 1}`)))
        : h('div', { class: 'empty-hint ok' }, icon('badge', 24), h('p', {}, 'Search, copy and the AI Assistant can read every page.')),
    ),
    h(
      'section',
      { class: 'panel-section' },
      h('div', { class: 'panel-label' }, 'How it works'),
      h('p', { class: 'fine' }, 'Each page is rendered at up to 300 dpi and read with Tesseract on this computer; nothing is uploaded. Recognised words are added as an invisible layer exactly over the scan, so the page looks the same but becomes searchable and selectable.'),
    ),
  );
}
