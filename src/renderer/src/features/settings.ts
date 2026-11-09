import type { AppState } from '../../../shared/ipc';
import { api } from '../core/doc';
import { button, h, icon } from '../ui/dom';
import { openModal, toast } from '../ui/overlays';
import { refreshAssistant } from './assistant';

type Provider = 'gemini' | 'claude';

const PROVIDERS: Record<Provider, { name: string; badge: string; keyUrl: string; keyLabel: string; placeholder: string; blurb: string; prefix: RegExp }> = {
  gemini: {
    name: 'Google Gemini',
    badge: 'Free',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'Get a free key from Google AI Studio ↗',
    placeholder: 'AIza…',
    blurb:
      'Free with a Google account: no card needed. Reads your PDFs directly (text, tables and scans) and handles long documents. The free tier has daily limits; if one model’s limit is reached the app switches to another automatically.',
    prefix: /^AIza/,
  },
  claude: {
    name: 'Anthropic Claude',
    badge: 'Paid',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: 'Get an API key ↗',
    placeholder: 'sk-ant-…',
    blurb: 'Pay-as-you-go. Answers include exact quoted citations from the document.',
    prefix: /^sk-ant-/,
  },
};

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));

export async function openSettings() {
  const state = await api.getState();
  let settings: AppState['settings'] = { ...state.settings };
  let status = await api.aiStatus();
  let provider: Provider = settings.aiProvider ?? 'gemini';

  const persist = async () => {
    settings = (await api.setState('settings', settings)).settings;
    status = await api.aiStatus();
    void refreshAssistant();
  };

  // ---- appearance
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
            class: settings.theme === t.id ? 'active' : '',
            on: {
              click: async () => {
                settings.theme = t.id;
                await persist();
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

  // ---- AI
  const aiBody = h('div');
  const renderAi = () => {
    const p = PROVIDERS[provider];
    const hasKey = status.keys[provider];
    const providerRow = h(
      'div',
      { class: 'provider-cards' },
      ...(Object.keys(PROVIDERS) as Provider[]).map((id) =>
        h(
          'button',
          {
            type: 'button',
            class: `provider-card${provider === id ? ' active' : ''}`,
            on: {
              click: async () => {
                provider = id;
                settings.aiProvider = id;
                await persist();
                renderAi();
              },
            },
          },
          h('span', { class: 'provider-name' }, PROVIDERS[id].name, h('span', { class: `pill ${id === 'gemini' ? 'ok' : ''}` }, PROVIDERS[id].badge)),
          h('small', {}, status.keys[id] ? 'Key saved' : 'No key yet'),
        ),
      ),
    );
    const keyInput = h('input', { class: 'input mono', type: 'password', placeholder: hasKey ? '••••••••••••••••  (saved)' : p.placeholder, autocomplete: 'off' });
    const saveKey = async () => {
      const v = keyInput.value.trim();
      if (!v) return;
      if (!p.prefix.test(v)) toast(`That doesn’t look like a ${p.name} key. Saved anyway.`, 'info');
      try {
        await api.aiSetKey(provider, v);
        keyInput.value = '';
        await persist();
        toast(`${p.name} key saved securely`, 'success');
        renderAi();
      } catch (err) {
        toast(clean(err));
      }
    };
    keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && void saveKey());

    const modelRow = h('div');
    if (provider === 'gemini' && hasKey) {
      const select = h('select', { class: 'select' }, h('option', { value: 'auto' }, 'Automatic (best free model)'));
      select.addEventListener('change', async () => {
        settings.geminiModel = select.value;
        await persist();
      });
      modelRow.append(h('label', { class: 'field' }, h('span', {}, 'Model'), select));
      void api
        .aiGeminiModels()
        .then((models) => {
          for (const m of models) select.add(new Option(m, m, false, settings.geminiModel === m));
          if (!settings.geminiModel || settings.geminiModel === 'auto') select.value = 'auto';
        })
        .catch(() => {});
    }

    const testResult = h('div', { class: 'test-result', attrs: { 'aria-live': 'polite' } });
    const testBtn =
      provider === 'gemini' && hasKey
        ? button({
            label: 'Test connection',
            icon: 'check',
            kind: 'soft',
            onClick: async () => {
              testResult.className = 'test-result';
              testResult.textContent = 'Testing…';
              const r = await api.aiTestGemini();
              testResult.className = `test-result ${r.ok ? 'ok' : 'bad'}`;
              testResult.textContent = r.message;
            },
          })
        : null;

    aiBody.replaceChildren(
      providerRow,
      h('p', { class: 'muted' }, p.blurb),
      h('div', { class: 'row' }, keyInput, button({ label: 'Save', kind: 'primary', onClick: saveKey })),
      h(
        'div',
        { class: 'row' },
        h('a', { href: p.keyUrl, target: '_blank', class: 'link' }, p.keyLabel),
        hasKey
          ? button({
              label: 'Remove key',
              kind: 'ghost',
              onClick: async () => {
                await api.aiSetKey(provider, null);
                await persist();
                renderAi();
              },
            })
          : null,
      ),
      modelRow,
      testBtn ? h('div', { class: 'row' }, testBtn) : '',
      testResult,
      h(
        'p',
        { class: 'fine' },
        provider === 'gemini'
          ? 'When you ask a question, the open document (or a Space’s sources) is sent to Google to answer it. On the free tier Google may use prompts to improve its products, except in the UK, EEA and Switzerland. Keys are encrypted on this computer.'
          : 'When you ask a question, the open document (or a Space’s sources) is sent to Anthropic to answer it. Keys are encrypted on this computer.',
      ),
    );
  };
  renderAi();

  openModal({
    title: 'Settings',
    icon: 'settings',
    body: h(
      'div',
      { class: 'settings' },
      h('section', {}, h('h3', {}, 'Appearance'), themeRow),
      h('section', {}, h('h3', {}, 'AI Assistant'), aiBody),
      h(
        'section',
        {},
        h('h3', {}, 'Privacy'),
        h('p', { class: 'muted' }, 'Viewing, editing, signing, redaction, OCR and comparison all run on this computer. Nothing is uploaded unless you use the AI Assistant.'),
      ),
    ),
  });
}
