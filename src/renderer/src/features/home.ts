/** Home screen: open or drop a file, recent documents and a launcher for every tool. */
import type { RecentFile } from '../../../shared/ipc';
import { api, openDialog, openPath } from '../core/doc';
import { button, h, icon, timeAgo, type IconName } from '../ui/dom';

export interface Tool {
  mode: string;
  label: string;
  icon: IconName;
  blurb: string;
  needsDoc: boolean;
  hue: number;
}

export function renderHome(container: HTMLElement, tools: Tool[], go: (mode: string) => void, recent: RecentFile[]) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const drop = h(
    'div',
    { class: 'drop-card', tabIndex: 0, attrs: { role: 'button', 'aria-label': 'Open a PDF' } },
    h('div', { class: 'drop-glow' }),
    h('div', { class: 'drop-icon' }, icon('file', 30)),
    h('h3', {}, 'Open a PDF'),
    h('p', {}, 'Drop a file here, or browse your computer'),
    button({ label: 'Choose file', icon: 'open', kind: 'primary', onClick: (e) => (e.stopPropagation(), void openThen('edit')) }),
  );
  const openThen = async (mode: string) => {
    if (await openDialog()) go(mode);
  };
  drop.addEventListener('click', () => void openThen('edit'));
  drop.addEventListener('keydown', (e) => e.key === 'Enter' && void openThen('edit'));

  const recentList = h('div', { class: 'recent-list' });
  if (!recent.length) {
    recentList.append(h('p', { class: 'muted' }, 'Files you open will appear here.'));
  }
  for (const r of recent.slice(0, 8)) {
    const folder = r.path.replace(/[\\/][^\\/]*$/, '');
    recentList.append(
      h(
        'button',
        {
          type: 'button',
          class: 'recent',
          title: r.path,
          on: { click: async () => (await openPath(r.path)) && go('edit') },
        },
        h('span', { class: 'recent-icon' }, icon('file', 18)),
        h('span', { class: 'recent-main' }, h('strong', {}, r.name), h('small', {}, folder)),
        h('span', { class: 'recent-time' }, timeAgo(r.openedAt)),
      ),
    );
  }

  const toolGrid = h(
    'div',
    { class: 'tool-grid' },
    ...tools.map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tool-card',
          style: { '--hue': String(t.hue) } as Record<string, string>,
          on: { click: () => (t.needsDoc && !window.__hasDoc ? void openThen(t.mode) : go(t.mode)) },
        },
        h('span', { class: 'tool-icon' }, icon(t.icon, 20)),
        h('strong', {}, t.label),
        h('small', {}, t.blurb),
      ),
    ),
  );

  container.replaceChildren(
    h(
      'div',
      { class: 'home-inner' },
      h('header', { class: 'home-hero' }, h('p', { class: 'eyebrow' }, greeting), h('h1', {}, 'What are we working on ', h('span', { class: 'grad' }, 'today?'))),
      h('div', { class: 'home-top' }, drop, h('section', { class: 'home-recent' }, h('h2', {}, 'Recent'), recentList)),
      h('section', {}, h('h2', {}, 'All tools'), toolGrid),
      h('p', { class: 'home-hint' }, icon('command', 14), 'Press ', h('kbd', {}, api.platform === 'darwin' ? '⌘K' : 'Ctrl K'), ' to search every command'),
    ),
  );
}

declare global {
  interface Window {
    __hasDoc?: boolean;
  }
}
