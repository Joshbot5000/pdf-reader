import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, AudioLines, GraduationCap, Hash, Scale, Check, CircleAlert, FolderPlus, Folder, Home as HomeIcon, ListChecks, Mic, Moon, Search, Settings as Cog, Sparkles, Star, Sun, Upload, X } from 'lucide-react';
import { api } from './api';
import { boot, get, go, run, saveSettings, set, toast, useStore, type View } from './store';
import { bookmark, startRecording, stopRecording } from './recorder';
import { fmtTime } from '../../shared/text';
import type { SearchHit, TemplateId } from '../../shared/types';
import { Home } from './views/Home';
import { Recorder } from './views/Recorder';
import { MeetingView } from './views/MeetingView';
import { Ask } from './views/Ask';
import { Tasks } from './views/Tasks';
import { CasesView, ReviseView } from './views/Revise';
import { Settings } from './views/Settings';
import { Onboarding } from './views/Onboarding';
import { dayLabel } from './ui/bits';

export const currentTemplate = (): TemplateId => (localStorage.getItem('hark.template') as TemplateId) || 'meeting';

export const importFiles = async (paths?: string[]): Promise<void> => {
  const ms = await run(api.importFiles(paths));
  if (ms?.length) {
    toast(ms.length === 1 ? `Transcribing “${ms[0].title}”` : `Transcribing ${ms.length} files`, 'ok');
    go(ms.length === 1 ? { name: 'meeting', id: ms[0].id } : { name: 'home' });
  }
};

