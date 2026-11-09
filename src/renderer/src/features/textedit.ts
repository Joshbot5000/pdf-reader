/**
 * Edit text: click a paragraph of the PDF's own text to change or delete it.
 * The original text is removed from the page content (see shared/textEdit.ts)
 * and the new text is drawn in the closest standard font, size and colour.
 */
import { blockAt, buildBlocks, type Block } from '../../../shared/textBlocks';
import { inspectTextStyle, replaceText, type TextFormat, type TextStyle } from '../../../shared/textEdit';
import { api, applyEdit, doc, on, pageText } from '../core/doc';
import { toPdf, toViewport, view, type Interaction, type PageView } from '../core/viewer';
import { button, h } from '../ui/dom';
import { toast } from '../ui/overlays';
import { createFormatBar, cssFamily, type FormatState } from '../ui/formatbar';

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

const hexColor = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
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
  // The paragraph's own lines, so neighbouring text (e.g. a heading) is never included.
  const region = { page: pv.index, box: block.box, lines: block.lines.map(({ y, x0, x1, size }) => ({ y, x0, x1, size })) };
  const detected = await inspectTextStyle(doc.bytes, region).catch(() => null);
  const style: TextStyle = detected ?? { fontSize: block.size, color: { r: 0, g: 0, b: 0 }, family: 'sans', bold: false, italic: false };
  const s = view.scale;
  const docFamily = `${block.fontName ? `"${block.fontName}", ` : ''}${CSS_FAMILY[style.family]}`;
  const initial: FormatState = { family: '', size: style.fontSize, bold: style.bold, italic: style.italic, underline: false, color: toHex(style.color) };
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
      // The document's own font (already loaded by pdf.js), then a close fallback.
      fontFamily: docFamily,
      fontWeight: style.bold ? '700' : '400',
      fontStyle: style.italic ? 'italic' : 'normal',
      color: toHex(style.color),
    },
  });
  const done = button({ label: 'Done', icon: 'check', kind: 'primary', onClick: () => finish(true) });
  const del = button({ icon: 'trash', title: 'Delete this text', kind: 'ghost', onClick: () => finish(true, '') });
  const cancel = button({ icon: 'close', title: 'Cancel (Esc)', kind: 'ghost', onClick: () => finish(false) });
  // Live preview of formatting changes in the editor.
  const preview = (f: FormatState) => {
    Object.assign(ta.style, {
      fontFamily: f.family ? cssFamily(f.family, CSS_FAMILY[style.family]) : docFamily,
      fontSize: `${f.size * s}px`,
      lineHeight: `${(linePx * f.size) / style.fontSize}px`,
      fontWeight: f.bold ? '700' : '400',
      fontStyle: f.italic ? 'italic' : 'normal',
      textDecoration: f.underline ? 'underline' : 'none',
      color: f.color,
    });
    autosize();
    // Return to the text after choosing an option, but not while typing a size.
    if (!(document.activeElement instanceof HTMLInputElement)) ta.focus();
  };
  const formatBar = createFormatBar(initial, prettyFont(style), preview);
  const bar = h(
    'div',
    { class: 'edit-bar', style: { left: `${r.left - 1}px`, top: `${Math.max(4, top - 50)}px` } },
    formatBar.el,
    h('span', { class: 'fmt-sep' }),
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
    // Only what the user explicitly changed is sent; everything else keeps the original.
    const f = formatBar.value();
    const format: TextFormat = {};
    if (f.family) format.family = f.family;
    if (Math.abs(f.size - style.fontSize) > 0.05) format.size = f.size;
    if (f.bold !== style.bold) format.bold = f.bold;
    if (f.italic !== style.italic) format.italic = f.italic;
    if (f.underline) format.underline = true;
    if (f.color.toLowerCase() !== toHex(style.color).toLowerCase()) format.color = hexColor(f.color);
    const formatChanged = Object.keys(format).length > 0;
    if (!commit || (text.trim() === original && !formatChanged)) return remove();
    // Keep the editor visible until the new page version is drawn, so nothing flickers.
    ta.readOnly = true;
    let method: 'edited' | 'covered' = 'edited';
    let usedFont: { kind: string; name: string } = { kind: 'original', name: '' };
    let overflow = false;
    void applyEdit(
      async (bytes) => {
        // A font from this computer: the one picked, or the document's own
        // typeface (for characters its embedded copy lacks, or a new weight).
        const want = format.family ?? style.fontName;
        const fontData = text.trim() && want ? await api.findFont(want, { bold: f.bold, italic: f.italic }).catch(() => null) : null;
        const res = await replaceText(bytes, { ...region, text, style, fontData, format });
        method = res.method;
        usedFont = res.font;
        overflow = res.overflow;
        return res.bytes;
      },
      { pages: [pv.index], label: text.trim() ? 'Text updated' : 'Text deleted' },
    ).then((ok) => {
      // Give the swapped-in page a frame to paint before removing the editor.
      requestAnimationFrame(() => requestAnimationFrame(remove));
      if (ok && overflow) {
        toast('The edited text needs more lines than the original, so it may run into the text below. A PDF can’t push the rest of the page down; make the text shorter or smaller if it overlaps.', 'info', 9000);
      } else if (ok && method === 'covered') {
        toast('That text is part of an image or graphic, so it was covered and replaced rather than edited.', 'info', 6000);
      } else if (ok && usedFont.kind === 'standard' && (format.family || style.fontName)) {
        const wanted = format.family ?? prettyFont(style);
        if (!/^(helvetica|times new roman|times|courier)$/i.test(wanted)) {
          toast(`“${wanted}” isn’t available on this computer, so ${usedFont.name.replace(/-/g, ' ')} was used for this edit.`, 'info', 7000);
        }
      }
    });
  }

  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (formatBar.shortcut(e)) return;
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
  // Clicking the bar's buttons shouldn't blur-commit the edit; the font list
  // and size box still take focus normally (blur ignores focus moving into the bar).
  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  bar.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && (to === ta || bar.contains(to))) return;
    // Focus left both the text box and the bar: treat as clicking away.
    setTimeout(() => {
      if (!bar.contains(document.activeElement) && document.activeElement !== ta) finish(true);
    });
  });

  pv.overlay.append(cover, ta, bar);
  editing = { pv, block, finish };
  autosize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/** "ABCDEF+TimesNewRomanPS-BoldMT" → "Times New Roman Bold". */
function prettyFont(style: TextStyle): string {
  const raw = style.fontName;
  if (!raw) return style.family === 'serif' ? 'Serif' : style.family === 'mono' ? 'Monospace' : 'Sans-serif';
  return raw
    .replace(/(PS)?MT$/, '')
    .replace(/PS-/, '-')
    .replace(/[-,_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Open the editor for the paragraph at a point, if there is one (used by double-click). */
export async function editTextAt(pv: PageView, x: number, y: number): Promise<boolean> {
  if (!doc.editable || doc.busy) return false;
  const p = toPdf(pv, x, y);
  const block = blockAt(await blocksFor(pv.index), p.x, p.y);
  if (!block) return false;
  await openEditor(pv, block);
  return true;
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
