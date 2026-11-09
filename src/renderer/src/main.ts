import '@fontsource-variable/inter';
import '@fontsource/great-vibes/400.css';
import '@fontsource/dancing-script/400.css';
import '@fontsource/caveat/400.css';
import './styles.css';

import type { MenuAction } from '../../shared/ipc';
import { deletePage, rotatePage } from '../../shared/pdfOps';
import {
  activeTab, api, applyEdit, closeTab, doc, isDirty, on, openDialog, openPath, pageCount, redo, save, saveAll, setCurrent,
  setDiscardConfirm, switchTab, tabDirty, tabs, undo,
} from './core/doc';
import { initViewer, scrollToPage, setInteraction, setZoom, view, type PageDblClick } from './core/viewer';
import { annotateRibbon, pen, setTool, type Tool as PenTool } from './features/annotate';
import { editTextAt } from './features/textedit';
import { assistantOpen, initAssistant, refreshAssistant, toggleAssistant } from './features/assistant';
import { brandPanel, brandRibbon, activateBrand, leaveBrand, loadBrand } from './features/brand';
import { activateCompare, comparePanel, initCompare } from './features/compare';
import { renderHome, type Tool } from './features/home';
import { initOcr, ocrPanel, ocrRibbon, ocrPages } from './features/ocr';
import { activateOrganizer, initOrganizer, insertBlank, insertFromPdf, organizeRibbon } from './features/organize';
import { leavePrepare, loadTemplates, preparePanel, prepareRibbon } from './features/prepare';
import { activateRedact, leaveRedact, redactPanel, redactRibbon } from './features/redact';
import { buildSearch, focusSearch } from './features/search';
import { openSettings } from './features/settings';
import { loadSignatures, signPanel, signRibbon, stopPlacing, placeDate } from './features/sign';
import { $, button, h, icon, type IconName } from './ui/dom';
import { confirmModal, openModal, toast } from './ui/overlays';
import { openPalette, type Command } from './ui/palette';

// ======================================================================= modes

type ModeId = 'home' | 'edit' | 'organize' | 'sign' | 'prepare' | 'redact' | 'ocr' | 'compare' | 'brand';

interface Mode {
  id: ModeId;
  label: string;
  icon: IconName;
  blurb: string;
  hue: number;
  needsDoc: boolean;
  /** Side panel content; when absent the page thumbnails are shown. */
  panel?: () => HTMLElement;
  /** No side panel at all. */
  noSide?: boolean;
  ribbon?: () => HTMLElement[];
  enter?: () => void;
  leave?: () => void;
}

const MODES: Mode[] = [
  { id: 'home', label: 'Home', icon: 'home', blurb: '', hue: 0, needsDoc: false, noSide: true },
  {
    id: 'edit', label: 'Edit', icon: 'edit', hue: 258, needsDoc: true,
    blurb: 'Edit and add text, highlight, draw and white-out',
    ribbon: annotateRibbon,
    leave: () => setTool('select'),
  },
  {
    id: 'organize', label: 'Organize', icon: 'organize', hue: 200, needsDoc: true, noSide: true,
    blurb: 'Reorder, rotate, insert, extract and delete pages',
    ribbon: organizeRibbon,
    enter: () => activateOrganizer(true),
    leave: () => activateOrganizer(false),
  },
  {
    id: 'sign', label: 'Fill & Sign', icon: 'sign', hue: 330, needsDoc: true,
    blurb: 'Fill forms, sign, initial and date',
    panel: signPanel, ribbon: signRibbon,
    leave: stopPlacing,
  },
  {
    id: 'prepare', label: 'Prepare form', icon: 'prepare', hue: 160, needsDoc: true,
    blurb: 'Create fillable fields and reusable templates',
    panel: preparePanel, ribbon: prepareRibbon,
    leave: leavePrepare,
  },
  {
    id: 'redact', label: 'Redact', icon: 'redact', hue: 0, needsDoc: true,
    blurb: 'Permanently remove sensitive information',
    panel: redactPanel, ribbon: redactRibbon,
    enter: activateRedact, leave: leaveRedact,
  },
  {
    id: 'ocr', label: 'Scan & OCR', icon: 'ocr', hue: 28, needsDoc: true,
    blurb: 'Make scanned documents searchable',
    panel: ocrPanel, ribbon: ocrRibbon,
  },
  {
    id: 'compare', label: 'Compare', icon: 'compare', hue: 190, needsDoc: false,
    blurb: 'See what changed between two versions',
    panel: comparePanel,
    enter: () => activateCompare(true),
    leave: () => activateCompare(false),
  },
  {
    id: 'brand', label: 'Brand', icon: 'brand', hue: 45, needsDoc: true,
    blurb: 'Add your logo and a custom link to agreements',
    panel: brandPanel, ribbon: brandRibbon,
    enter: activateBrand, leave: leaveBrand,
  },
];

