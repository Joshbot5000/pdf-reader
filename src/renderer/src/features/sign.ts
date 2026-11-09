/** Fill & Sign: form filling, a signature library, and placing signatures, initials and dates. */
import { addImage, addText, getFormFields, setFormFields, type FormField } from '../../../shared/pdfOps';
import type { SavedSignature } from '../../../shared/ipc';
import { api, applyEdit, doc, on } from '../core/doc';
import { setInteraction, toPdf, view, type Interaction } from '../core/viewer';
import { button, h, icon, uid } from '../ui/dom';
import { confirmModal, openModal, toast } from '../ui/overlays';
import { startTextDraft } from './annotate';

let signatures: SavedSignature[] = [];
let panelEl: HTMLElement | null = null;

export async function loadSignatures() {
  signatures = (await api.getState()).signatures;
}

const dataUrlToBytes = (url: string) => Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- signature pad

/** Crop transparent margins and return a PNG data URL. */
function trimCanvas(src: HTMLCanvasElement): string | null {
  const ctx = src.getContext('2d')!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = h('canvas', { width: x1 - x0 + 1, height: y1 - y0 + 1 });
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

const INKS = ['#14141f', '#1a3fbf', '#5b2bd6'];
const SCRIPTS = ['Great Vibes', 'Dancing Script', 'Caveat'];

export async function createSignature(kind: SavedSignature['kind']): Promise<SavedSignature | null> {
  const W = 640, H = 220;
  let ink = INKS[0];
  let tab: 'draw' | 'type' | 'upload' = 'draw';

  // Draw
  const pad = h('canvas', { class: 'sig-pad', width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px` } });
  const pctx = pad.getContext('2d')!;
  pctx.scale(2, 2);
  pctx.lineCap = pctx.lineJoin = 'round';
  let drawing = false;
  let last: [number, number] | null = null;
  let lastMid: [number, number] | null = null;
  let hasInk = false;
  const pos = (e: PointerEvent): [number, number] => {
    const r = pad.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    pad.setPointerCapture(e.pointerId);
    last = pos(e);
    lastMid = last;
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing || !last || !lastMid) return;
    const p = pos(e);
    const mid: [number, number] = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
    const speed = Math.hypot(p[0] - last[0], p[1] - last[1]);
    pctx.strokeStyle = ink;
    pctx.lineWidth = Math.max(1.6, 4.2 - speed * 0.12) * (e.pressure > 0 && e.pointerType === 'pen' ? e.pressure * 1.6 : 1);
    pctx.beginPath();
    pctx.moveTo(...lastMid);
    pctx.quadraticCurveTo(last[0], last[1], mid[0], mid[1]);
    pctx.stroke();
    last = p;
    lastMid = mid;
    hasInk = true;
  });
  pad.addEventListener('pointerup', () => (drawing = false));
  const clear = () => {
    pctx.clearRect(0, 0, W, H);
    hasInk = false;
  };

  // Type
  const nameInput = h('input', { class: 'input sig-name', placeholder: kind === 'initials' ? 'Your initials' : 'Type your name', type: 'text' });
  let script = SCRIPTS[0];
  const previews = h('div', { class: 'sig-fonts' });
  const renderPreviews = () => {
    previews.replaceChildren(
      ...SCRIPTS.map((f) =>
        h('button', {
          type: 'button',
          class: `sig-font${f === script ? ' active' : ''}`,
          style: { fontFamily: `'${f}', cursive`, color: ink },
          on: { click: () => ((script = f), renderPreviews()) },
        }, nameInput.value || (kind === 'initials' ? 'JL' : 'Your Name')),
      ),
    );
  };
  nameInput.addEventListener('input', renderPreviews);

  // Upload
  let uploaded: HTMLCanvasElement | null = null;
  const uploadPreview = h('div', { class: 'sig-upload-preview' }, h('span', { class: 'muted' }, 'PNG or JPEG. White backgrounds are removed automatically.'));
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg',
    on: {
      change: async () => {
        const f = fileInput.files?.[0];
        if (!f) return;
        const img = await createImageBitmap(f);
        const scale = Math.min(1, 1200 / img.width);
        const c = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
          if (lum > 225) d.data[i + 3] = 0; // knock out paper white
        }
        ctx.putImageData(d, 0, 0);
        uploaded = c;
        c.className = 'sig-uploaded';
        uploadPreview.replaceChildren(c);
      },
    },
  });

  const panes = {
    draw: h('div', { class: 'sig-pane' }, pad, h('div', { class: 'sig-line' }), button({ label: 'Clear', kind: 'ghost', icon: 'whiteout', onClick: clear })),
    type: h('div', { class: 'sig-pane' }, nameInput, previews),
    upload: h('div', { class: 'sig-pane' }, h('label', { class: 'btn btn-soft file-btn' }, icon('image', 16), h('span', {}, 'Choose image…'), fileInput), uploadPreview),
  };
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const inkPicker = h('div', { class: 'swatches' }, ...INKS.map((c) => {
    const s = h('button', { type: 'button', class: `swatch${c === ink ? ' active' : ''}`, style: { background: c }, title: 'Ink colour' });
    s.addEventListener('click', () => {
      ink = c;
      inkPicker.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === s));
      renderPreviews();
    });
    return s;
  }));
  const body = h('div', { class: 'sig-editor' }, h('div', { class: 'sig-toolbar' }, tabs, inkPicker), ...Object.values(panes));
  const show = (t: typeof tab) => {
    tab = t;
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== t;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'type') nameInput.focus();
  };
  for (const [t, label] of [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']] as const) {
    const b = h('button', { type: 'button', class: 'tab', dataset: { tab: t } }, label);
    b.addEventListener('click', () => show(t));
    tabs.append(b);
  }
  renderPreviews();
  show('draw');

  let result: SavedSignature | null = null;
  const m = openModal({
    title: kind === 'initials' ? 'Create initials' : 'Create signature',
    icon: 'penTool',
    wide: true,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: async () => {
          let dataUrl: string | null = null;
          if (tab === 'draw') dataUrl = hasInk ? trimCanvas(pad) : null;
          else if (tab === 'upload') dataUrl = uploaded ? trimCanvas(uploaded) : null;
          else if (nameInput.value.trim()) {
            await document.fonts.load(`96px '${script}'`);
            const c = h('canvas', { width: 1400, height: 320 });
            const ctx = c.getContext('2d')!;
            ctx.font = `${kind === 'initials' ? 150 : 120}px '${script}', cursive`;
            ctx.fillStyle = ink;
            ctx.textBaseline = 'middle';
            ctx.fillText(nameInput.value.trim(), 20, 170);
            dataUrl = trimCanvas(c);
          }
          if (!dataUrl) {
            toast(tab === 'type' ? 'Type your name first.' : tab === 'upload' ? 'Choose an image first.' : 'Draw your signature first.');
            return false;
          }
          result = { id: uid(), kind, dataUrl, createdAt: Date.now() };
          signatures = [result, ...signatures];
          await api.setState('signatures', signatures);
          renderPanel();
        },
      },
    ],
  });
  await m.result;
  return result;
}

// ---------------------------------------------------------------- placing

let placingCleanup: (() => void) | null = null;

export function stopPlacing() {
  placingCleanup?.();
  placingCleanup = null;
  setInteraction(null);
  document.querySelectorAll('.sig-chip.active').forEach((c) => c.classList.remove('active'));
}

export async function placeSignature(sig: SavedSignature) {
  if (!doc.editable) return toast('This PDF cannot be edited.');
  stopPlacing();
  const img = new Image();
  img.src = sig.dataUrl;
  await img.decode();
  const widthPt = sig.kind === 'initials' ? 60 : 150;
  const heightPt = (widthPt * img.height) / img.width;
  const ghost = h('img', { class: 'ghost-sig', src: sig.dataUrl, alt: '' });
  const place: Interaction = {
    cursor: 'copy',
    move(pv, _e, x, y) {
      if (ghost.parentElement !== pv.overlay) pv.overlay.append(ghost);
      Object.assign(ghost.style, {
        width: `${widthPt * view.scale}px`,
        left: `${x - (widthPt * view.scale) / 2}px`,
        top: `${y - (heightPt * view.scale) / 2}px`,
      });
    },
    leave: () => ghost.remove(),
    async down(pv, e, x, y) {
      e.preventDefault();
      const w = widthPt * view.scale;
      const hgt = heightPt * view.scale;
      // Visual bottom-left of the image in user space.
      const at = toPdf(pv, x - w / 2, y + hgt / 2);
      ghost.remove();
      const ok = await applyEdit((b) => addImage(b, { page: pv.index, image: dataUrlToBytes(sig.dataUrl), at, width: widthPt, height: heightPt }), {
        pages: [pv.index],
        label: sig.kind === 'initials' ? 'Initials added' : 'Signature added',
      });
      if (ok && !e.shiftKey) stopPlacing();
    },
  };
  setInteraction(place);
  placingCleanup = () => ghost.remove();
  document.querySelector(`.sig-chip[data-id="${sig.id}"]`)?.classList.add('active');
  toast('Click where the signature should go · hold Shift to place more · Esc to stop', 'info', 4000);
}

export function placeDate() {
  if (!doc.editable) return;
  stopPlacing();
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  setInteraction({
    cursor: 'copy',
    async down(pv, e, x, y) {
      e.preventDefault();
      const size = 11;
      await applyEdit((b) => addText(b, { page: pv.index, lines: [{ text: date, at: toPdf(pv, x, y + size * view.scale * 0.35) }], size, color: { r: 0.08, g: 0.08, b: 0.12 } }), { pages: [pv.index] });
      stopPlacing();
    },
  });
  toast(`Click to stamp today's date (${date})`, 'info', 3000);
}

export function placeText() {
  if (!doc.editable) return;
  stopPlacing();
  setInteraction({
    cursor: 'text',
    down(pv, e, x, y) {
      e.preventDefault();
      startTextDraft(pv, x, y, { size: 11, color: '#14141f' });
      stopPlacing();
    },
  });
}

// ---------------------------------------------------------------- panel

export function signPanel(): HTMLElement {
  panelEl = h('div', { class: 'panel-body' });
  renderPanel();
  return panelEl;
}

on('loaded', () => {
  if (panelEl?.isConnected) void renderFormList();
});

function renderPanel() {
  if (!panelEl) return;
  const sigList = h('div', { class: 'sig-list' });
  for (const kind of ['signature', 'initials'] as const) {
    const mine = signatures.filter((s) => s.kind === kind);
    sigList.append(h('div', { class: 'panel-label' }, kind === 'signature' ? 'Signatures' : 'Initials'));
    const row = h('div', { class: 'sig-row' });
    for (const s of mine) {
      const chip = h(
        'div',
        { class: 'sig-chip', dataset: { id: s.id }, title: 'Click, then click on the page', tabIndex: 0 },
        h('img', { src: s.dataUrl, alt: kind }),
        button({
          icon: 'close',
          title: 'Delete',
          class: 'sig-del',
          onClick: async (e) => {
            e.stopPropagation();
            if (!(await confirmModal('Delete this saved signature?', 'It is only removed from this app; documents you already signed are unchanged.', 'Delete', true))) return;
            signatures = signatures.filter((x) => x.id !== s.id);
            await api.setState('signatures', signatures);
            renderPanel();
          },
        }),
      );
      chip.addEventListener('click', () => void placeSignature(s));
      chip.addEventListener('keydown', (e) => e.key === 'Enter' && void placeSignature(s));
      row.append(chip);
    }
    row.append(
      h('button', { class: 'sig-add', type: 'button', on: { click: async () => {
        const s = await createSignature(kind);
        if (s) void placeSignature(s);
      } } }, icon('plus', 16), kind === 'signature' ? 'New signature' : 'New initials'),
    );
    sigList.append(row);
  }
  const formHost = h('div', { class: 'form-fill' });
  panelEl.replaceChildren(
    h('section', { class: 'panel-section' }, sigList, h('p', { class: 'fine' }, 'These are visual e-signatures (an image of your signature), not certificate-based digital signatures.')),
    h('section', { class: 'panel-section' }, h('div', { class: 'panel-label' }, 'Form fields'), formHost),
  );
  void renderFormList();
}

async function renderFormList() {
  const host = panelEl?.querySelector('.form-fill');
  if (!host || !doc.bytes) return host?.replaceChildren();
  const fields = await getFormFields(doc.bytes);
  if (!fields.length) {
    return host.replaceChildren(
      h('p', { class: 'muted' }, 'No fillable fields. Use ', h('strong', {}, 'Prepare form'), ' to add some, or Add text to type anywhere.'),
    );
  }
  const inputs = new Map<string, () => string | boolean>();
  const rows = fields.map((f: FormField) => {
    if (f.type === 'checkbox') {
      const cb = h('input', { type: 'checkbox', checked: f.value, disabled: f.readOnly });
      inputs.set(f.name, () => cb.checked);
      return h('label', { class: 'check' }, cb, h('span', {}, f.name));
    }
    if (f.type === 'choice') {
      const sel = h('select', { class: 'select', disabled: f.readOnly }, ...['', ...f.options].map((o) => h('option', { value: o, selected: o === f.value }, o || '—')));
      inputs.set(f.name, () => sel.value);
      return h('label', { class: 'field' }, h('span', {}, f.name), sel);
    }
    const input = f.multiline
      ? h('textarea', { class: 'input', value: f.value, disabled: f.readOnly, rows: 3 })
      : h('input', { class: 'input', value: f.value, disabled: f.readOnly, type: 'text' });
    inputs.set(f.name, () => input.value);
    return h('label', { class: 'field' }, h('span', {}, f.name), input);
  });
  const apply = button({
    label: 'Apply to document',
    icon: 'check',
    kind: 'primary',
    class: 'block',
    onClick: async () => {
      const values: Record<string, string | boolean> = {};
      for (const [name, get] of inputs) values[name] = get();
      await applyEdit((b) => setFormFields(b, values), { label: 'Form updated' });
    },
  });
  apply.dataset.needsEdit = '';
  apply.disabled = !doc.editable;
  host.replaceChildren(...rows, apply);
}

export function signRibbon(): HTMLElement[] {
  const edit = (b: HTMLButtonElement) => ((b.dataset.needsEdit = ''), b);
  return [
    h(
      'div',
      { class: 'ribbon-group' },
      edit(button({ icon: 'penTool', label: 'Sign', kind: 'tool', onClick: async () => {
        const s = signatures.find((x) => x.kind === 'signature') ?? (await createSignature('signature'));
        if (s) void placeSignature(s);
      } })),
      edit(button({ icon: 'sign', label: 'Initials', kind: 'tool', onClick: async () => {
        const s = signatures.find((x) => x.kind === 'initials') ?? (await createSignature('initials'));
        if (s) void placeSignature(s);
      } })),
      edit(button({ icon: 'calendar', label: 'Date', kind: 'tool', onClick: placeDate })),
      edit(button({ icon: 'text', label: 'Text', kind: 'tool', onClick: placeText })),
    ),
    h('div', { class: 'ribbon-sep' }),
    h('span', { class: 'ribbon-note' }, 'Pick a signature in the side panel, then click on the page.'),
  ];
}
