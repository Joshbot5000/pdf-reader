import * as L from 'lucide-static';

/** Icons used in the app (lucide, ISC licence). */
const ICONS = {
  home: L.House,
  edit: L.FilePenLine,
  organize: L.LayoutGrid,
  sign: L.Signature,
  prepare: L.TextCursorInput,
  redact: L.SquareDashed,
  ocr: L.ScanText,
  compare: L.GitCompare,
  brand: L.Stamp,
  ai: L.Sparkles,
  open: L.FolderOpen,
  save: L.Save,
  undo: L.Undo2,
  redo: L.Redo2,
  search: L.Search,
  left: L.ChevronLeft,
  right: L.ChevronRight,
  up: L.ChevronUp,
  down: L.ChevronDown,
  close: L.X,
  settings: L.Settings,
  zoomIn: L.ZoomIn,
  zoomOut: L.ZoomOut,
  fit: L.Maximize2,
  select: L.MousePointer2,
  text: L.Type,
  highlight: L.Highlighter,
  whiteout: L.PaintRoller,
  eraser: L.Eraser,
  draw: L.Pencil,
  rotateL: L.RotateCcw,
  rotateR: L.RotateCw,
  trash: L.Trash,
  filePlus: L.FilePlus,
  insert: L.CopyPlus,
  arrowUp: L.ArrowUp,
  arrowDown: L.ArrowDown,
  download: L.Download,
  image: L.Image,
  link: L.Link,
  plus: L.Plus,
  check: L.Check,
  command: L.Command,
  globe: L.Globe,
  file: L.FileText,
  slides: L.Presentation,
  chat: L.MessageSquare,
  send: L.Send,
  stop: L.Square,
  spaces: L.Library,
  wand: L.WandSparkles,
  calendar: L.Calendar,
  list: L.ListChecks,
  moon: L.Moon,
  sun: L.Sun,
  key: L.KeyRound,
  layers: L.Layers,
  extract: L.Scissors,
  shield: L.ShieldCheck,
  textField: L.TextCursorInput,
  checkbox: L.SquareCheckBig,
  dropdown: L.List,
  penTool: L.PenTool,
  diff: L.FileDiff,
  scan: L.FileScan,
  more: L.Ellipsis,
  bookmark: L.Bookmark,
  badge: L.BadgeCheck,
  scanSearch: L.ScanSearch,
} as const;

export type IconName = keyof typeof ICONS;

const parsed = new Map<IconName, SVGElement>();

export function icon(name: IconName, size = 18): SVGElement {
  let svg = parsed.get(name);
  if (!svg) {
    const t = document.createElement('template');
    t.innerHTML = ICONS[name].trim();
    svg = t.content.firstElementChild as SVGElement;
    svg.removeAttribute('class');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    parsed.set(name, svg);
  }
  const copy = svg.cloneNode(true) as SVGElement;
  copy.setAttribute('width', String(size));
  copy.setAttribute('height', String(size));
  return copy;
}

type Child = Node | string | number | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: { [E in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[E]) => void };
};

/** Tiny element builder: h('button', { class: 'btn', on: { click } }, icon('save'), 'Save'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, style, dataset, attrs, on, ...rest } = props;
  if (cls) el.className = cls;
  if (style) Object.assign(el.style, style);
  if (dataset) Object.assign(el.dataset, dataset);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (on) for (const [k, fn] of Object.entries(on)) el.addEventListener(k, fn as EventListener);
  Object.assign(el, rest);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export interface ButtonOpts {
  icon?: IconName;
  label?: string;
  title?: string;
  kind?: 'primary' | 'ghost' | 'danger' | 'soft' | 'tool';
  onClick?: (e: MouseEvent) => void;
  shortcut?: string;
  class?: string;
}

export function button(opts: ButtonOpts): HTMLButtonElement {
  const b = h(
    'button',
    {
      class: `btn btn-${opts.kind ?? 'ghost'}${opts.label ? '' : ' icon-only'}${opts.class ? ` ${opts.class}` : ''}`,
      title: [opts.title ?? opts.label, opts.shortcut && `(${opts.shortcut})`].filter(Boolean).join(' '),
      type: 'button',
    },
    opts.icon ? icon(opts.icon, opts.label ? 16 : 18) : null,
    opts.label ? h('span', {}, opts.label) : null,
  );
  if (!opts.label && opts.title) b.setAttribute('aria-label', opts.title);
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
