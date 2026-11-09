/**
 * Edit mode: edit and add text, highlight, draw, erase and white-out.
 *
 * Pen strokes and highlights are saved as PDF annotations on top of the page
 * (see shared/annotations.ts), so the Eraser can remove them without ever
 * touching the document's own content.
 */
import { addRect, type Color, type Point } from '../../../shared/pdfOps';
import { replaceText } from '../../../shared/textEdit';
import { addHighlightAnnotation, addInkAnnotation, distanceTo, listOwnAnnotations, removeOwnAnnotations, type OwnAnnotation } from '../../../shared/annotations';
import { api, applyEdit, doc } from '../core/doc';
import { drag, setInteraction, toPdf, toViewport, view, type Interaction, type PageView } from '../core/viewer';
import { cursors } from '../ui/cursors';
import { button, h } from '../ui/dom';
import { createFormatBar, cssFamily, type FormatState } from '../ui/formatbar';
import { toast } from '../ui/overlays';
import { closeTextEditor, createEditTextTool } from './textedit';

export type Tool = 'select' | 'edittext' | 'text' | 'highlight' | 'ink' | 'eraser' | 'whiteout';

const SWATCHES = ['#d0021b', '#1f6feb', '#111111', '#2e7d32', '#7c5cff', '#ff7a00'];
const HIGHLIGHTS: Record<string, Color> = {
  yellow: { r: 1, g: 0.92, b: 0.23 },
  green: { r: 0.6, g: 0.94, b: 0.55 },
  pink: { r: 1, g: 0.6, b: 0.8 },
  blue: { r: 0.55, g: 0.8, b: 1 },
};

export const pen = {
  tool: 'select' as Tool,
  color: SWATCHES[0],
  size: 12,
  highlight: 'yellow',
};

export function hexToColor(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

const listeners = new Set<() => void>();
const changed = () => {
  // Colour changes update the pen/highlighter cursor too.
  if (pen.tool !== 'select') setInteraction(interactions[pen.tool]);
  listeners.forEach((f) => f());
};

const rgbHex = (c: Color) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

export function setTool(tool: Tool) {
  if (tool !== 'select' && !doc.editable) return;
  if (tool !== 'edittext') closeTextEditor(true);
  pen.tool = tool;
  setInteraction(interactions[tool]);
  listeners.forEach((f) => f());
}

// ---------------------------------------------------------------- interactions

function rectTool(kind: 'highlight' | 'whiteout'): Interaction {
  return {
    get cursor() {
      return kind === 'highlight' ? cursors.highlighter(rgbHex(HIGHLIGHTS[pen.highlight])) : cursors.whiteout();
    },
    async down(pv, e, x0, y0) {
      if (doc.busy) return;
      const box = h('div', { class: `draft-rect ${kind}` });
      pv.overlay.append(box);
      const place = (x1: number, y1: number) =>
        Object.assign(box.style, {
          left: `${Math.min(x0, x1)}px`,
          top: `${Math.min(y0, y1)}px`,
          width: `${Math.abs(x1 - x0)}px`,
          height: `${Math.abs(y1 - y0)}px`,
        });
      place(x0, y0);
      const [x1, y1] = await drag(pv, e, place);
      if (Math.abs(x1 - x0) < 3 || Math.abs(y1 - y0) < 3) return box.remove();
      const a = toPdf(pv, x0, y0);
      const b = toPdf(pv, x1, y1);
      const color = HIGHLIGHTS[pen.highlight];
      await applyEdit(
        (bytes) => (kind === 'highlight' ? addHighlightAnnotation(bytes, { page: pv.index, a, b, color }) : addRect(bytes, { page: pv.index, a, b, kind })),
        { pages: [pv.index] },
      );
      box.remove();
    },
  };
}

const inkTool: Interaction = {
  get cursor() {
    return cursors.pen(pen.color);
  },
  async down(pv, e, x0, y0) {
    if (doc.busy) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    const line = document.createElementNS(svgNS, 'polyline');
    const width = pen.size / 6;
    Object.entries({
      fill: 'none',
      stroke: pen.color,
      'stroke-width': String(width * view.scale),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }).forEach(([k, v]) => line.setAttribute(k, v));
    svg.append(line);
    pv.overlay.append(svg);
    const pts: [number, number][] = [[x0, y0]];
    const draw = () => line.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    draw();
    await drag(pv, e, (x, y) => {
      const last = pts[pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) >= 1.5) {
        pts.push([x, y]);
        draw();
      }
    });
    if (pts.length < 2) pts.push([x0 + 0.5, y0 + 0.5]); // a click makes a dot
    const points = pts.map(([x, y]) => toPdf(pv, x, y));
    await applyEdit((b) => addInkAnnotation(b, { page: pv.index, strokes: [points], width, color: hexToColor(pen.color) }), { pages: [pv.index] });
    svg.remove();
  },
};

