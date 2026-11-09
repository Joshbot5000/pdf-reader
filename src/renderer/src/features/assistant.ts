/**
 * AI Assistant panel: chat with the open document (with page citations),
 * one-click PDF Actions, remix into a slide deck, and PDF Spaces that chat
 * across several PDFs, documents and web pages.
 */
import type { AiBlock, AiDoc, AiEvent, SlideOutline, Space } from '../../../shared/ipc';
import { api, doc, on, setCurrent } from '../core/doc';
import { scrollToPage } from '../core/viewer';
import { button, formatBytes, h, icon, timeAgo, uid, type IconName } from '../ui/dom';
import { markdown } from '../ui/markdown';
import { confirmModal, openModal, promptModal, toast } from '../ui/overlays';
import { searchFor } from './search';

interface UiMessage {
  role: 'user' | 'assistant';
  text: string;
  blocks?: AiBlock[];
  error?: string;
}

interface Conversation {
  id: string;
  messages: UiMessage[];
  /** Document generation the conversation was started on (document chats). */
  generation?: number;
}

const ACTIONS: { label: string; icon: IconName; prompt: string }[] = [
  { label: 'Summarize', icon: 'file', prompt: 'Summarize this document: a two-sentence overview, then the key points as bullets, then anything the reader must act on.' },
  { label: 'Key points', icon: 'list', prompt: 'List the most important points of this document as concise bullets, most important first.' },
  { label: 'Explain simply', icon: 'chat', prompt: 'Explain this document in plain English for someone without specialist knowledge. Define any technical or legal terms you use.' },
  { label: 'Dates & obligations', icon: 'calendar', prompt: 'Extract every obligation, deadline, date, amount and party from this document into a table with columns Who, What, When, and Where in the document.' },
  { label: 'Risky terms', icon: 'shield', prompt: 'Identify clauses or terms that could be unfavourable, unusual or risky for the reader. Quote each one, say why it matters, and suggest what to ask about or negotiate.' },
  { label: 'Quiz me', icon: 'badge', prompt: 'Write 6 multiple-choice questions that test understanding of this document. Put the answers, with a one-line explanation and page reference, at the end.' },
  { label: 'Draft email', icon: 'send', prompt: 'Draft a concise, professional email to a colleague that summarises this document and flags anything that needs their attention.' },
];

let panel: HTMLElement;
let tab: 'doc' | 'spaces' = 'doc';
let hasKey = false;
let docConvo: Conversation = { id: uid(), messages: [] };
const spaceConvos = new Map<string, Conversation>();
let spaces: Space[] = [];
let activeSpace: string | null = null;
let openSettings: () => void = () => {};

/** requestId → live message being streamed. */
const live = new Map<string, { convo: Conversation; msg: UiMessage; rerender: () => void }>();
let busyRequest: string | null = null;

export function initAssistant(container: HTMLElement, settings: () => void) {
  panel = container;
  openSettings = settings;
  api.onAiEvent(handleEvent);
  on('opened', () => {
    forgetConvo(docConvo);
    docConvo = { id: uid(), messages: [] };
    if (!panel.hidden) render();
  });
  on('state', () => {
    if (!panel.hidden && tab === 'doc') updateStaleNote();
  });
}

export async function refreshAssistant() {
  hasKey = (await api.aiStatus()).hasKey;
  spaces = (await api.getState()).spaces;
  if (!panel.hidden) render();
}

export function toggleAssistant(force?: boolean, which?: 'doc' | 'spaces') {
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (which) tab = which;
  document.body.classList.toggle('assistant-open', open);
  document.dispatchEvent(new Event('assistant:toggle'));
  if (open) void refreshAssistant();
}

export const assistantOpen = () => !panel.hidden;

function forgetConvo(c: Conversation) {
  if (c.messages.length) api.aiForget(c.id);
}

// ---------------------------------------------------------------- streaming

function handleEvent(e: AiEvent) {
  const entry = live.get(e.requestId);
  if (!entry) return;
  const { msg } = entry;
  if (e.type === 'delta') msg.text += e.text;
  else if (e.type === 'thinking') msg.text = msg.text || '';
  else if (e.type === 'done') {
    msg.blocks = e.blocks;
    msg.text = e.blocks.map((b) => b.text).join('');
    if (e.stopReason === 'max_tokens') msg.error = 'The answer was cut off because it reached the length limit.';
  } else if (e.type === 'error') {
    msg.error = e.message;
  }
  if (e.type === 'done' || e.type === 'error') {
    live.delete(e.requestId);
    if (busyRequest === e.requestId) busyRequest = null;
  }
  entry.rerender();
}

