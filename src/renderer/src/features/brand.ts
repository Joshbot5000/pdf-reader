/** Brand: stamp a logo, a line of text and a clickable URL on agreements, with a live preview. */
import { applyBrand } from '../../../shared/pdfOps';
import type { BrandPosition, BrandProfile } from '../../../shared/ipc';
import { api, applyEdit, doc } from '../core/doc';
import { setDecorator, view, type PageView } from '../core/viewer';
import { button, h, icon } from '../ui/dom';
import { toast } from '../ui/overlays';

const defaults = (): BrandProfile => ({ logoDataUrl: null, url: '', text: '', position: 'top-right', logoHeight: 28, pages: 'all' });
let profile: BrandProfile = defaults();
let panelEl: HTMLElement | null = null;

export async function loadBrand() {
  profile = { ...defaults(), ...((await api.getState()).brand ?? {}) };
}

const dataUrlToBytes = (url: string) => Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));

/** Mirror of applyBrand's layout, drawn in the page's visual frame. */
function preview(pv: PageView): Node[] {
  if (profile.pages === 'first' && pv.index !== 0) return [];
  const text = profile.text.trim();
  const url = profile.url.trim();
  if (!profile.logoDataUrl && !text && !url) return [];
  const s = view.scale;
  const margin = 28 * s;
  const top = profile.position.startsWith('top');
  const right = profile.position.endsWith('right');
  const block = h(
    'div',
    {
      class: `brand-preview${right ? ' right' : ''}`,
      style: {
        [top ? 'top' : 'bottom']: `${margin}px`,
        [right ? 'right' : 'left']: `${margin}px`,
        gap: `${8 * s}px`,
        fontSize: `${9 * s}px`,
      } as Record<string, string>,
    },
    profile.logoDataUrl ? h('img', { src: profile.logoDataUrl, alt: '', style: { height: `${profile.logoHeight * s}px` } }) : null,
    text || url ? h('div', { class: 'brand-lines' }, text ? h('strong', {}, text) : null, url ? h('span', {}, url) : null) : null,
  );
  return [block];
}

async function persist() {
  await api.setState('brand', profile);
  setDecorator('brand', preview);
}

export function activateBrand() {
  setDecorator('brand', preview);
}

export function leaveBrand() {
  setDecorator('brand', null);
}

export function brandPanel(): HTMLElement {
  panelEl = h('div', { class: 'panel-body' });
  render();
  return panelEl;
}

function render() {
  if (!panelEl) return;
  const logoInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg',
    on: {
      change: async () => {
        const f = logoInput.files?.[0];
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) return toast('Choose a logo under 4 MB.');
        profile.logoDataUrl = await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.readAsDataURL(f);
        });
        await persist();
        render();
      },
    },
  });
  const textInput = h('input', { class: 'input', type: 'text', value: profile.text, placeholder: 'e.g. Landon & Co. Solicitors' });
  const urlInput = h('input', { class: 'input', type: 'text', value: profile.url, placeholder: 'e.g. landon.co.uk/agreements' });
  for (const [el, key] of [[textInput, 'text'], [urlInput, 'url']] as const) {
    el.addEventListener('input', () => {
      profile[key] = el.value;
      void persist();
    });
  }
  const positions: BrandPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const corner = h(
    'div',
    { class: 'corner-picker', role: 'radiogroup', attrs: { 'aria-label': 'Position' } },
    ...positions.map((p) =>
      h('button', {
        type: 'button',
        class: `corner ${p}${profile.position === p ? ' active' : ''}`,
        title: p.replace('-', ' '),
        on: { click: () => ((profile.position = p), void persist(), render()) },
      }),
    ),
  );
  const size = h('input', {
    type: 'range',
    class: 'range',
    min: '14',
    max: '72',
    value: String(profile.logoHeight),
    on: { input: (e) => ((profile.logoHeight = Number((e.target as HTMLInputElement).value)), void persist()) },
  });
  const pages = h(
    'select',
    { class: 'select', on: { change: (e) => ((profile.pages = (e.target as HTMLSelectElement).value as 'all' | 'first'), void persist()) } },
    h('option', { value: 'all', selected: profile.pages === 'all' }, 'Every page'),
    h('option', { value: 'first', selected: profile.pages === 'first' }, 'First page only'),
  );
  panelEl.replaceChildren(
    h(
      'section',
      { class: 'panel-section' },
      h('div', { class: 'panel-label' }, 'Logo'),
      h(
        'div',
        { class: 'logo-drop' },
        profile.logoDataUrl ? h('img', { src: profile.logoDataUrl, alt: 'Logo' }) : icon('image', 26),
        h('label', { class: 'btn btn-soft file-btn' }, h('span', {}, profile.logoDataUrl ? 'Replace…' : 'Choose logo…'), logoInput),
        profile.logoDataUrl ? button({ label: 'Remove', kind: 'ghost', onClick: async () => ((profile.logoDataUrl = null), await persist(), render()) }) : null,
      ),
      h('label', { class: 'field' }, h('span', {}, 'Logo height'), size),
    ),
    h(
      'section',
      { class: 'panel-section' },
      h('label', { class: 'field' }, h('span', {}, 'Name or tagline'), textInput),
      h('label', { class: 'field' }, h('span', {}, 'Custom URL (clickable)'), urlInput),
      h('div', { class: 'field' }, h('span', {}, 'Position'), corner),
      h('label', { class: 'field' }, h('span', {}, 'Pages'), pages),
    ),
    h(
      'section',
      { class: 'panel-section' },
      (() => {
        const b = button({ icon: 'brand', label: 'Apply branding', kind: 'primary', class: 'block', onClick: apply });
        b.dataset.needsEdit = '';
        b.disabled = !doc.editable;
        return b;
      })(),
      h('p', { class: 'fine' }, 'Your brand settings are remembered for next time. The preview on the page shows exactly where it will go.'),
    ),
  );
}

async function apply() {
  await applyEdit(
    (b) =>
      applyBrand(b, {
        logo: profile.logoDataUrl ? dataUrlToBytes(profile.logoDataUrl) : null,
        url: profile.url,
        text: profile.text,
        position: profile.position,
        logoHeight: profile.logoHeight,
        pages: profile.pages,
      }),
    { label: 'Branding applied' },
  );
}

export function brandRibbon(): HTMLElement[] {
  return [h('span', { class: 'ribbon-note' }, icon('brand', 14), 'Set your logo, name and URL in the panel, check the preview, then apply.')];
}
