/** Edit mode: add text, highlight, white-out and freehand drawing. */
import { addInk, addRect, addText, type Color } from '../../../shared/pdfOps';
import { applyEdit, doc } from '../core/doc';
import { drag, setInteraction, toPdf, view, type Interaction, type PageView } from '../core/viewer';
import { button, h } from '../ui/dom';
import { closeTextEditor, createEditTextTool } from './textedit';

export type Tool = 'select' | 'edittext' | 'text' | 'highlight' | 'whiteout' | 'ink';

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
const changed = () => listeners.forEach((f) => f());

export function setTool(tool: Tool) {
  if (tool !== 'select' && !doc.editable) return;
  if (tool !== 'edittext') closeTextEditor(true);
  pen.tool = tool;
  setInteraction(interactions[tool]);
  changed();
}

// ---------------------------------------------------------------- interactions

function rectTool(kind: 'highlight' | 'whiteout'): Interaction {
  return {
    cursor: 'crosshair',
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
      await applyEdit((bytes) => addRect(bytes, { page: pv.index, a, b, kind, color }), { pages: [pv.index] });
      box.remove();
    },
  };
}

const inkTool: Interaction = {
  cursor: 'crosshair',
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
    await applyEdit((b) => addInk(b, { page: pv.index, points, width, color: hexToColor(pen.color) }), { pages: [pv.index] });
    svg.remove();
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
  whiteout: rectTool('whiteout'),
  ink: inkTool,
};

/** A floating textarea; Enter places the text, Shift+Enter adds a line, Esc cancels. */
export function startTextDraft(
  pv: PageView,
  x: number,
  y: number,
  opts: { initial?: string; size?: number; color?: string } = {},
) {
  document.querySelector('.text-draft')?.dispatchEvent(new Event('commit'));
  const size = opts.size ?? pen.size;
  const color = opts.color ?? pen.color;
  const fontPx = size * view.scale;
  const ta = h('textarea', {
    class: 'text-draft',
    rows: 1,
    spellcheck: false,
    value: opts.initial ?? '',
    attrs: { 'aria-label': 'New text' },
    style: { left: `${x - 1}px`, top: `${y - 1}px`, fontSize: `${fontPx}px`, color },
  });
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
    ta.style.width = 'auto';
    ta.style.width = `${Math.max(ta.scrollWidth + 4, fontPx * 4)}px`;
  };
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const lines = ta.value.split('\n');
    ta.remove();
    if (!commit || !ta.value.trim()) return;
    const lineHeight = fontPx * 1.2;
    const edits = lines.map((text, i) => ({ text, at: toPdf(pv, x, y + i * lineHeight + fontPx * 0.9) }));
    void applyEdit((b) => addText(b, { page: pv.index, lines: edits, size, color: hexToColor(color) }), { pages: [pv.index] });
  };
  ta.addEventListener('input', resize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
  });
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('commit', () => finish(true));
  pv.overlay.append(ta);
  resize();
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
    { tool: 'whiteout', label: 'White-out', icon: 'whiteout', key: 'W' },
    { tool: 'ink', label: 'Draw', icon: 'draw', key: 'D' },
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
    swatches.hidden = pen.tool === 'highlight' || pen.tool === 'whiteout' || pen.tool === 'edittext';
    size.hidden = pen.tool === 'edittext' || pen.tool === 'highlight' || pen.tool === 'whiteout';
    hint.hidden = pen.tool !== 'edittext';
  };
  const hint = h('span', { class: 'ribbon-note' }, 'Click any paragraph to change or delete it · click empty space to add text');
  listeners.clear();
  listeners.add(sync);
  sync();
  setInteraction(interactions[pen.tool]);
  return [group, h('div', { class: 'ribbon-sep' }), swatches, hl, size, hint];
}
