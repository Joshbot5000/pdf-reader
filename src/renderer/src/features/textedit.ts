/**
 * Edit text: click a paragraph of the PDF's own text to change or delete it.
 * The original text is removed from the page content (see shared/textEdit.ts)
 * and the new text is drawn in the closest standard font, size and colour.
 */
import { blockAt, buildBlocks, type Block } from '../../../shared/textBlocks';
import { inspectTextStyle, replaceText, type TextStyle } from '../../../shared/textEdit';
import { applyEdit, doc, on, pageText } from '../core/doc';
import { toPdf, toViewport, view, type Interaction, type PageView } from '../core/viewer';
import { button, h } from '../ui/dom';
import { toast } from '../ui/overlays';

const blockCache = new Map<number, Block[]>();
let cacheGen = -1;

async function blocksFor(page: number): Promise<Block[]> {
  if (cacheGen !== doc.generation) {
    blockCache.clear();
    cacheGen = doc.generation;
  }
  let blocks = blockCache.get(page);
  if (!blocks) {
    const pages = await pageText();
    blocks = buildBlocks(pages[page]?.items ?? []);
    blockCache.set(page, blocks);
  }
  return blocks;
}

on('loaded', () => blockCache.clear());

/** Viewport rectangle (CSS px) of a box in PDF user space. */
function viewRect(pv: PageView, b: Block['box']) {
  const [x0, y0] = toViewport(pv, { x: b.x, y: b.y });
  const [x1, y1] = toViewport(pv, { x: b.x + b.width, y: b.y + b.height });
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

const CSS_FAMILY: Record<TextStyle['family'], string> = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: "'Times New Roman', Times, serif",
  mono: "'Courier New', Courier, monospace",
};

const toHex = (c: TextStyle['color']) =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

// ---------------------------------------------------------------- hover

let hoverEl: HTMLElement | null = null;
let hoverKey = '';