let mode: Mode = MODES[0];

const sideEl = $('#side');
const thumbsEl = $('#thumbs');
const sideBody = $('#side-body');
const ribbonEl = $('#ribbon');
const homeEl = $('#home');
const pagerEl = $('#pager');
const railEl = $('#rail');

async function setMode(id: ModeId) {
  const next = MODES.find((m) => m.id === id) ?? MODES[0];
  if (next.needsDoc && !doc.pdf) {
    if (!(await openDialog())) return;
  }
  mode.leave?.();
  setInteraction(null);
  mode = next;
  document.body.dataset.mode = mode.id;

  homeEl.hidden = mode.id !== 'home';
  sideEl.hidden = !!mode.noSide;
  $('#side-title').textContent = mode.panel ? mode.label : 'Pages';
  $('#side-desc').textContent = mode.panel ? mode.blurb : '';
  thumbsEl.hidden = !!mode.panel;
  sideBody.hidden = !mode.panel;
  sideBody.replaceChildren(mode.panel ? mode.panel() : '');
  ribbonEl.replaceChildren(...(mode.ribbon ? mode.ribbon() : []));
  ribbonEl.hidden = !mode.ribbon;
  if (mode.id === 'home') void showHome();
  mode.enter?.();
  railEl.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode.id);
    b.setAttribute('aria-current', String(b.dataset.mode === mode.id));
  });
  refreshChrome();
}
document.addEventListener('app:mode', (e) => void setMode((e as CustomEvent<ModeId>).detail));

async function showHome() {
  const recent = (await api.getState()).recent;
  const tools: Tool[] = MODES.filter((m) => m.id !== 'home').map((m) => ({ mode: m.id, label: m.label, icon: m.icon, blurb: m.blurb, needsDoc: m.needsDoc, hue: m.hue }));
  tools.push({ mode: 'ai', label: 'AI Assistant', icon: 'ai', blurb: 'Chat, summarize and remix into slides', needsDoc: false, hue: 280 });
  tools.push({ mode: 'spaces', label: 'PDF Spaces', icon: 'spaces', blurb: 'Ask questions across many files and links', needsDoc: false, hue: 300 });
  renderHome(homeEl, tools, (m) => {
    if (m === 'ai') {
      if (doc.pdf && mode.id === 'home') void setMode('edit');
      toggleAssistant(true, 'doc');
    } else if (m === 'spaces') toggleAssistant(true, 'spaces');
    else void setMode(m as ModeId);
  }, recent);
}

// ======================================================================= rail & title bar

function buildRail() {
  const top = MODES.map((m) => {
    const b = h(
      'button',
      { class: 'rail-btn', type: 'button', title: m.label, dataset: { mode: m.id }, on: { click: () => void setMode(m.id) } },
      icon(m.icon, 20),
      h('span', {}, m.id === 'sign' ? 'Sign' : m.id === 'prepare' ? 'Forms' : m.id === 'ocr' ? 'OCR' : m.label),
    );
    b.style.setProperty('--hue', String(m.hue));
    return b;
  });
  const aiBtn = h(
    'button',
    { class: 'rail-btn ai', type: 'button', title: 'AI Assistant', on: { click: () => toggleAssistant() } },
    icon('ai', 20),
    h('span', {}, 'AI'),
  );
  document.addEventListener('assistant:toggle', () => aiBtn.classList.toggle('active', assistantOpen()));
  railEl.replaceChildren(
    h('div', { class: 'rail-top' }, ...top),
    h('div', { class: 'rail-bottom' }, aiBtn, h('button', { class: 'rail-btn', type: 'button', title: 'Settings', on: { click: () => void openSettings() } }, icon('settings', 20), h('span', {}, 'Settings'))),
  );
}