function currentDocSource(): AiDoc[] | null {
  if (!doc.bytes || !doc.file) return null;
  return [{ kind: 'pdf', title: doc.file.name, data: doc.bytes }];
}

async function send(
  convo: Conversation,
  text: string,
  source: { docs?: AiDoc[]; spaceId?: string },
  rerender: () => void,
  display?: string,
) {
  if (!text.trim() || busyRequest) return;
  if (!hasKey) return openSettings();
  const first = convo.messages.length === 0;
  if (first && source.docs) convo.generation = doc.generation;
  const user: UiMessage = { role: 'user', text: display ?? text };
  const reply: UiMessage = { role: 'assistant', text: '' };
  convo.messages.push(user, reply);
  rerender();
  try {
    const requestId = await api.aiChat({
      conversationId: convo.id,
      text,
      ...(first ? source : {}),
    });
    busyRequest = requestId;
    live.set(requestId, { convo, msg: reply, rerender });
    rerender();
  } catch (err) {
    reply.error = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
    rerender();
  }
}

// ---------------------------------------------------------------- rendering

function render() {
  const keyBanner = !hasKey
    ? h(
        'div',
        { class: 'key-banner' },
        icon('key', 18),
        h('div', {}, h('strong', {}, 'Connect Claude'), h('p', {}, 'Add your Anthropic API key to chat with documents. Your key is encrypted on this computer.')),
        button({ label: 'Add key', kind: 'primary', onClick: openSettings }),
      )
    : '';
  panel.replaceChildren(
    h(
      'div',
      { class: 'assistant-head' },
      h('div', { class: 'assistant-title' }, h('span', { class: 'ai-orb' }, icon('ai', 16)), 'AI Assistant'),
      h(
        'div',
        { class: 'tabs small', role: 'tablist' },
        ...(['doc', 'spaces'] as const).map((t) =>
          h('button', {
            type: 'button',
            class: `tab${tab === t ? ' active' : ''}`,
            on: { click: () => ((tab = t), render()) },
          }, t === 'doc' ? 'Document' : 'Spaces'),
        ),
      ),
      button({ icon: 'close', title: 'Close assistant', onClick: () => toggleAssistant(false) }),
    ),
    keyBanner,
    tab === 'doc' ? renderDocTab() : renderSpacesTab(),
  );
}

function updateStaleNote() {
  const note = panel.querySelector<HTMLElement>('.stale-note');
  if (note) note.hidden = !(docConvo.messages.length && docConvo.generation !== undefined && docConvo.generation !== doc.generation);
}

function renderDocTab(): HTMLElement {
  if (!doc.pdf) {
    return h('div', { class: 'assistant-empty' }, h('div', { class: 'hero-icon' }, icon('chat', 26)), h('h3', {}, 'Chat with your PDFs'), h('p', { class: 'muted' }, 'Open a document to ask questions, get summaries and extract key terms, with answers linked to the exact page.'), button({ label: 'Try a Space instead', kind: 'soft', icon: 'spaces', onClick: () => ((tab = 'spaces'), render()) }));
  }
  const view = chatView(docConvo, { docs: currentDocSource() ?? undefined }, () => {
    forgetConvo(docConvo);
    docConvo = { id: uid(), messages: [] };
    render();
  });
  const stale = h('div', { class: 'stale-note', hidden: true }, icon('undo', 14), 'The document changed since this chat started. Start a new chat to include your edits.');
  setTimeout(updateStaleNote);
  return h('div', { class: 'assistant-body' }, stale, view);
}

