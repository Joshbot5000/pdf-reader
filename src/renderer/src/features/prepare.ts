/** Prepare form: draw fillable fields and save/apply reusable form & e-sign templates. */
import { createFields, getFieldLayouts, removeField, type NewField, type NewFieldType } from '../../../shared/pdfOps';
import type { FormTemplate } from '../../../shared/ipc';
import { api, applyEdit, doc, on, pageCount } from '../core/doc';
import { drag, setDecorator, setInteraction, toPdf, toViewport, view, type Interaction } from '../core/viewer';
import { button, h, icon, timeAgo, uid, type IconName } from '../ui/dom';
import { confirmModal, promptModal, toast } from '../ui/overlays';

const FIELD_TYPES: { type: NewFieldType; label: string; icon: IconName; base: string }[] = [
  { type: 'text', label: 'Text field', icon: 'textField', base: 'Text' },
  { type: 'checkbox', label: 'Checkbox', icon: 'checkbox', base: 'Checkbox' },
  { type: 'dropdown', label: 'Dropdown', icon: 'dropdown', base: 'Dropdown' },
  { type: 'signature', label: 'Signature field', icon: 'penTool', base: 'Signature' },
];

let current: NewFieldType | null = null;
let panelEl: HTMLElement | null = null;
let layouts: NewField[] = [];
let templates: FormTemplate[] = [];
const listeners = new Set<() => void>();

export async function loadTemplates() {
  templates = (await api.getState()).templates;
}

async function refreshLayouts() {
  layouts = doc.bytes ? await getFieldLayouts(doc.bytes) : [];
  renderPanel();
}

on('loaded', () => {
  if (panelEl?.isConnected) void refreshLayouts();
});