function useTheme(): void {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => (document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  const scale = useStore((s) => s.settings.readScale);
  useEffect(() => void document.documentElement.style.setProperty('--read-scale', String(scale || 1)), [scale]);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const onboarded = useStore((s) => s.settings.onboarded);
  const view = useStore((s) => s.view);
  const platform = useStore((s) => s.platform);
  const palette = useStore((s) => s.palette);
  const [keys, setKeys] = useState(false);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [dragging, setDragging] = useState(false);
  useTheme();

  useEffect(() => {
    void boot();
    const off = window.hark.on('command', (c) => {
      if (!get().settings.onboarded) return;
      if (c === 'record') void startRecording(currentTemplate());
      if (c === 'stop-record') void stopRecording();
      if (c === 'bookmark') bookmark();
      if (c === 'import') void importFiles();
      if (c === 'palette') set({ palette: true });
      if (c === 'ask') go({ name: 'ask' });
      if (c === 'settings') set({ settingsOpen: 'general' });
    });
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      if (e.key === 'Escape') {
        // Marked as handled so views do not also treat this Escape as "go back".
        if (get().palette) (set({ palette: false }), e.preventDefault());
        else if (get().settingsOpen) (set({ settingsOpen: false }), e.preventDefault());
        else if (document.querySelector('.shortcuts')) (setKeys(false), e.preventDefault());
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?') setKeys((k) => !k);
    };
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => hasFiles(e) && (depth++, setDragging(true));
    const leave = (e: DragEvent) => hasFiles(e) && --depth <= 0 && (depth = 0, setDragging(false));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const paths = Array.from(e.dataTransfer!.files).map((f) => window.hark.pathFor(f)).filter(Boolean);
      const docs = paths.filter((p) => /\.(pdf|pptx|docx|txt|md)$/i.test(p));
      const media = paths.filter((p) => !docs.includes(p));
      if (docs.length) {
        const v = get().view;
        if (v.name !== 'meeting') toast('Open a lecture first, then drop its slides or handout on it.', 'info');
        else
          void api.addMaterials(v.id, docs).then((r) => {
            window.dispatchEvent(new CustomEvent('hark-materials', { detail: v.id }));
            window.dispatchEvent(new CustomEvent('hark-tab', { detail: 'study' }));
            if (r.errors.length) toast(r.errors.join(' '), 'error');
            else toast(`Attached ${docs.length === 1 ? 'the file' : `${docs.length} files`} to this lecture. Notes and the tutor will use ${docs.length === 1 ? 'it' : 'them'}.`, 'ok');
          });
      }
      if (media.length && get().settings.onboarded) void importFiles(media);
    };
    window.addEventListener('keydown', key);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      off();
      window.removeEventListener('keydown', key);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!ready) return <div className="splash"><div className="aurora" /></div>;
  return (
    <div className={`app os-${platform}`}>
      <div className="aurora" />
      <div className="grain" />
      {!onboarded ? (
        <Onboarding />
      ) : (
        <>
          <Sidebar />
          <main className="main" key={view.name === 'meeting' ? `m-${view.id}` : view.name}>
            {view.name === 'home' && <Home />}
            {view.name === 'record' && <Recorder />}
            {view.name === 'meeting' && <MeetingView id={view.id} at={view.t} tab={view.tab} />}
            {view.name === 'ask' && <Ask />}
            {view.name === 'tasks' && <Tasks />}
            {view.name === 'revise' && <ReviseView />}
            {view.name === 'cases' && <CasesView />}
          </main>
          {palette && <Palette />}
          {keys && <Shortcuts close={() => setKeys(false)} />}
          {settingsOpen && <Settings />}
        </>
      )}
      {dragging && onboarded && (
        <div className="drop-veil">
          <div className="drop-card"><Upload size={30} /><b>Drop to add</b><span>Audio or video to transcribe, or slides and handouts (PDF, PowerPoint, Word) to attach to the open lecture.</span></div>
        </div>
      )}
      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <CircleAlert size={15} /> : t.kind === 'ok' ? <Check size={15} /> : <Sparkles size={15} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

function EngineStatus() {
  const status = useStore((s) => s.status);
  const downloads = useStore((s) => s.downloads);
  const dl = Object.values(downloads).filter((d) => !d.error);
  let label = status.cloud ? 'Notes by Groq' : 'On-device AI ready', tone = 'ok', sub = status.cloud ? 'Transcripts stay on this Mac' : status.gpu === 'metal' ? 'Running on Apple GPU' : 'Private, offline';
  if (dl.length) {
    const got = dl.reduce((n, d) => n + d.received, 0), total = dl.reduce((n, d) => n + d.total, 0);
    label = `Downloading AI ${Math.round((got / Math.max(1, total)) * 100)}%`;
    sub = 'One-time setup';
    tone = 'busy';
  } else if (status.asr === 'missing') [label, tone, sub] = ['Speech model needed', 'warn', 'Open settings to download'];
  else if (status.asr === 'error') [label, tone, sub] = ['Speech engine problem', 'warn', status.asrError ?? ''];
  else if (status.asr === 'loading') [label, tone, sub] = ['Waking speech engine…', 'busy', 'A few seconds'];
  else if (status.llm === 'loading') [label, tone, sub] = ['Loading AI model…', 'busy', 'A few seconds'];
  else if (status.llm === 'missing') [label, tone, sub] = ['Transcription ready', 'ok', 'Add an AI model for summaries'];
  else if (status.llm === 'error') [label, tone, sub] = ['AI model problem', 'warn', status.llmError ?? ''];
  return (
    <button className={`engine ${tone}`} onClick={() => set({ settingsOpen: 'models' })} title={sub}>
      <span className="engine-dot" />
      <span className="engine-text"><b>{label}</b><i>{sub}</i></span>
    </button>
  );
}

function Sidebar() {
  const view = useStore((s) => s.view);
  const meetings = useStore((s) => s.meetings);
  const rec = useStore((s) => s.rec);
  const folders = useStore((s) => s.settings.folders);
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of meetings) for (const t of m.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => a[0].localeCompare(b[0]));
  }, [meetings]);
  const archivedCount = meetings.filter((m) => m.archived).length;
  const theme = useStore((s) => s.settings.theme);
  const [adding, setAdding] = useState(false);
  const open = useMemo(() => meetings.reduce((n, m) => n + (m.summary?.actions.filter((a) => !a.done).length ?? 0), 0), [meetings]);
  const is = (v: Partial<View> & { name: string }, extra?: (x: View) => boolean) => view.name === v.name && (!extra || extra(view));
  const addFolder = (name: string) => {
    name = name.trim();
    if (name && !folders.includes(name)) void saveSettings({ folders: [...folders, name] });
    setAdding(false);
  };
  return (
    <aside className="side">
      <div className="side-drag" />
      <div className="brand" onClick={() => go({ name: 'home' })}>
        <span className="brand-mark"><AudioLines size={17} strokeWidth={2.4} /></span>
        <span className="brand-name">Hark</span>
      </div>
      {rec ? (
        <button className="rec-btn live" onClick={() => go({ name: 'record' })}>
          <span className="rec-dot" /> {rec.paused ? 'Paused' : 'Recording'} <span className="mono">{fmtTime(rec.elapsed)}</span>
        </button>
      ) : (
        <button className="rec-btn" onClick={() => void startRecording(currentTemplate())}>
          <Mic size={16} /> Record <kbd>⌘N</kbd>
        </button>
      )}
      <nav className="nav">
        <button className={is({ name: 'home' }, (v) => v.name === 'home' && !v.folder && !v.starred && !v.tag && !v.archived) ? 'on' : ''} onClick={() => go({ name: 'home' })}>
          <HomeIcon size={16} /> Conversations <span className="count">{meetings.filter((m) => !m.archived).length || ''}</span>
        </button>
        <button className={is({ name: 'ask' }) ? 'on' : ''} onClick={() => go({ name: 'ask' })}>
          <Sparkles size={16} /> Ask Hark <kbd>⌘J</kbd>
        </button>
        <button className={is({ name: 'revise' }) ? 'on' : ''} onClick={() => go({ name: 'revise' })}>
          <GraduationCap size={16} /> Revision
        </button>
        <button className={is({ name: 'cases' }) ? 'on' : ''} onClick={() => go({ name: 'cases' })}>
          <Scale size={16} /> Case bank
        </button>
        <button className={is({ name: 'tasks' }) ? 'on' : ''} onClick={() => go({ name: 'tasks' })}>
          <ListChecks size={16} /> Action items <span className="count">{open || ''}</span>
        </button>
        <button className={is({ name: 'home' }, (v) => v.name === 'home' && !!v.starred) ? 'on' : ''} onClick={() => go({ name: 'home', starred: true })}>
          <Star size={16} /> Starred
        </button>
        <button onClick={() => set({ palette: true })}>
          <Search size={16} /> Search <kbd>⌘K</kbd>
        </button>
      </nav>
      <div className="side-label">Folders <button className="icon-btn" title="New folder" onClick={() => setAdding(true)}><FolderPlus size={14} /></button></div>
      <nav className="nav folders">
        {folders.map((f) => (
          <button key={f} className={is({ name: 'home' }, (v) => v.name === 'home' && v.folder === f) ? 'on' : ''} onClick={() => go({ name: 'home', folder: f })}>
            <Folder size={15} /> <span className="grow">{f}</span>
            <span className="count">{meetings.filter((m) => m.folder === f).length || ''}</span>
            <span className="del" title="Remove folder" onClick={(e) => { e.stopPropagation(); void saveSettings({ folders: folders.filter((x) => x !== f) }); }}><X size={12} /></span>
          </button>
        ))}
        {adding && <input autoFocus className="folder-input" placeholder="Folder name" onBlur={(e) => addFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addFolder(e.currentTarget.value); if (e.key === 'Escape') setAdding(false); }} />}
        {!folders.length && !adding && <p className="side-hint">Group conversations by project, client or module.</p>}
        {tags.map(([t, n]) => (
          <button key={t} className={is({ name: 'home' }, (v) => v.name === 'home' && v.tag === t) ? 'on' : ''} onClick={() => go({ name: 'home', tag: t })}>
            <Hash size={14} /> {t} <span className="count">{n}</span>
          </button>
        ))}
        {archivedCount > 0 && (
          <button className={is({ name: 'home' }, (v) => v.name === 'home' && !!v.archived) ? 'on' : ''} onClick={() => go({ name: 'home', archived: true })}>
            <Archive size={14} /> Archived <span className="count">{archivedCount}</span>
          </button>
        )}
      </nav>
      <div className="side-foot">
        <EngineStatus />
        <div className="foot-row">
          <button className="icon-btn" title="Settings" onClick={() => set({ settingsOpen: 'general' })}><Cog size={16} /></button>
          <button className="icon-btn" title="Switch theme" onClick={() => void saveSettings({ theme: (theme === 'system' ? document.documentElement.dataset.theme : theme) === 'dark' ? 'light' : 'dark' })}>
            {document.documentElement.dataset.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

type Item = { key: string; icon: React.ReactNode; title: string; sub?: string; right?: string; act: () => void };

function Palette() {
  const meetings = useStore((s) => s.meetings);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    let live = true;
    const t = setTimeout(() => void api.search(q).then((h) => live && setHits(h)), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const items = useMemo<Item[]>(() => {
    const low = q.trim().toLowerCase();
    const actions: Item[] = [
      { key: 'rec', icon: <Mic size={16} />, title: 'Start recording', right: '⌘N', act: () => void startRecording(currentTemplate()) },
      { key: 'imp', icon: <Upload size={16} />, title: 'Import audio or video…', right: '⌘O', act: () => void importFiles() },
      { key: 'ask', icon: <Sparkles size={16} />, title: q.trim() ? `Ask Hark: “${q.trim()}”` : 'Ask Hark across all conversations', right: '⌘J', act: () => { sessionStorage.setItem('hark.ask', q.trim()); go({ name: 'ask' }); } },
      { key: 'tasks', icon: <ListChecks size={16} />, title: 'Action items', act: () => go({ name: 'tasks' }) },
      { key: 'set', icon: <Cog size={16} />, title: 'Settings', right: '⌘,', act: () => set({ settingsOpen: 'general', palette: false }) },
    ];
    if (!low) return [...actions, ...meetings.slice(0, 6).map((m) => ({ key: m.id, icon: <AudioLines size={16} />, title: m.title, sub: dayLabel(m.createdAt), act: () => go({ name: 'meeting', id: m.id }) }))];
    const out: Item[] = hits.map((h, i) => ({
      key: `h${i}`, icon: h.paraId ? <span className="mono tiny">{fmtTime(h.t)}</span> : <AudioLines size={16} />,
      title: h.paraId ? h.snippet : h.title, sub: h.paraId ? `${h.speaker} · ${h.title} · ${dayLabel(h.date)}` : dayLabel(h.date),
      act: () => go({ name: 'meeting', id: h.meetingId, t: h.paraId ? h.t : undefined }),
    }));
    return [...out, ...actions.filter((a) => a.key === 'ask' || a.title.toLowerCase().includes(low))];
  }, [q, hits, meetings]);
  useEffect(() => {
    setSel(0);
  }, [q, hits]);
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const pick = (it?: Item) => {
    if (!it) return;
    set({ palette: false });
    it.act();
  };
  return (
    <div className="veil" onMouseDown={() => set({ palette: false })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-in">
          <Search size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every word of every conversation…" onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === 'Enter') pick(items[sel]);
          }} />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => (
            <button key={it.key} className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onClick={() => pick(it)}>
              <span className="pi">{it.icon}</span>
              <span className="pt"><b>{highlight(it.title, q)}</b>{it.sub && <i>{it.sub}</i>}</span>
              {it.right && <kbd>{it.right}</kbd>}
            </button>
          ))}
          {q.trim().length >= 2 && !hits.length && <p className="palette-empty">No exact matches. Try <b>Ask Hark</b> to search by meaning.</p>}
        </div>
      </div>
    </div>
  );
}