const saveBtn = button({ icon: 'save', label: 'Save', kind: 'soft', title: 'Save changes to this file', shortcut: 'Ctrl+S', class: 'save-btn', onClick: () => save() });
const undoBtn = button({ icon: 'undo', title: 'Undo', shortcut: 'Ctrl+Z', onClick: () => undo() });
const redoBtn = button({ icon: 'redo', title: 'Redo', shortcut: 'Ctrl+Shift+Z', onClick: () => redo() });
saveBtn.id = 'btn-save';
undoBtn.id = 'btn-undo';
redoBtn.id = 'btn-redo';

function buildTitlebar() {
  document.body.classList.add(`platform-${api.platform}`);
  $('#search-slot').append(buildSearch());
  $('#title-actions').append(
    undoBtn,
    redoBtn,
    saveBtn,
    button({ icon: 'download', title: 'Save a copy as… (Ctrl+Shift+S)', onClick: () => save(true) }),
    h('span', { class: 'title-sep' }),
    button({ icon: 'command', title: 'Command palette', shortcut: 'Ctrl+K', onClick: palette }),
    h('button', { class: 'btn ai-cta', type: 'button', title: 'AI Assistant', on: { click: () => toggleAssistant() } }, icon('ai', 16), h('span', {}, 'Ask AI')),
  );
}

function buildPager() {
  const input = h('input', { class: 'pager-input', type: 'text', inputMode: 'numeric', attrs: { 'aria-label': 'Page number' } });
  const total = h('span', { class: 'pager-total' });
  const zoom = h('button', { class: 'pager-zoom', type: 'button', title: 'Fit width', on: { click: () => setZoom('fit') } });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const n = Number(input.value) - 1;
      if (n >= 0 && n < pageCount()) {
        setCurrent(n);
        scrollToPage(n);
      }
      input.blur();
    }
  });
  const go = (d: number) => {
    const n = Math.max(0, Math.min(pageCount() - 1, doc.current + d));
    setCurrent(n);
    scrollToPage(n);
  };
  pagerEl.append(
    button({ icon: 'up', title: 'Previous page', onClick: () => go(-1) }),
    input,
    total,
    button({ icon: 'down', title: 'Next page', onClick: () => go(1) }),
    h('span', { class: 'pager-sep' }),
    button({ icon: 'zoomOut', title: 'Zoom out', onClick: () => setZoom(view.scale / 1.2) }),
    zoom,
    button({ icon: 'zoomIn', title: 'Zoom in', onClick: () => setZoom(view.scale * 1.2) }),
  );
  return () => {
    if (document.activeElement !== input) input.value = String(doc.current + 1);
    total.textContent = `/ ${pageCount()}`;
    zoom.textContent = view.fitWidth ? 'Fit' : `${Math.round(view.scale * 100)}%`;
  };
}

let updatePager: () => void = () => {};

function refreshChrome() {
  const hasDoc = !!doc.pdf;
  window.__hasDoc = hasDoc;
  const canEdit = hasDoc && doc.editable && !doc.busy;
  document.querySelectorAll<HTMLButtonElement>('[data-needs-edit]').forEach((b) => (b.disabled = !canEdit));
  const dirty = isDirty();
  saveBtn.disabled = !hasDoc || doc.busy || !dirty;
  saveBtn.classList.toggle('dirty', dirty);
  saveBtn.replaceChildren(icon(dirty || !hasDoc ? 'save' : 'check', 16), h('span', {}, dirty || !hasDoc ? 'Save' : 'Saved'));
  undoBtn.disabled = !canEdit || !doc.undo.length;
  redoBtn.disabled = !canEdit || !doc.redo.length;
  document.body.classList.toggle('has-doc', hasDoc);
  document.body.classList.toggle('busy', doc.busy);
  renderTabs();
  document.title = doc.file ? `${doc.file.name}${isDirty() ? ' •' : ''} — PDF Reader` : 'PDF Reader';
  pagerEl.hidden = !hasDoc || !['edit', 'sign', 'prepare', 'redact', 'ocr', 'brand'].includes(mode.id);
  updatePager();
  const dirtyTabs = tabs.filter(tabDirty);
  api.setDocState({
    dirty: dirtyTabs.length > 0,
    path: doc.file?.path ?? null,
    name: dirtyTabs.length > 1 ? `${dirtyTabs.length} documents` : (dirtyTabs[0]?.file.name ?? doc.file?.name ?? null),
  });
}

// ======================================================================= commands

