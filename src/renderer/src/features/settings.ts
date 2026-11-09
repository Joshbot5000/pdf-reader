import type { AppState } from '../../../shared/ipc';
import { api } from '../core/doc';
import { button, h, icon } from '../ui/dom';
import { openModal, toast } from '../ui/overlays';
import { refreshAssistant } from './assistant';

export async function openSettings() {
  const state = await api.getState();
  let { hasKey } = await api.aiStatus();
  let theme = state.settings.theme;

  const themes: { id: AppState['settings']['theme']; label: string; icon: 'sun' | 'moon' | 'settings' }[] = [
    { id: 'system', label: 'System', icon: 'settings' },
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'dark', label: 'Dark', icon: 'moon' },
  ];
  const themeRow = h('div', { class: 'segmented-control' });
  const renderThemes = () =>
    themeRow.replaceChildren(
      ...themes.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: theme === t.id ? 'active' : '',
            on: {
              click: async () => {
                theme = t.id;
                await api.setState('settings', { ...state.settings, theme });
                renderThemes();
              },
            },
          },
          icon(t.icon, 15),
          t.label,
        ),
      ),
    );
  renderThemes();

  const keyInput = h('input', { class: 'input mono', type: 'password', placeholder: hasKey ? '••••••••••••••••  (saved)' : 'sk-ant-…', autocomplete: 'off' });
  const status = h('span', { class: `pill ${hasKey ? 'ok' : ''}` });
  const renderStatus = () => {
    status.className = `pill ${hasKey ? 'ok' : ''}`;
    status.textContent = hasKey ? 'Connected' : 'Not set';
  };
  renderStatus();
  const saveKey = async () => {
    const v = keyInput.value.trim();
    if (!v) return;
    if (!/^sk-ant-/.test(v)) toast('That does not look like an Anthropic API key (they start with “sk-ant-”). Saved anyway.', 'info');
    try {
      await api.aiSetKey(v);
      hasKey = true;
      keyInput.value = '';
      keyInput.placeholder = '••••••••••••••••  (saved)';
      renderStatus();
      toast('API key saved securely', 'success');
      void refreshAssistant();
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
    }
  };
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && void saveKey());

  openModal({
    title: 'Settings',
    icon: 'settings',
    body: h(
      'div',
      { class: 'settings' },
      h('section', {}, h('h3', {}, 'Appearance'), themeRow),
      h(
        'section',
        {},
        h('h3', {}, 'AI Assistant ', status),
        h('p', { class: 'muted' }, 'The assistant uses Claude through your own Anthropic API key. The key is encrypted with your operating system’s keychain and never leaves this computer except to call the API.'),
        h('div', { class: 'row' }, keyInput, button({ label: 'Save', kind: 'primary', onClick: saveKey })),
        h(
          'div',
          { class: 'row' },
          h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', class: 'link' }, 'Get an API key ↗'),
          button({
            label: 'Remove key',
            kind: 'ghost',
            onClick: async () => {
              await api.aiSetKey(null);
              hasKey = false;
              renderStatus();
              void refreshAssistant();
            },
          }),
        ),
        h('p', { class: 'fine' }, 'When you ask a question, the open document (or a Space’s sources) is sent to Anthropic to generate the answer.'),
      ),
      h(
        'section',
        {},
        h('h3', {}, 'Privacy'),
        h('p', { class: 'muted' }, 'Viewing, editing, signing, redaction, OCR and comparison all run on this computer. Nothing is uploaded unless you use the AI Assistant.'),
      ),
    ),
  });
}