export function highlight(text: string, q: string): React.ReactNode {
  const terms = q.trim().split(/\s+/).filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return text;
  return text.split(new RegExp(`(${terms.join('|')})`, 'ig')).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

const SHORTCUTS: [string, string][] = [
  ['⌘N', 'Start a recording'],
  ['⌘⇧R', 'Start or stop recording from any app'],
  ['⌘K', 'Search everything'],
  ['⌘J', 'Ask Hark'],
  ['⌘O', 'Import audio or video'],
  ['⌘,', 'Settings'],
  ['J / K', 'Next / previous conversation in the list'],
  ['Enter', 'Open the selected conversation'],
  ['Space', 'Play or pause the recording'],
  ['← / →', 'Back or forward 5 seconds'],
  ['[ / ]', 'Slower / faster playback'],
  ['B', 'Bookmark this moment (while recording)'],
  ['⌘F', 'Find in the transcript'],
  ['Esc', 'Close or go back'],
  ['?', 'Show this list'],
];

function Shortcuts({ close }: { close: () => void }) {
  return (
    <div className="veil" onMouseDown={close}>
      <div className="shortcuts" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <dl>{SHORTCUTS.map(([k, what]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>)}</dl>
        <p className="dim small">On Windows, use Ctrl for ⌘.</p>
      </div>
    </div>
  );
}
