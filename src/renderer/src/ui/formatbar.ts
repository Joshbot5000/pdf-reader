/**
 * Word-style formatting controls for text being edited or added: font, size,
 * bold, italic, underline and colour. Changes apply to the whole paragraph
 * and preview live in the editor.
 */
import { api } from '../core/doc';
import { h, icon } from './dom';

export interface FormatState {
  /** '' = keep the document's own font. */
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** #rrggbb */
  color: string;
}

/** Fonts that are always available, even when not installed. */
const STANDARD = ['Helvetica', 'Times New Roman', 'Courier'];
/** Well-known fonts shown first when installed. */
const POPULAR = [
  'Arial', 'Arial Narrow', 'Avenir', 'Avenir Next', 'Baskerville', 'Book Antiqua', 'Calibri', 'Cambria', 'Candara', 'Century Gothic',
  'Charter', 'Consolas', 'Constantia', 'Corbel', 'Didot', 'Futura', 'Garamond', 'EB Garamond', 'Georgia', 'Gill Sans', 'Helvetica Neue',
  'Hoefler Text', 'Lato', 'Lucida Grande', 'Menlo', 'Montserrat', 'Open Sans', 'Optima', 'Palatino', 'Palatino Linotype', 'Roboto',
  'Segoe UI', 'Source Sans Pro', 'Tahoma', 'Trebuchet MS', 'Verdana',
];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

let installed: Promise<string[]> | null = null;
const families = () => (installed ??= api.listFonts().catch(() => []));

export function cssFamily(family: string, fallback: string) {
  if (!family) return fallback;
  const generic = /courier|mono|consol|menlo/i.test(family) ? 'monospace' : /times|serif|georgia|garamond|cambria|palatino|baskerville|didot|book|charter|hoefler|constantia/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans-serif';
  return `"${family}", ${generic}`;
}

export function createFormatBar(initial: FormatState, documentFont: string | null, onChange: (f: FormatState) => void) {
  const state = { ...initial };
  const emit = () => onChange({ ...state });

  // Font
  const fontSel = h('select', { class: 'select fmt-font', title: 'Font' });
  if (documentFont !== null) fontSel.add(new Option(`${documentFont || 'Document font'} (as in document)`, ''));
  const addGroup = (label: string, names: string[]) => {
    if (!names.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const n of names) {
      const o = new Option(n, n);
      o.style.fontFamily = cssFamily(n, 'sans-serif');
      g.append(o);
    }
    fontSel.append(g);
  };
  addGroup('Always available', STANDARD);
  void families().then((list) => {
    const lower = new Set(list.map((f) => f.toLowerCase()));
    const popular = POPULAR.filter((f) => lower.has(f.toLowerCase()));
    const shown = new Set([...STANDARD, ...popular].map((f) => f.toLowerCase()));
    addGroup('Popular', popular);
    addGroup('All fonts', list.filter((f) => !shown.has(f.toLowerCase())));
    fontSel.value = state.family;
  });
  fontSel.value = state.family;
  fontSel.addEventListener('change', () => {
    state.family = fontSel.value;
    emit();
  });

  // Size
  const sizeIn = h('input', { class: 'input fmt-size', type: 'number', min: '4', max: '200', step: '0.5', value: String(state.size), title: 'Font size (pt)' });
  const list = h('datalist', { id: `fmt-sizes-${Math.random().toString(36).slice(2)}` }, ...SIZES.map((n) => h('option', { value: String(n) })));
  sizeIn.setAttribute('list', list.id);
  sizeIn.addEventListener('input', () => {
    const v = Number(sizeIn.value);
    if (v >= 4 && v <= 200) {
      state.size = v;
      emit();
    }
  });
  sizeIn.addEventListener('keydown', (e) => e.stopPropagation());

  // B / I / U
  const toggle = (key: 'bold' | 'italic' | 'underline', label: string, title: string) => {
    const b = h('button', { type: 'button', class: `fmt-toggle fmt-${key}`, title, attrs: { 'aria-pressed': String(state[key]) } }, label);
    b.addEventListener('click', () => {
      state[key] = !state[key];
      b.setAttribute('aria-pressed', String(state[key]));
      emit();
    });
    return b;
  };
  const bold = toggle('bold', 'B', 'Bold (Ctrl/⌘+B)');
  const italic = toggle('italic', 'I', 'Italic (Ctrl/⌘+I)');
  const underline = toggle('underline', 'U', 'Underline (Ctrl/⌘+U)');

  // Colour
  const colorIn = h('input', { type: 'color', value: state.color, title: 'Text colour' });
  colorIn.addEventListener('input', () => {
    state.color = colorIn.value;
    emit();
  });
  const color = h('label', { class: 'fmt-color', title: 'Text colour' }, icon('text', 14), h('span', { class: 'fmt-color-bar', style: { background: state.color } }), colorIn);
  colorIn.addEventListener('input', () => ((color.querySelector('.fmt-color-bar') as HTMLElement).style.background = colorIn.value));

  const el = h('div', { class: 'fmt-bar' }, fontSel, sizeIn, list, h('span', { class: 'fmt-sep' }), bold, italic, underline, color);

  /** Keyboard shortcuts from the text box. Returns true if handled. */
  const shortcut = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    const k = e.key.toLowerCase();
    const target = k === 'b' ? bold : k === 'i' ? italic : k === 'u' ? underline : null;
    if (!target) return false;
    e.preventDefault();
    target.click();
    return true;
  };

  return { el, value: () => ({ ...state }), shortcut };
}