function showHover(pv: PageView, block: Block | undefined) {
  const key = block ? `${pv.index}:${block.box.x}:${block.box.y}` : '';
  if (key === hoverKey) return;
  hoverKey = key;
  hoverEl?.remove();
  hoverEl = null;
  if (!block || editing?.block === block) return;
  const r = viewRect(pv, block.box);
  const pad = 3;
  hoverEl = h('div', {
    class: 'text-hover',
    style: { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` },
  });
  pv.overlay.append(hoverEl);
}

// ---------------------------------------------------------------- editor

interface Editing {
  pv: PageView;
  block: Block;
  finish: (commit: boolean) => void;
}
let editing: Editing | null = null;

export function closeTextEditor(commit = true) {
  editing?.finish(commit);
}

async function openEditor(pv: PageView, block: Block) {
  closeTextEditor(true);
  if (!doc.bytes) return;
  const region = { page: pv.index, box: block.box };
  const detected = await inspectTextStyle(doc.bytes, region).catch(() => null);
  const style: TextStyle = detected ?? { fontSize: block.size, color: { r: 0, g: 0, b: 0 }, family: 'sans', bold: false, italic: false };
  const s = view.scale;
  const fontPx = style.fontSize * s;
  const linePx = (block.lineGap || style.fontSize * 1.2) * s;
  const r = viewRect(pv, block.box);
  const [, baseline] = toViewport(pv, { x: block.lines[0].x0, y: block.lines[0].y });
  const top = baseline - ((linePx - fontPx) / 2 + fontPx * 0.8);
  const pad = 3;

  showHover(pv, undefined);
  // White cover hides the original while editing; the textarea sits on top.
  const cover = h('div', {
    class: 'edit-cover',
    style: { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` },
  });
  const ta = h('textarea', {
    class: 'text-editor',
    value: block.text,
    spellcheck: true,
    attrs: { 'aria-label': 'Edit text' },
    style: {
      left: `${r.left - 1}px`,
      top: `${top - 1}px`,
      width: `${Math.max(r.width + fontPx, fontPx * 6)}px`,
      fontSize: `${fontPx}px`,
      lineHeight: `${linePx}px`,
      fontFamily: CSS_FAMILY[style.family],
      fontWeight: style.bold ? '700' : '400',
      fontStyle: style.italic ? 'italic' : 'normal',
      color: toHex(style.color),
    },
  });
  const done = button({ label: 'Done', icon: 'check', kind: 'primary', onClick: () => finish(true) });
  const del = button({ label: 'Delete text', icon: 'trash', kind: 'ghost', onClick: () => finish(true, '') });
  const cancel = button({ icon: 'close', title: 'Cancel (Esc)', kind: 'ghost', onClick: () => finish(false) });
  const bar = h(
    'div',
    { class: 'edit-bar', style: { left: `${r.left - 1}px`, top: `${Math.max(4, top - 46)}px` } },
    h('span', { class: 'edit-bar-label' }, `${style.family === 'serif' ? 'Serif' : style.family === 'mono' ? 'Mono' : 'Sans'} · ${Math.round(style.fontSize * 10) / 10} pt`),
    del,
    cancel,
    done,
  );
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };

  let closed = false;
  function finish(commit: boolean, override?: string) {
    if (closed) return;
    closed = true;
    editing = null;
    const text = (override ?? ta.value).replace(/\s+$/, '');
    const original = block.text.trim();
    const remove = () => {
      cover.remove();
      ta.remove();
      bar.remove();
    };
    if (!commit || text.trim() === original) return remove();
    // Keep the editor visible until the new page version is drawn, so nothing flickers.
    ta.readOnly = true;
    let method: 'edited' | 'covered' = 'edited';
    void applyEdit(
      async (bytes) => {
        const res = await replaceText(bytes, { ...region, text, style });
        method = res.method;
        return res.bytes;
      },
      { pages: [pv.index], label: text.trim() ? 'Text updated' : 'Text deleted' },
    ).then((ok) => {
      // Give the swapped-in page a frame to paint before removing the editor.
      requestAnimationFrame(() => requestAnimationFrame(remove));
      if (ok && method === 'covered') {
        toast('That text is part of an image or graphic, so it was covered and replaced rather than edited.', 'info', 6000);
      }
    });
  }

  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(true);
    }
  });
  ta.addEventListener('blur', (e) => {
    if (bar.contains(e.relatedTarget as Node)) return;
    finish(true);
  });
  // Clicks on the bar shouldn't blur-commit before the button handles them.
  bar.addEventListener('pointerdown', (e) => e.preventDefault());

  pv.overlay.append(cover, ta, bar);
  editing = { pv, block, finish };
  autosize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ---------------------------------------------------------------- tool

/** The Edit text tool; clicking empty space calls `onEmpty` (e.g. to add new text). */
export function createEditTextTool(onEmpty: (pv: PageView, x: number, y: number) => void): Interaction {
  return {
    cursor: 'text',
    move(pv, _e, x, y) {
      const blocks = blockCache.get(pv.index);
      const p = toPdf(pv, x, y);
      if (blocks && cacheGen === doc.generation) showHover(pv, blockAt(blocks, p.x, p.y));
      else void blocksFor(pv.index).then((b) => showHover(pv, blockAt(b, p.x, p.y)));
    },
    leave() {
      hoverEl?.remove();
      hoverEl = null;
      hoverKey = '';
    },
    async down(pv, e, x, y) {
      if ((e.target as HTMLElement).closest('.text-editor, .edit-bar')) return;
      e.preventDefault();
      if (!doc.editable || doc.busy) return;
      const p = toPdf(pv, x, y);
      const block = blockAt(await blocksFor(pv.index), p.x, p.y);
      if (block) void openEditor(pv, block);
      else {
        closeTextEditor(true);
        onEmpty(pv, x, y);
      }
    },
  };
}