function commands(): Command[] {
  const hasDoc = () => !!doc.pdf;
  const canEdit = () => !!doc.pdf && doc.editable;
  const mod = api.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const toolCmd = (tool: PenTool, label: string, ic: IconName, key: string): Command => ({
    id: `tool-${tool}`, label, group: 'Edit', icon: ic, shortcut: key, enabled: canEdit,
    run: async () => {
      await setMode('edit');
      setTool(tool);
    },
  });
  return [
    { id: 'open', label: 'Open PDF…', group: 'File', icon: 'open', shortcut: `${mod}O`, run: openAndEdit },
    { id: 'save', label: 'Save', group: 'File', icon: 'save', shortcut: `${mod}S`, enabled: () => isDirty(), run: () => save() },
    { id: 'saveas', label: 'Save as…', group: 'File', icon: 'download', enabled: hasDoc, run: () => save(true) },
    { id: 'close', label: 'Close document', group: 'File', icon: 'close', shortcut: `${mod}W`, enabled: hasDoc, run: closeDoc },
    ...tabs.filter((t) => t !== activeTab()).map((t): Command => ({
      id: `tab-${t.id}`, label: `Switch to ${t.file.name}`, group: 'Open documents', icon: 'file',
      run: async () => {
        await switchTab(t);
        if (mode.id === 'home') await setMode('edit');
      },
    })),
    { id: 'home', label: 'Go to Home', group: 'File', icon: 'home', run: () => setMode('home') },
    ...MODES.filter((m) => m.id !== 'home').map((m): Command => ({ id: `mode-${m.id}`, label: m.label, group: 'Tools', icon: m.icon, keywords: m.blurb, run: () => setMode(m.id) })),
    toolCmd('edittext', 'Edit existing text', 'edit', 'E'),
    toolCmd('text', 'Add text', 'text', 'T'),
    toolCmd('highlight', 'Highlight', 'highlight', 'H'),
    toolCmd('whiteout', 'White-out', 'whiteout', 'W'),
    toolCmd('ink', 'Draw', 'draw', 'D'),
    toolCmd('eraser', 'Eraser (removes your pen and highlights)', 'eraser', 'R'),
    { id: 'undo', label: 'Undo', group: 'Edit', icon: 'undo', shortcut: `${mod}Z`, enabled: () => !!doc.undo.length, run: undo },
    { id: 'redo', label: 'Redo', group: 'Edit', icon: 'redo', shortcut: `${mod}⇧Z`, enabled: () => !!doc.redo.length, run: redo },
    { id: 'find', label: 'Find in document', group: 'Edit', icon: 'search', shortcut: `${mod}F`, enabled: hasDoc, run: focusSearch },
    { id: 'rotR', label: 'Rotate current page right', group: 'Pages', icon: 'rotateR', enabled: canEdit, run: () => applyEdit((b) => rotatePage(b, doc.current, 90), { scrollTo: doc.current }) },
    { id: 'rotL', label: 'Rotate current page left', group: 'Pages', icon: 'rotateL', enabled: canEdit, run: () => applyEdit((b) => rotatePage(b, doc.current, -90), { scrollTo: doc.current }) },
    { id: 'blank', label: 'Insert blank page', group: 'Pages', icon: 'filePlus', enabled: canEdit, run: insertBlank },
    { id: 'insert', label: 'Insert pages from PDF…', group: 'Pages', icon: 'insert', enabled: canEdit, run: insertFromPdf },
    {
      id: 'delete', label: 'Delete current page', group: 'Pages', icon: 'trash', enabled: () => canEdit() && pageCount() > 1,
      run: async () => {
        const i = doc.current;
        if (await confirmModal(`Delete page ${i + 1}?`, 'You can undo this with Ctrl+Z.', 'Delete', true)) {
          await applyEdit((b) => deletePage(b, i), { scrollTo: Math.max(0, i - 1) });
        }
      },
    },
    { id: 'date', label: 'Stamp today’s date', group: 'Fill & Sign', icon: 'calendar', enabled: canEdit, run: async () => (await setMode('sign'), placeDate()) },
    { id: 'ocr-all', label: 'Recognize text on all pages', group: 'Scan & OCR', icon: 'scan', enabled: canEdit, run: () => ocrPages(Array.from({ length: pageCount() }, (_, i) => i)) },
    { id: 'ai', label: 'Open AI Assistant', group: 'AI', icon: 'ai', run: () => toggleAssistant(true, 'doc') },
    { id: 'spaces', label: 'PDF Spaces', group: 'AI', icon: 'spaces', keywords: 'chat across files links', run: () => toggleAssistant(true, 'spaces') },
    { id: 'zoom-in', label: 'Zoom in', group: 'View', icon: 'zoomIn', shortcut: `${mod}=`, enabled: hasDoc, run: () => setZoom(view.scale * 1.2) },
    { id: 'zoom-out', label: 'Zoom out', group: 'View', icon: 'zoomOut', shortcut: `${mod}-`, enabled: hasDoc, run: () => setZoom(view.scale / 1.2) },
    { id: 'fit', label: 'Fit to width', group: 'View', icon: 'fit', shortcut: `${mod}0`, enabled: hasDoc, run: () => setZoom('fit') },
    { id: 'settings', label: 'Settings', group: 'App', icon: 'settings', shortcut: `${mod},`, keywords: 'api key theme dark light', run: openSettings },
  ];
}