// ---------------------------------------------------------------- eraser

let ownCache: { gen: number; list: Promise<OwnAnnotation[]> } | null = null;
const ownMarks = () => {
  if (!ownCache || ownCache.gen !== doc.generation) ownCache = { gen: doc.generation, list: doc.bytes ? listOwnAnnotations(doc.bytes) : Promise.resolve([]) };
  return ownCache.list;
};

/** Marks under a point on a page, within the eraser's radius. */
async function marksAt(pv: PageView, x: number, y: number): Promise<OwnAnnotation[]> {
  const p: Point = toPdf(pv, x, y);
  const radius = 7 / view.scale;
  return (await ownMarks()).filter((a) => a.page === pv.index && distanceTo(a, p) <= radius);
}

function markBox(pv: PageView, a: OwnAnnotation, cls: string) {
  const [x0, y0] = toViewport(pv, { x: a.rect[0], y: a.rect[1] });
  const [x1, y1] = toViewport(pv, { x: a.rect[2], y: a.rect[3] });
  return h('div', {
    class: cls,
    style: { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` },
  });
}

let eraseHover: HTMLElement | null = null;
let eraserHintShown = false;

const eraserTool: Interaction = {
  get cursor() {
    return cursors.eraser();
  },
  async move(pv, e, x, y) {
    if (e.buttons) return;
    const [hit] = await marksAt(pv, x, y);
    eraseHover?.remove();
    eraseHover = hit ? markBox(pv, hit, 'erase-hover') : null;
    if (eraseHover) pv.overlay.append(eraseHover);
  },
  leave() {
    eraseHover?.remove();
    eraseHover = null;
  },
  async down(pv, e, x0, y0) {
    if (doc.busy) return;
    eraseHover?.remove();
    const hits = new Map<string, OwnAnnotation>();
    const boxes: HTMLElement[] = [];
    const collect = async (x: number, y: number) => {
      for (const a of await marksAt(pv, x, y)) {
        if (hits.has(a.ref)) continue;
        hits.set(a.ref, a);
        const box = markBox(pv, a, 'erase-mark');
        boxes.push(box);
        pv.overlay.append(box);
      }
    };
    await collect(x0, y0);
    await drag(pv, e, (x, y) => void collect(x, y));
    if (!hits.size) {
      if (!eraserHintShown) {
        eraserHintShown = true;
        toast('The eraser removes pen and highlighter marks you’ve added. To hide part of the document itself, use White-out.', 'info', 6000);
      }
      return;
    }
    const refs = [...hits.keys()];
    await applyEdit((b) => removeOwnAnnotations(b, refs), { pages: [pv.index] });
    requestAnimationFrame(() => boxes.forEach((b) => b.remove()));
  },
};

const textTool: Interaction = {
  cursor: 'text',
  down(pv, e, x, y) {
    e.preventDefault();
    startTextDraft(pv, x, y);
  },
};

const interactions: Record<Tool, Interaction | null> = {
  select: null,
  edittext: createEditTextTool((pv, x, y) => startTextDraft(pv, x, y)),
  text: textTool,
  highlight: rectTool('highlight'),
  ink: inkTool,
  eraser: eraserTool,
  whiteout: rectTool('whiteout'),
};

/** Formatting for new text, remembered between uses (like Word's current style). */
let newTextFormat: FormatState | null = null;

/**
 * A floating text box for new text with a formatting bar (font, size, B/I/U,
 * colour). Enter places the text, Shift+Enter adds a line, Esc cancels.
 */
export function startTextDraft(
  pv: PageView,
  x: number,
  y: number,
  opts: { initial?: string; size?: number; color?: string } = {},
) {
  document.querySelector('.text-draft')?.dispatchEvent(new Event('commit'));
  const initial: FormatState = newTextFormat
    ? { ...newTextFormat, size: opts.size ?? newTextFormat.size, color: opts.color ?? newTextFormat.color }
    : { family: 'Helvetica', size: opts.size ?? pen.size, bold: false, italic: false, underline: false, color: opts.color ?? pen.color };
  let fmt = { ...initial };
  const ta = h('textarea', {
    class: 'text-draft',
    rows: 1,
    spellcheck: true,
    value: opts.initial ?? '',
    attrs: { 'aria-label': 'New text' },
    style: { left: `${x - 1}px`, top: `${y - 1}px` },
  });
  const apply = () => {
    const px = fmt.size * view.scale;
    Object.assign(ta.style, {
      fontFamily: cssFamily(fmt.family, 'Helvetica, Arial, sans-serif'),
      fontSize: `${px}px`,
      fontWeight: fmt.bold ? '700' : '400',
      fontStyle: fmt.italic ? 'italic' : 'normal',
      textDecoration: fmt.underline ? 'underline' : 'none',
      color: fmt.color,
    });
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
    ta.style.width = 'auto';
    ta.style.width = `${Math.max(ta.scrollWidth + 4, px * 4)}px`;
  };
  const formatBar = createFormatBar(initial, null, (f) => {
    fmt = f;
    newTextFormat = { ...f };
    apply();
    if (!(document.activeElement instanceof HTMLInputElement)) ta.focus();
  });
  const bar = h('div', { class: 'edit-bar draft-bar', style: { left: `${x - 1}px`, top: `${Math.max(4, y - 50)}px` } }, formatBar.el);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    bar.remove();
    if (!commit || !text.trim()) return;
    const f = fmt;
    const baseline = toPdf(pv, x, y + f.size * view.scale * 0.9);
    const standard = /^(helvetica|times new roman|courier)$/i.test(f.family);
    const style = { fontSize: f.size, color: hexToColor(f.color), family: 'sans' as const, bold: f.bold, italic: f.italic };
    void applyEdit(
      async (b) => {
        const fontData = standard ? null : await api.findFont(f.family, { bold: f.bold, italic: f.italic }).catch(() => null);
        const res = await replaceText(b, {
          page: pv.index,
          insert: true,
          box: { x: baseline.x, y: baseline.y - f.size, width: 100000, height: f.size },
          lines: [{ y: baseline.y, x0: baseline.x, x1: baseline.x, size: f.size }],
          text,
          style,
          fontData,
          format: { family: f.family, size: f.size, bold: f.bold, italic: f.italic, underline: f.underline, color: hexToColor(f.color) },
        });
        return res.bytes;
      },
      { pages: [pv.index] },
    );
  };
  ta.addEventListener('input', apply);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (formatBar.shortcut(e)) return;
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
  });
  ta.addEventListener('blur', (e) => {
    if (bar.contains(e.relatedTarget as Node)) return;
    finish(true);
  });
  bar.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  bar.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && (to === ta || bar.contains(to))) return;
    setTimeout(() => {
      if (!bar.contains(document.activeElement) && document.activeElement !== ta) finish(true);
    });
  });
  ta.addEventListener('commit', () => finish(true));
  pv.overlay.append(bar, ta);
  apply();
  // Focus now so the first keystrokes aren't lost (the pointerdown that
  // created the draft had its default prevented, so focus stays here).
  ta.focus();
}

// ---------------------------------------------------------------- ribbon

export function annotateRibbon(): HTMLElement[] {
  const tools: { tool: Tool; label: string; icon: Parameters<typeof button>[0]['icon']; key: string }[] = [
    { tool: 'select', label: 'Select', icon: 'select', key: 'V' },
    { tool: 'edittext', label: 'Edit text', icon: 'edit', key: 'E' },
    { tool: 'text', label: 'Add text', icon: 'text', key: 'T' },
    { tool: 'highlight', label: 'Highlight', icon: 'highlight', key: 'H' },
    { tool: 'ink', label: 'Draw', icon: 'draw', key: 'D' },
    { tool: 'eraser', label: 'Eraser', icon: 'eraser', key: 'R' },
    { tool: 'whiteout', label: 'White-out', icon: 'whiteout', key: 'W' },
  ];
  const group = h('div', { class: 'ribbon-group segmented', role: 'radiogroup', attrs: { 'aria-label': 'Tool' } });
  const btns = tools.map((t) => {
    const b = button({ icon: t.icon, label: t.label, kind: 'tool', shortcut: t.key, onClick: () => setTool(t.tool) });
    b.dataset.tool = t.tool;
    if (t.tool !== 'select') b.dataset.needsEdit = '';
    group.append(b);
    return b;
  });

  const swatches = h(
    'div',
    { class: 'ribbon-group swatches', attrs: { 'aria-label': 'Colour' } },
    ...SWATCHES.map((c) => {
      const s = h('button', {
        class: 'swatch',
        type: 'button',
        title: c,
        style: { background: c },
        attrs: { 'aria-label': `Colour ${c}` },
        on: { click: () => ((pen.color = c), changed()) },
      });
      s.dataset.color = c;
      return s;
    }),
    h('label', { class: 'swatch custom', title: 'Custom colour' }, h('input', {
      type: 'color',
      value: pen.color,
      on: { input: (e) => ((pen.color = (e.target as HTMLInputElement).value), changed()) },
    })),
  );
  const hl = h(
    'div',
    { class: 'ribbon-group swatches', attrs: { 'aria-label': 'Highlight colour' } },
    ...Object.entries(HIGHLIGHTS).map(([name, c]) => {
      const s = h('button', {
        class: 'swatch hl-swatch',
        type: 'button',
        title: `${name} highlighter`,
        style: { background: `rgb(${c.r * 255} ${c.g * 255} ${c.b * 255})` },
        on: { click: () => ((pen.highlight = name), changed()) },
      });
      s.dataset.hl = name;
      return s;
    }),
  );
  const size = h(
    'select',
    { class: 'select', title: 'Text size / pen width', on: { change: (e) => (pen.size = Number((e.target as HTMLSelectElement).value)) } },
    ...[8, 10, 12, 14, 18, 24, 36, 48].map((n) => h('option', { value: String(n), selected: n === pen.size }, `${n} pt`)),
  );

  const sync = () => {
    btns.forEach((b) => {
      const on = b.dataset.tool === pen.tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    swatches.querySelectorAll<HTMLElement>('[data-color]').forEach((s) => s.classList.toggle('active', s.dataset.color === pen.color));
    hl.querySelectorAll<HTMLElement>('[data-hl]').forEach((s) => s.classList.toggle('active', s.dataset.hl === pen.highlight));
    hl.hidden = pen.tool !== 'highlight';
    swatches.hidden = !['select', 'text', 'ink'].includes(pen.tool);
    size.hidden = !['select', 'text', 'ink'].includes(pen.tool);
    const tip = HINTS[pen.tool];
    hint.textContent = tip ?? '';
    hint.hidden = !tip;
  };
  const HINTS: Partial<Record<Tool, string>> = {
    select: 'Double-click any text to edit it',
    edittext: 'Click any paragraph to change or delete it · click empty space to add text',
    eraser: 'Drag over pen strokes and highlights to remove them · the document itself is never erased',
    whiteout: 'Covers part of the page with white (to hide content permanently, use Redact)',
  };
  const hint = h('span', { class: 'ribbon-note' });
  listeners.clear();
  listeners.add(sync);
  sync();
  setInteraction(interactions[pen.tool]);
  return [group, h('div', { class: 'ribbon-sep' }), swatches, hl, size, hint];
}