function chatView(convo: Conversation, source: { docs?: AiDoc[]; spaceId?: string }, reset: () => void): HTMLElement {
  const log = h('div', { class: 'chat-log', attrs: { 'aria-live': 'polite' } });
  const input = h('textarea', { class: 'chat-input', rows: 1, placeholder: source.spaceId ? 'Ask across this Space…' : 'Ask anything about this document…' });
  const sendBtn = button({ icon: 'send', title: 'Send (Enter)', kind: 'primary', class: 'send' });
  const actions = h(
    'div',
    { class: 'chips actions' },
    ...ACTIONS.map((a) =>
      h('button', { type: 'button', class: 'chip action', on: { click: () => submit(a.prompt, a.label) } }, icon(a.icon, 14), a.label),
    ),
    h('button', { type: 'button', class: 'chip action special', on: { click: () => void remixSlides(source) } }, icon('slides', 14), 'Remix into slides'),
  );

  const rerender = () => {
    log.replaceChildren(...convo.messages.map(renderMessage));
    if (!convo.messages.length) {
      log.append(
        h(
          'div',
          { class: 'chat-welcome' },
          h('div', { class: 'ai-orb big' }, icon('ai', 22)),
          h('p', {}, source.spaceId ? 'Ask a question and Claude will answer from every source in this Space, with citations.' : 'Ask a question, or pick an action. Answers cite the pages they come from.'),
        ),
      );
    }
    const running = !!busyRequest;
    sendBtn.replaceChildren(icon(running ? 'stop' : 'send', 16));
    sendBtn.title = running ? 'Stop' : 'Send (Enter)';
    actions.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = running));
    log.scrollTop = log.scrollHeight;
  };
  const submit = (text: string, display?: string) => {
    void send(convo, text, source, rerender, display);
    input.value = '';
    autosize();
  };
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busyRequest) submit(input.value);
    }
  });
  sendBtn.addEventListener('click', () => {
    if (busyRequest) api.aiCancel(busyRequest);
    else submit(input.value);
  });
  rerender();

  return h(
    'div',
    { class: 'chat' },
    log,
    h(
      'div',
      { class: 'composer' },
      actions,
      h('div', { class: 'composer-box' }, input, sendBtn),
      h(
        'div',
        { class: 'composer-foot' },
        h('span', {}, 'Claude can make mistakes. Check important details against the cited pages.'),
        button({ label: 'New chat', kind: 'ghost', icon: 'plus', onClick: reset }),
      ),
    ),
  );
}

/** Messages already shown once; only new ones play the entrance animation. */
const shown = new WeakSet<UiMessage>();

function renderMessage(m: UiMessage): HTMLElement {
  const enter = !shown.has(m);
  shown.add(m);
  const el = renderMessageBody(m);
  if (enter) el.classList.add('enter');
  return el;
}

function renderMessageBody(m: UiMessage): HTMLElement {
  if (m.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, m.text));
  const body = h('div', { class: 'md' });
  const sources: { n: number; page?: number; doc: string | null; text: string }[] = [];
  if (m.blocks) {
    // Insert numbered citation markers after each cited span, then render Markdown.
    let text = '';
    for (const b of m.blocks) {
      text += b.text;
      for (const c of b.citations) {
        let n = sources.findIndex((s) => s.text === c.citedText && s.page === c.startPage) + 1;
        if (!n) {
          sources.push({ n: sources.length + 1, page: c.startPage, doc: c.documentTitle, text: c.citedText });
          n = sources.length;
        }
        text += `⁣${n}⁣`;
      }
    }
    body.innerHTML = markdown(text).replace(/⁣(\d+)⁣/g, (_m, n) => `<button type="button" class="cite" data-cite="${n}">${n}</button>`);
  } else if (m.text) {
    body.innerHTML = markdown(m.text);
  }
  const pending = !m.blocks && !m.error;
  const wrap = h(
    'div',
    { class: `msg assistant${pending ? ' pending' : ''}` },
    h('div', { class: 'ai-orb' }, icon('ai', 14)),
    h(
      'div',
      { class: 'msg-body' },
      pending && !m.text ? h('div', { class: 'typing' }, h('span'), h('span'), h('span'), h('em', {}, 'Reading and thinking…')) : body,
      m.error ? h('div', { class: 'msg-error' }, m.error) : null,
      sources.length
        ? h(
            'div',
            { class: 'sources' },
            ...sources.map((s) =>
              h(
                'button',
                { type: 'button', class: 'source', dataset: { cite: String(s.n) }, title: s.text },
                h('span', { class: 'cite' }, String(s.n)),
                h('span', { class: 'source-loc' }, [s.doc && sources.some((x) => x.doc !== s.doc) ? s.doc : null, s.page ? `p.${s.page}` : null].filter(Boolean).join(' · ') || 'Source'),
                h('span', { class: 'source-text' }, `“${s.text.trim().slice(0, 90)}${s.text.length > 90 ? '…' : ''}”`),
              ),
            ),
          )
        : null,
    ),
  );
  wrap.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-cite]');
    if (!t) return;
    const s = sources[Number(t.dataset.cite) - 1];
    if (!s) return;
    if (s.page && doc.pdf && (!s.doc || s.doc === doc.file?.name)) {
      setCurrent(s.page - 1);
      scrollToPage(s.page - 1);
      const phrase = s.text.trim().split(/\s+/).slice(0, 8).join(' ');
      if (phrase) setTimeout(() => searchFor(phrase), 350);
    } else {
      toast(`“${s.text.trim().slice(0, 200)}”${s.doc ? ` · ${s.doc}` : ''}`, 'info', 6000);
    }
  });
  return wrap;
}