const palette = () => openPalette(commands());

async function openAndEdit() {
  if ((await openDialog()) && mode.id === 'home') await setMode('edit');
}

/** Adobe-style prompt before leaving a document with unsaved changes. Resolves true to continue. */
async function askToSave(): Promise<boolean> {
  if (!isDirty()) return true;
  let choice = 'cancel' as 'save' | 'discard' | 'cancel';
  await openModal({
    title: `Save changes to “${doc.file?.name ?? 'this document'}”?`,
    icon: 'save',
    body: h('p', { class: 'modal-text' }, 'Your changes will be lost if you don’t save them.'),
    actions: [
      { label: 'Don’t Save', kind: 'ghost', onClick: () => (choice = 'discard') },
      { label: 'Cancel', onClick: () => (choice = 'cancel') },
      { label: 'Save', kind: 'primary', onClick: () => (choice = 'save') },
    ],
  }).result;
  if (choice === 'save') return save();
  return choice === 'discard';
}

async function closeDoc() {
  const tab = activeTab();
  if (!tab || !(await closeTab(tab))) return;
  if (!tabs.length) await setMode('home');
}

// ======================================================================= tabs

const tabsEl = $('#doc-tabs');

function renderTabs() {
  const current = activeTab();
  tabsEl.hidden = !tabs.length;
  tabsEl.replaceChildren(
    ...tabs.map((t) => {
      const isActive = t === current;
      const name = isActive && doc.file ? doc.file.name : t.file.name;
      const el = h(
        'div',
        {
          class: `doc-tab${isActive ? ' active' : ''}`,
          role: 'tab',
          tabIndex: 0,
          title: (isActive ? doc.file?.path : t.file.path) ?? name,
          attrs: { 'aria-selected': String(isActive) },
        },
        icon('file', 13),
        h('span', { class: 'doc-name' }, name),
        tabDirty(t) ? h('span', { class: 'dirty-dot', title: 'Unsaved changes' }) : '',
        isActive && !doc.editable && doc.pdf ? h('span', { class: 'pill' }, 'Read-only') : '',
        h('button', {
          class: 'tab-close',
          type: 'button',
          title: 'Close (Ctrl+W)',
          attrs: { 'aria-label': `Close ${name}` },
          on: {
            click: async (e) => {
              e.stopPropagation();
              if ((await closeTab(t)) && !tabs.length) await setMode('home');
            },
          },
        }, icon('close', 12)),
      );
      const open = async () => {
        await switchTab(t);
        if (mode.id === 'home') await setMode('edit');
      };
      el.addEventListener('click', () => void open());
      el.addEventListener('keydown', (e) => e.key === 'Enter' && void open());
      el.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        void closeTab(t).then(async (ok) => {
          if (ok && !tabs.length) await setMode('home');
        });
      });
      return el;
    }),
    h('button', { class: 'tab-add', type: 'button', title: 'Open another PDF (Ctrl+O)', attrs: { 'aria-label': 'Open another PDF' }, on: { click: () => void openAndEdit() } }, icon('plus', 15)),
  );
  tabsEl.querySelector('.doc-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

on('tabs', renderTabs);

function cycleTab(delta: number) {
  const t = activeTab();
  if (!t || tabs.length < 2) return;
  const next = tabs[(tabs.indexOf(t) + delta + tabs.length) % tabs.length];
  void switchTab(next);
}

// ======================================================================= wiring

initViewer($('#viewer'), $('#pages'), thumbsEl);
initOrganizer($('#organizer'));
initCompare($('#compare'));
initOcr($('#ocr-banner'));
initAssistant($('#assistant'), () => void openSettings());
setDiscardConfirm(askToSave);
// "Save" in the close-window prompt: save every changed document, then close.
api.onSaveAndClose(async () => {
  if (await saveAll()) api.closeWindow();
});
buildRail();
buildTitlebar();
updatePager = buildPager();

on('state', refreshChrome);
on('current', refreshChrome);
on('opened', () => {
  // Show the new document: leave Home, or rebuild the active mode's panel for it.
  if (mode.id === 'home') void setMode('edit');
  else if (mode.id !== 'compare') void setMode(mode.id);
});

/** A dialog or the palette is open (ignoring ones that are fading out). */
const dialogOpen = () => !!document.querySelector('.modal-backdrop:not(.leaving), .palette-backdrop:not(.leaving)');

// Double-click text to type into it (Edit mode, with Select or Edit text).
document.addEventListener('page:dblclick', (e) => {
  const { pv, x, y } = (e as CustomEvent<PageDblClick>).detail;
  if (!doc.editable || mode.id !== 'edit' || !['select', 'edittext'].includes(pen.tool)) return;
  window.getSelection()?.removeAllRanges(); // drop the word the double-click selected
  setTool('edittext');
  void editTextAt(pv, x, y);
});

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'k') {
    e.preventDefault();
    palette();
    return;
  }
  if (e.ctrlKey && key === 'tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
    return;
  }
  if (isTyping(e.target)) return;
  // Claim undo/redo outside text fields: otherwise Chromium's built-in undo
  // jumps to the last field the user typed in (e.g. search) and undoes that.
  if (mod && (key === 'z' || key === 'y')) {
    e.preventDefault();
    lastKeyUndo = Date.now();
    if (!dialogOpen()) void (key === 'y' || e.shiftKey ? redo() : undo());
    return;
  }
  if (dialogOpen()) return;
  if (key === 'escape') {
    stopPlacing();
    if (mode.id === 'edit') setTool('select');
    else if (mode.id !== 'redact' && mode.id !== 'prepare') setInteraction(null);
  } else if (!mod && !e.altKey && doc.pdf && mode.id === 'edit') {
    const tools: Record<string, PenTool> = { v: 'select', e: 'edittext', t: 'text', h: 'highlight', d: 'ink', r: 'eraser', w: 'whiteout' };
    if (tools[key]) setTool(tools[key]);
  }
});