function fieldTool(type: NewFieldType): Interaction {
  return {
    cursor: 'crosshair',
    async down(pv, e, x0, y0) {
      if (doc.busy) return;
      const box = h('div', { class: `draft-field ${type}` });
      pv.overlay.append(box);
      const place = (x1: number, y1: number) =>
        Object.assign(box.style, {
          left: `${Math.min(x0, x1)}px`,
          top: `${Math.min(y0, y1)}px`,
          width: `${Math.abs(x1 - x0)}px`,
          height: `${Math.abs(y1 - y0)}px`,
        });
      place(x0, y0);
      let [x1, y1] = await drag(pv, e, place);
      // A click (no drag) creates a field of a sensible default size.
      if (Math.abs(x1 - x0) < 6 && Math.abs(y1 - y0) < 6) {
        const s = view.scale;
        const [w, hgt] = type === 'checkbox' ? [14, 14] : type === 'signature' ? [180, 40] : [180, 22];
        x1 = x0 + w * s;
        y1 = y0 + hgt * s;
      }
      box.remove();
      const a = toPdf(pv, x0, y0);
      const b = toPdf(pv, x1, y1);
      let rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
      if (type === 'checkbox') {
        const side = Math.max(10, Math.min(rect.width, rect.height));
        rect = { ...rect, width: side, height: side };
      }
      let options: string[] | undefined;
      if (type === 'dropdown') {
        const raw = await promptModal('Dropdown options', 'Options, separated by commas', 'Yes, No');
        if (raw === null) return;
        options = raw.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const base = FIELD_TYPES.find((f) => f.type === type)!.base;
      await applyEdit((bytes) => createFields(bytes, [{ type, name: base, page: pv.index, rect, options }]));
    },
  };
}

export function setFieldTool(type: NewFieldType | null) {
  current = type;
  setInteraction(type ? fieldTool(type) : null);
  listeners.forEach((f) => f());
}

export function prepareRibbon(): HTMLElement[] {
  const group = h('div', { class: 'ribbon-group segmented' });
  const btns = FIELD_TYPES.map((f) => {
    const b = button({ icon: f.icon, label: f.label, kind: 'tool', onClick: () => setFieldTool(current === f.type ? null : f.type) });
    b.dataset.needsEdit = '';
    group.append(b);
    return { b, f };
  });
  const sync = () => btns.forEach(({ b, f }) => b.classList.toggle('active', current === f.type));
  listeners.clear();
  listeners.add(sync);
  sync();
  setInteraction(current ? fieldTool(current) : null);
  return [
    group,
    h('div', { class: 'ribbon-sep' }),
    h('span', { class: 'ribbon-note' }, 'Drag on the page to draw a field, or click for a default size.'),
  ];
}

export function preparePanel(): HTMLElement {
  panelEl = h('div', { class: 'panel-body' });
  setDecorator('fields', (pv) =>
    layouts
      .filter((f) => f.page === pv.index)
      .map((f) => {
        const [x0, y0] = toViewport(pv, { x: f.rect.x, y: f.rect.y });
        const [x1, y1] = toViewport(pv, { x: f.rect.x + f.rect.width, y: f.rect.y + f.rect.height });
        return h('div', {
          class: `field-outline ${f.type}`,
          style: { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` },
        }, h('span', {}, f.name));
      }),
  );
  void refreshLayouts();
  return panelEl;
}

export function leavePrepare() {
  setDecorator('fields', null);
  setFieldTool(null);
}

function renderPanel() {
  if (!panelEl) return;
  const list = h('div', { class: 'list' });
  if (!layouts.length) list.append(h('p', { class: 'muted' }, 'No fields yet. Pick a field type above and draw on the page.'));
  for (const f of layouts) {
    const meta = FIELD_TYPES.find((t) => t.type === f.type)!;
    list.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: 'list-icon' }, icon(meta.icon, 15)),
        h('span', { class: 'list-main' }, h('strong', {}, f.name), h('small', {}, `${meta.label} · page ${f.page + 1}`)),
        button({
          icon: 'trash',
          title: `Remove ${f.name}`,
          onClick: () => applyEdit((b) => removeField(b, f.name), { label: `Removed ${f.name}` }),
        }),
      ),
    );
  }

  const tplList = h('div', { class: 'list' });
  if (!templates.length) tplList.append(h('p', { class: 'muted' }, 'Save this document’s fields as a template to reuse them on other documents.'));
  for (const t of templates) {
    const sigs = t.fields.filter((f) => f.type === 'signature').length;
    tplList.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: 'list-icon' }, icon('layers', 15)),
        h('span', { class: 'list-main' }, h('strong', {}, t.name), h('small', {}, `${t.fields.length} fields${sigs ? ` · ${sigs} signature` : ''} · ${timeAgo(t.createdAt)}`)),
        button({ label: 'Apply', kind: 'soft', onClick: () => applyTemplate(t) }),
        button({
          icon: 'trash',
          title: 'Delete template',
          onClick: async () => {
            if (!(await confirmModal(`Delete “${t.name}”?`, 'Documents that used it keep their fields.', 'Delete', true))) return;
            templates = templates.filter((x) => x.id !== t.id);
            await api.setState('templates', templates);
            renderPanel();
          },
        }),
      ),
    );
  }
  const save = button({ icon: 'bookmark', label: 'Save fields as template', kind: 'soft', class: 'block', onClick: saveTemplate });
  save.disabled = !layouts.length;
  panelEl.replaceChildren(
    h('section', { class: 'panel-section' }, h('div', { class: 'panel-label' }, `Fields (${layouts.length})`), list),
    h('section', { class: 'panel-section' }, h('div', { class: 'panel-label' }, 'Templates'), tplList, save),
  );
}

async function saveTemplate() {
  const name = await promptModal('Save template', 'Template name', doc.file?.name.replace(/\.pdf$/i, '') ?? 'Template', 'Save');
  if (!name?.trim()) return;
  const t: FormTemplate = {
    id: uid(),
    name: name.trim(),
    createdAt: Date.now(),
    fields: layouts.map((f) => ({ name: f.name, type: f.type, page: f.page, rect: f.rect, options: f.options })),
  };
  templates = [t, ...templates];
  await api.setState('templates', templates);
  renderPanel();
  toast(`Saved template “${t.name}”`, 'success');
}

async function applyTemplate(t: FormTemplate) {
  const n = pageCount();
  const fitting = t.fields.filter((f) => f.page < n);
  if (fitting.length < t.fields.length) {
    toast(`${t.fields.length - fitting.length} field(s) were skipped because this document has only ${n} page(s).`, 'info');
  }
  await applyEdit((b) => createFields(b, fitting), { label: `Applied “${t.name}”` });
}