// ---------------------------------------------------------------- slides

async function remixSlides(source: { docs?: AiDoc[]; spaceId?: string }) {
  if (!hasKey) return openSettings();
  const focus = await promptModal('Remix into a presentation', 'What should the deck focus on? (optional)', '', 'Create slides');
  if (focus === null) return;
  const body = h('div', { class: 'slides-preview' }, h('div', { class: 'typing' }, h('span'), h('span'), h('span'), h('em', {}, 'Claude is designing your deck…')));
  let outline: SlideOutline | null = null;
  const m = openModal({
    title: 'Presentation',
    icon: 'slides',
    wide: true,
    body,
    actions: [
      { label: 'Close' },
      {
        label: 'Save as PowerPoint',
        kind: 'primary',
        onClick: async () => {
          if (!outline) return false;
          const path = await api.saveSlides(outline);
          if (path) toast('Presentation saved', 'success');
          return !!path;
        },
      },
    ],
  });
  try {
    const deck = await api.aiSlides({ ...source, focus });
    outline = deck;
    body.replaceChildren(
      h('div', { class: 'slide title-slide' }, h('h3', {}, deck.title), h('p', {}, deck.subtitle)),
      ...deck.slides.map((s, i) =>
        h('div', { class: 'slide' }, h('span', { class: 'slide-num' }, String(i + 2)), h('h4', {}, s.title), h('ul', {}, ...s.bullets.map((b) => h('li', {}, b)))),
      ),
    );
  } catch (err) {
    body.replaceChildren(h('div', { class: 'msg-error' }, err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)));
  }
  await m.result;
}

// ---------------------------------------------------------------- spaces

function renderSpacesTab(): HTMLElement {
  const space = spaces.find((s) => s.id === activeSpace);
  if (space) return renderSpace(space);
  const list = h('div', { class: 'space-list' });
  for (const s of spaces) {
    list.append(
      h(
        'button',
        { type: 'button', class: 'space-card', on: { click: () => ((activeSpace = s.id), render()) } },
        h('span', { class: 'space-icon' }, icon('spaces', 18)),
        h('span', { class: 'space-main' }, h('strong', {}, s.name), h('small', {}, `${s.sources.length} source${s.sources.length === 1 ? '' : 's'} · ${timeAgo(s.createdAt)}`)),
        icon('right', 16),
      ),
    );
  }
  return h(
    'div',
    { class: 'assistant-body spaces' },
    h(
      'div',
      { class: 'spaces-intro' },
      h('h3', {}, 'PDF Spaces'),
      h('p', { class: 'muted' }, 'Collect PDFs, Word documents and web pages into a Space, then ask questions across all of them at once.'),
      button({
        label: 'New Space',
        icon: 'plus',
        kind: 'primary',
        onClick: async () => {
          const name = await promptModal('New Space', 'Name', 'Contract law revision', 'Create');
          if (!name?.trim()) return;
          const s: Space = { id: uid(), name: name.trim(), instructions: '', sources: [], createdAt: Date.now() };
          spaces = (await api.setState('spaces', [s, ...spaces])).spaces;
          activeSpace = s.id;
          render();
        },
      }),
    ),
    list,
  );
}

/** Spaces whose source list the user has open. */
const openSources = new Set<string>();
const sourceIcon = (k: string): IconName => (k === 'pdf' ? 'file' : k === 'url' ? 'globe' : 'list');

