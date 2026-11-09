/** Command palette (Ctrl/Cmd+K): fuzzy-search every action in the app. */
import { h, icon, type IconName } from './dom';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  shortcut?: string;
  keywords?: string;
  enabled?: () => boolean;
  run: () => unknown;
}

function score(cmd: Command, q: string): number {
  if (!q) return 1;
  const hay = `${cmd.label} ${cmd.group} ${cmd.keywords ?? ''}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i === -1) return 0;
    s += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1;
  }
  return s;
}

export function openPalette(commands: Command[]) {
  if (document.querySelector('.palette')) return;
  const input = h('input', { class: 'palette-input', placeholder: 'Type a command or search…', attrs: { 'aria-label': 'Command' } });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const root = h('div', { class: 'palette-backdrop' }, h('div', { class: 'palette', role: 'dialog', attrs: { 'aria-label': 'Command palette' } },
    h('div', { class: 'palette-head' }, icon('command', 18), input), list));
  let results: Command[] = [];
  let index = 0;
  const close = () => {
    root.classList.add('leaving');
    setTimeout(() => root.remove(), 140);
  };
  const run = (c: Command | undefined) => {
    if (!c || (c.enabled && !c.enabled())) return;
    close();
    setTimeout(() => void c.run(), 0);
  };
  const render = () => {
    const q = input.value.trim();
    results = commands
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, 40);
    index = Math.min(index, Math.max(0, results.length - 1));
    let lastGroup = '';
    list.replaceChildren();
    results.forEach((c, i) => {
      if (!q && c.group !== lastGroup) {
        list.append(h('div', { class: 'palette-group' }, c.group));
        lastGroup = c.group;
      }
      const disabled = !!c.enabled && !c.enabled();
      const row = h(
        'div',
        { class: `palette-item${i === index ? ' active' : ''}${disabled ? ' disabled' : ''}`, role: 'option' },
        h('span', { class: 'palette-icon' }, icon(c.icon, 16)),
        h('span', { class: 'palette-label' }, c.label),
        q ? h('span', { class: 'palette-hint' }, c.group) : null,
        c.shortcut ? h('kbd', {}, c.shortcut) : null,
      );
      row.addEventListener('mousemove', () => {
        if (index !== i) {
          index = i;
          list.querySelectorAll('.palette-item').forEach((el, k) => el.classList.toggle('active', k === i));
        }
      });
      row.addEventListener('click', () => run(c));
      list.append(row);
    });
    if (!results.length) list.append(h('div', { class: 'palette-empty' }, 'No matching commands'));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => ((index = 0), render()));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = Math.min(results.length - 1, index + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = Math.max(0, index - 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[index]);
    } else if (e.key === 'Escape') close();
  });
  root.addEventListener('mousedown', (e) => e.target === root && close());
  document.body.append(root);
  render();
  input.focus();
}
