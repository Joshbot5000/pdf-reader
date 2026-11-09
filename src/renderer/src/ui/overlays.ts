/** Toasts, modal dialogs and progress overlays. */
import { button, h, icon, type IconName } from './dom';

// ---------------------------------------------------------------- toasts

type ToastKind = 'error' | 'info' | 'success';
const toastIcons: Record<ToastKind, IconName> = { error: 'close', info: 'ai', success: 'check' };

export function toast(message: string, kind: ToastKind = 'error', ms = kind === 'error' ? 7000 : 3500) {
  const root = document.getElementById('toasts')!;
  const el = h(
    'div',
    { class: `toast toast-${kind}`, attrs: { role: kind === 'error' ? 'alert' : 'status' } },
    h('span', { class: 'toast-icon' }, icon(toastIcons[kind], 16)),
    h('span', { class: 'toast-msg' }, message),
  );
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', close);
  root.append(el);
  setTimeout(close, ms);
}

// ---------------------------------------------------------------- modals

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'ghost' | 'danger';
  /** Return false to keep the dialog open. */
  onClick?: () => unknown;
  value?: unknown;
}

export interface ModalOptions {
  title: string;
  icon?: IconName;
  body: Node | string;
  actions?: ModalAction[];
  wide?: boolean;
  onClose?: () => void;
}

export function openModal(opts: ModalOptions): { close: () => void; el: HTMLElement; result: Promise<unknown> } {
  const root = document.getElementById('modal-root')!;
  let resolve!: (v: unknown) => void;
  const result = new Promise<unknown>((r) => (resolve = r));
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (value: unknown = undefined) => {
    backdrop.classList.add('leaving');
    setTimeout(() => backdrop.remove(), 160);
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
    resolve(value);
    prevFocus?.focus?.();
  };
  const footer = h('div', { class: 'modal-actions' });
  for (const a of opts.actions ?? []) {
    footer.append(
      button({
        label: a.label,
        kind: a.kind ?? 'ghost',
        onClick: async () => {
          const r = await a.onClick?.();
          if (r !== false) close(a.value);
        },
      }),
    );
  }
  const dialog = h(
    'div',
    { class: `modal${opts.wide ? ' wide' : ''}`, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } },
    h(
      'div',
      { class: 'modal-head' },
      opts.icon ? h('span', { class: 'modal-icon' }, icon(opts.icon, 18)) : null,
      h('h2', {}, opts.title),
      button({ icon: 'close', title: 'Close', onClick: () => close() }),
    ),
    h('div', { class: 'modal-body' }, opts.body),
    opts.actions?.length ? footer : null,
  );
  backdrop.append(dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  requestAnimationFrame(() => {
    const focusable = dialog.querySelector<HTMLElement>('input, textarea, select, .modal-actions .btn-primary, .modal-actions .btn-danger');
    focusable?.focus();
  });
  return { close, el: dialog, result };
}

export async function confirmModal(title: string, text: string, ok = 'Continue', danger = false): Promise<boolean> {
  const { result } = openModal({
    title,
    icon: danger ? 'shield' : undefined,
    body: h('p', { class: 'modal-text' }, text),
    actions: [
      { label: 'Cancel', value: false },
      { label: ok, kind: danger ? 'danger' : 'primary', value: true },
    ],
  });
  return (await result) === true;
}

export async function promptModal(title: string, label: string, initial = '', ok = 'OK'): Promise<string | null> {
  const input = h('input', { class: 'input', value: initial, type: 'text' });
  let value: string | null = null;
  const m = openModal({
    title,
    body: h('label', { class: 'field' }, h('span', {}, label), input),
    actions: [
      { label: 'Cancel' },
      { label: ok, kind: 'primary', onClick: () => (value = input.value) },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      value = input.value;
      m.close();
    }
  });
  await m.result;
  return value;
}

// ---------------------------------------------------------------- progress

export function progress(title: string) {
  const bar = h('div', { class: 'progress-fill' });
  const label = h('div', { class: 'progress-label' }, 'Starting…');
  let cancelled = false;
  const m = openModal({
    title,
    icon: 'wand',
    body: h('div', { class: 'progress' }, h('div', { class: 'progress-track' }, bar), label),
    actions: [{ label: 'Cancel' }],
    onClose: () => (cancelled = true), // Cancel button, Esc or clicking outside
  });
  return {
    update(fraction: number, text: string) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      label.textContent = text;
    },
    get cancelled() {
      return cancelled;
    },
    close: () => m.close(),
  };
}