function renderSpace(space: Space): HTMLElement {
  const convo = spaceConvos.get(space.id) ?? { id: uid(), messages: [] };
  spaceConvos.set(space.id, convo);
  const resetConvo = () => {
    forgetConvo(convo);
    spaceConvos.delete(space.id);
  };
  const updateSpaces = (state: { spaces: Space[] }) => {
    spaces = state.spaces;
    resetConvo(); // sources changed: the next question starts fresh with all of them
    render();
  };
  const guard = async (fn: () => Promise<{ spaces: Space[] }>) => {
    openSources.add(space.id); // keep the list open so the change is visible
    try {
      updateSpaces(await fn());
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
      updateSpaces(await api.getState());
    }
  };

  const sources = h('div', { class: 'list compact' });
  for (const src of space.sources) {
    sources.append(
      h(
        'div',
        { class: 'list-row' },
        h('span', { class: 'list-icon' }, icon(sourceIcon(src.kind), 15)),
        h('span', { class: 'list-main' }, h('strong', { title: src.url ?? src.title }, src.title), h('small', {}, src.url ? new URL(src.url).hostname : src.kind === 'pdf' ? `PDF · ${formatBytes(src.size)}` : `${Math.round(src.size / 1000)}k characters`)),
        button({ icon: 'close', title: 'Remove source', onClick: () => guard(() => api.spaceRemoveSource(space.id, src.id)) }),
      ),
    );
  }
  const urlInput = h('input', { class: 'input', type: 'url', placeholder: 'Paste a link to a web page or PDF' });
  const addUrl = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    urlInput.disabled = true;
    await guard(() => api.spaceAddUrl(space.id, url));
  };
  urlInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') void addUrl();
  });
  const instructions = h('textarea', { class: 'input', rows: 2, value: space.instructions, placeholder: 'Optional: how the assistant should behave in this Space (e.g. “Answer as a revision tutor, cite case names”)' });
  instructions.addEventListener('change', async () => {
    const next = spaces.map((s) => (s.id === space.id ? { ...s, instructions: instructions.value } : s));
    spaces = (await api.setState('spaces', next)).spaces;
    resetConvo();
  });
  instructions.addEventListener('keydown', (e) => e.stopPropagation());

  return h(
    'div',
    { class: 'assistant-body space' },
    h(
      'div',
      { class: 'space-head' },
      button({ icon: 'left', title: 'All Spaces', onClick: () => ((activeSpace = null), render()) }),
      h('strong', {}, space.name),
      button({
        icon: 'trash',
        title: 'Delete Space',
        onClick: async () => {
          if (!(await confirmModal(`Delete “${space.name}”?`, 'Its copies of your sources are removed from this app. Your original files are not touched.', 'Delete', true))) return;
          resetConvo();
          activeSpace = null;
          await guard(() => api.spaceDelete(space.id));
        },
      }),
    ),
    h(
      'details',
      {
        class: 'space-sources',
        open: !space.sources.length || openSources.has(space.id),
        on: { toggle: (e) => ((e.target as HTMLDetailsElement).open ? openSources.add(space.id) : openSources.delete(space.id)) },
      },
      h('summary', {}, icon('layers', 14), `Sources (${space.sources.length})`),
      sources,
      h(
        'div',
        { class: 'row wrap' },
        button({ icon: 'plus', label: 'Add files', kind: 'soft', onClick: () => guard(() => api.spaceAddFiles(space.id)) }),
        doc.file?.path ? button({ icon: 'file', label: 'Add open PDF', kind: 'soft', onClick: () => guard(() => api.spaceAddPath(space.id, doc.file!.path!)) }) : null,
      ),
      h('div', { class: 'row' }, urlInput, button({ icon: 'globe', title: 'Add link', kind: 'soft', onClick: addUrl })),
      instructions,
      h('p', { class: 'fine' }, 'Spaces are stored privately on this computer. Sources are sent to Claude only when you ask a question.'),
    ),
    space.sources.length
      ? chatView(convo, { spaceId: space.id }, () => {
          resetConvo();
          render();
        })
      : h('div', { class: 'assistant-empty small' }, h('p', { class: 'muted' }, 'Add a PDF, Word document or link to start chatting.')),
  );
}