// Drop a PDF anywhere to open it.
const dropOverlay = $('#drop-overlay');
let dragDepth = 0;
const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
document.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  const path = api.pathForFile(file);
  if (!path) return;
  if (!/\.pdf$/i.test(path)) return toast('Only PDF files can be opened.');
  void openPath(path);
});

/** When the key handler above already undid this press (some platforms also deliver it via the menu). */
let lastKeyUndo = 0;
function menuUndo(kind: 'undo' | 'redo') {
  if (isTyping(document.activeElement)) return document.execCommand(kind);
  if (Date.now() - lastKeyUndo < 400 || dialogOpen()) return;
  return kind === 'undo' ? undo() : redo();
}

const menuActions: Record<MenuAction, () => unknown> = {
  open: openAndEdit,
  save: () => save(),
  saveAs: () => save(true),
  insertPdf: insertFromPdf,
  find: focusSearch,
  zoomIn: () => setZoom(view.scale * 1.2),
  zoomOut: () => setZoom(view.scale / 1.2),
  fitWidth: () => setZoom('fit'),
  palette,
  closeTab: closeDoc,
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
  undo: () => menuUndo('undo'),
  redo: () => menuUndo('redo'),
  home: () => setMode('home'),
  settings: openSettings,
};
api.onMenu((action) => void menuActions[action]?.());
api.onOpenRequest((path) => void openPath(path));

// Read-only hook for end-to-end tests: the current document's bytes.
(window as unknown as { __debugDocBytes: () => Uint8Array | null }).__debugDocBytes = () => doc.bytes;

void (async () => {
  await Promise.all([loadSignatures(), loadTemplates(), loadBrand(), refreshAssistant()]);
  await setMode('home');
  const pending = await api.takePendingOpen();
  if (pending) await openPath(pending);
})();
