import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BarChart3, CalendarClock, Captions, Check, ChevronLeft, Copy, Download, FileAudio, FileText, Folder, Highlighter, ListChecks, MessageCircle, NotebookPen, Pause, Pencil, Play, RotateCcw, RotateCw, Search, Sparkles, Square, Star, StickyNote, Trash2, UserRound, X } from 'lucide-react';
import { api } from '../api';
import { clearStream, go, loadTranscript, run, set, startStream, toast, useStore } from '../store';
import { Avatar, Md, Popover, Spinner, Waveform, colorOf, dayLabel, clock } from '../ui/bits';
import { TemplatePicker } from './Home';
import { toggleAction } from './Tasks';
import { fmtDuration, fmtTime, toMarkdown, toText } from '../../../shared/text';
import { TEMPLATES, parseSummary } from '../../../shared/summaryFormat';
import type { Meeting, Para, Speaker, Summary, TemplateId } from '../../../shared/types';

type Seek = (t: number, play?: boolean) => void;
type Tab = 'summary' | 'chat' | 'notes' | 'insights';

export function MeetingView({ id, at, tab: initialTab }: { id: string; at?: number; tab?: string }) {
  const m = useStore((s) => s.meetings.find((x) => x.id === id));
  const paras = useStore((s) => s.transcripts[id]);
  const liveSpeakers = useStore((s) => s.liveSpeakers[id]);
  const partial = useStore((s) => s.partial[id]);
  const progress = useStore((s) => s.progress[id]);
  const folders = useStore((s) => s.settings.folders);
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || 'summary');
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [now, setNow] = useState(0);
  const [find, setFind] = useState<string | null>(null);
  const [title, setTitle] = useState(m?.title ?? '');
  const audio = useRef<HTMLAudioElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const lit = useRef<HTMLDivElement>(null);
  const follow = useRef(0);
  const status = m?.status;
  const speakers = useMemo(() => (m ? (m.status === 'ready' ? m.speakers : liveSpeakers ?? m.speakers) : []), [m, liveSpeakers]);

  useEffect(() => void loadTranscript(id, true), [id, status]);
  useEffect(() => {
    setTitle(m?.title ?? '');
  }, [m?.title]);

  const seek = useCallback<Seek>((t, play = true) => {
    const a = audio.current;
    if (a) {
      a.currentTime = Math.max(0, t);
      if (play) void a.play().catch(() => undefined);
    }
    follow.current = 0;
    const el = feed.current?.querySelector<HTMLElement>(`[data-para-at="${paraAt(feed.current, t)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }, []);

  // Arriving from a search hit or a citation: go to that moment.
  const arrived = useRef(false);
  useEffect(() => {
    if (at === undefined || arrived.current || !paras?.length) return;
    arrived.current = true;
    setTimeout(() => seek(at, false), 80);
  }, [at, paras, seek]);

  // Word-by-word highlight and auto-follow while playing.
  useEffect(() => {
    let raf = 0;
    let lastWord: HTMLElement | null = null;
    let lastPara: HTMLElement | null = null;
    let lastLabel = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = audio.current, root = feed.current;
      if (!a || !root) return;
      const t = a.currentTime;
      if (lit.current && m?.duration) lit.current.style.width = `${Math.min(100, (t / m.duration) * 100)}%`;
      if (Math.floor(t * 4) !== lastLabel) {
        lastLabel = Math.floor(t * 4);
        setNow(t);
      }
      const words = wordsOf(root);
      let lo = 0, hi = words.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].s <= t + 0.05) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const w = idx >= 0 && (t <= words[idx].e + 0.8 || !a.paused) ? words[idx].el : null;
      if (w === lastWord) return;
      lastWord?.classList.remove('now');
      w?.classList.add('now');
      lastWord = w;
      const para = w?.closest<HTMLElement>('.turn') ?? null;
      if (para !== lastPara) {
        lastPara?.classList.remove('speaking');
        para?.classList.add('speaking');
        lastPara = para;
        if (para && !a.paused && Date.now() > follow.current) {
          const r = para.getBoundingClientRect(), box = root.getBoundingClientRect();
          if (r.top < box.top + 60 || r.bottom > box.bottom - 120) para.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [m?.duration]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFind((f) => f ?? '');
      } else if (e.key === 'Escape' && find !== null) setFind(null);
      else if (typing) return;
      else if (e.key === ' ' && audio.current) {
        e.preventDefault();
        if (audio.current.paused) void audio.current.play();
        else audio.current.pause();
      } else if (e.key === 'ArrowLeft' && audio.current) audio.current.currentTime -= 5;
      else if (e.key === 'ArrowRight' && audio.current) audio.current.currentTime += 5;
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [find]);

  const spans = useMemo(() => (paras ?? []).map((p) => ({ s: p.s, e: p.e, c: colorOf(speakers.find((x) => x.id === p.sp)) })), [paras, speakers]);
  const colorAt = useCallback((t: number) => spans.find((x) => t >= x.s - 0.4 && t <= x.e + 0.4)?.c ?? '#7b7f95', [spans]);
  const marks = useMemo(() => [...(m?.summary?.chapters ?? []).map((c) => ({ t: c.t, label: c.title })), ...(m?.bookmarks ?? []).map((t) => ({ t, label: 'Bookmark' }))], [m?.summary?.chapters, m?.bookmarks]);
  const matches = useMemo(() => {
    const terms = (find ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    return terms.length ? (paras ?? []).filter((p) => terms.every((t) => p.text.toLowerCase().includes(t))) : [];
  }, [find, paras]);
  const matchIdx = useRef(0);

  if (!m) return <div className="page center"><p className="dim">This conversation no longer exists.</p></div>;
  const busy = m.status === 'processing';
  const canPlay = m.hasAudio && m.status === 'ready';
  const saveTitle = () => title.trim() && title !== m.title && void run(api.updateMeeting(id, { title: title.trim() }));
  const exportAs = (f: 'md' | 'txt' | 'srt' | 'pdf' | 'audio') => void run(api.exportMeeting(id, f)).then((p) => p && toast('Saved', 'ok'));
  const copy = (text: string, what: string) => void api.copyText(text).then(() => toast(`${what} copied`, 'ok'));
  const nextRate = () => {
    const r = [1, 1.25, 1.5, 2, 0.75][([1, 1.25, 1.5, 2, 0.75].indexOf(rate) + 1) % 5];
    setRate(r);
    if (audio.current) audio.current.playbackRate = r;
  };

  return (
    <div className="meeting">
      <header className="m-head">
        <button className="icon-btn back" onClick={() => go({ name: 'home' })} title="Back"><ChevronLeft size={18} /></button>
        <div className="m-title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} spellCheck={false} />
          <p className="m-meta">
            <span>{dayLabel(m.createdAt)}, {clock(m.createdAt)}</span>
            {m.duration > 0 && <span>{fmtDuration(m.duration)}</span>}
            {m.words > 0 && <span>{m.words.toLocaleString()} words</span>}
            <span className="faces">{speakers.map((s) => <Avatar key={s.id} sp={s} size={20} />)}</span>
          </p>
        </div>
        <div className="m-actions">
          <button className="icon-btn" title="Find in transcript (⌘F)" onClick={() => setFind((f) => (f === null ? '' : null))}><Search size={16} /></button>
          <button className={`icon-btn ${m.starred ? 'starred' : ''}`} title="Star" onClick={() => void run(api.updateMeeting(id, { starred: !m.starred }))}><Star size={16} fill={m.starred ? 'currentColor' : 'none'} /></button>
          <Popover align="right" trigger={(_o, t) => <button className="icon-btn" title="Move to folder" onClick={t}><Folder size={16} /></button>}>
            {(close) => (
              <div className="menu">
                <p className="menu-label">Folder</p>
                {['', ...folders].map((f) => <button key={f || '-'} onClick={() => { void run(api.updateMeeting(id, { folder: f || undefined })); close(); }}>{(m.folder ?? '') === f ? <Check size={14} /> : <span className="sp14" />}{f || 'No folder'}</button>)}
                {!folders.length && <p className="menu-hint">Create folders from the sidebar.</p>}
              </div>
            )}
          </Popover>
          <Popover align="right" trigger={(_o, t) => <button className="btn small" onClick={t}><Download size={14} /> Export</button>}>
            {(close) => (
              <div className="menu" onClick={close}>
                <button onClick={() => exportAs('md')}><FileText size={14} /> Notes + transcript (Markdown)</button>
                <button onClick={() => exportAs('pdf')}><FileText size={14} /> PDF</button>
                <button onClick={() => exportAs('txt')}><FileText size={14} /> Plain text</button>
                <button onClick={() => exportAs('srt')}><Captions size={14} /> Subtitles (.srt)</button>
                {m.hasAudio && <button onClick={() => exportAs('audio')}><FileAudio size={14} /> Audio</button>}
                <hr />
                <button onClick={() => copy(toMarkdown(m, paras ?? []).split('## Transcript')[0].trim(), 'Notes')}><Copy size={14} /> Copy notes</button>
                <button onClick={() => copy(toText(m, paras ?? []), 'Transcript')}><Copy size={14} /> Copy transcript</button>
                <hr />
                <button className="danger" onClick={() => confirm(`Delete “${m.title}”?`) && void run(api.deleteMeeting(id))}><Trash2 size={14} /> Delete conversation</button>
              </div>
            )}
          </Popover>
        </div>
      </header>

      {find !== null && (
        <div className="findbar">
          <Search size={15} />
          <input autoFocus value={find} placeholder="Find in this conversation" onChange={(e) => { setFind(e.target.value); matchIdx.current = 0; }} onKeyDown={(e) => {
            if (e.key === 'Enter' && matches.length) {
              const p = matches[matchIdx.current % matches.length];
              matchIdx.current++;
              seek(p.s, false);
            }
          }} />
          <span className="dim">{find.trim().length > 1 ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : ''}</span>
          <button className="icon-btn" onClick={() => setFind(null)}><X size={14} /></button>
        </div>
      )}

      <div className="m-body">
        <section className="m-transcript">
          {busy && (
            <div className="banner">
              <Spinner /> <b>Transcribing</b> <span className="dim">{progress ? `${Math.round(progress * 100)}%` : 'starting…'}</span>
              <div className="bar"><span style={{ width: `${(progress ?? 0.01) * 100}%` }} /></div>
            </div>
          )}
          {m.status === 'error' && <div className="banner err"><b>Something went wrong.</b> {m.error} <button className="btn small" onClick={() => void run(api.deleteMeeting(id))}>Delete</button></div>}
          <div className="feed" ref={feed} onWheel={() => (follow.current = Date.now() + 4000)} onClick={(e) => {
            const w = (e.target as HTMLElement).closest<HTMLElement>('.w');
            if (w && !(e.target as HTMLElement).closest('[contenteditable="true"]')) seek(+w.dataset.s!, canPlay);
          }}>
            {!paras ? <div className="center pad"><Spinner size={20} /></div> : !paras.length && m.status === 'ready' ? (
              <div className="empty"><FileAudio size={28} /><h3>No speech was detected</h3><p>The recording was silent or too quiet to transcribe.</p></div>
            ) : (
              paras.map((p) => <Turn key={p.id} p={p} m={m} speakers={speakers} find={find ?? ''} seek={seek} editable={m.status === 'ready'} />)
            )}
            {busy && partial && <div className="turn partial"><span className="pulse" /><p className="turn-text">{partial}</p></div>}
          </div>
          {canPlay && (
            <div className="player">
              <audio ref={audio} src={`hark-media://audio/${id}`} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
              <button className="icon-btn" title="Back 10 s" onClick={() => audio.current && (audio.current.currentTime -= 10)}><RotateCcw size={16} /></button>
              <button className="play" onClick={() => audio.current && (audio.current.paused ? void audio.current.play() : audio.current.pause())}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
              <button className="icon-btn" title="Forward 10 s" onClick={() => audio.current && (audio.current.currentTime += 10)}><RotateCw size={16} /></button>
              <span className="mono time">{fmtTime(now)}</span>
              <Waveform peaks={m.peaks} duration={m.duration} colorAt={colorAt} marks={marks} progressRef={lit} onSeek={(t) => seek(t, true)} />
              <span className="mono time dim">{fmtTime(m.duration)}</span>
              <button className="rate mono" onClick={nextRate} title="Playback speed">{rate}×</button>
            </div>
          )}
        </section>

        <aside className="m-side">
          <div className="tabs">
            <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}><Sparkles size={14} /> Notes</button>
            <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}><MessageCircle size={14} /> Chat</button>
            <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}><NotebookPen size={14} /> Mine</button>
            <button className={tab === 'insights' ? 'on' : ''} onClick={() => setTab('insights')}><BarChart3 size={14} /> Insights</button>
          </div>
          <div className="tab-body">
            {tab === 'summary' && <SummaryTab m={m} seek={seek} hasText={!!paras?.length} />}
            {tab === 'chat' && <ChatTab m={m} seek={seek} />}
            {tab === 'notes' && <NotesTab m={m} />}
            {tab === 'insights' && <InsightsTab m={m} paras={paras ?? []} speakers={speakers} seek={seek} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

const wordCache = new WeakMap<HTMLElement, { n: number; list: { s: number; e: number; el: HTMLElement }[] }>();
function wordsOf(root: HTMLElement) {
  const els = root.getElementsByClassName('w');
  const hit = wordCache.get(root);
  if (hit && hit.n === els.length && hit.list[0]?.el.isConnected && hit.list[hit.list.length - 1]?.el.isConnected) return hit.list;
  const list = Array.from(els as HTMLCollectionOf<HTMLElement>, (el) => ({ s: +el.dataset.s!, e: +el.dataset.e!, el }));
  wordCache.set(root, { n: els.length, list });
  return list;
}
function paraAt(root: HTMLElement | null, t: number): string {
  let best = '';
  root?.querySelectorAll<HTMLElement>('[data-para-at]').forEach((el) => {
    if (+el.dataset.paraAt! <= t + 0.3) best = el.dataset.paraAt!;
  });
  return best || root?.querySelector<HTMLElement>('[data-para-at]')?.dataset.paraAt || '';
}

const Turn = memo(function Turn({ p, m, speakers, find, seek, editable }: { p: Para; m: Meeting; speakers: Speaker[]; find: string; seek: Seek; editable: boolean }) {
  const sp = speakers.find((s) => s.id === p.sp);
  const [editing, setEditing] = useState(false);
  const [noting, setNoting] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const terms = useMemo(() => find.toLowerCase().split(/\s+/).filter((t) => t.length > 1), [find]);
  const apply = (res: Promise<Para[]>) => void run(res).then((paras) => paras && set((s) => ({ transcripts: { ...s.transcripts, [m.id]: paras } })));
  useLayoutEffect(() => {
    if (editing && textRef.current) {
      textRef.current.focus();
      document.getSelection()?.selectAllChildren(textRef.current);
      document.getSelection()?.collapseToEnd();
    }
  }, [editing]);
  const saveEdit = () => {
    const text = textRef.current?.innerText.replace(/\s+/g, ' ').trim() ?? p.text;
    setEditing(false);
    if (text !== p.text) apply(api.updatePara(m.id, p.id, { text }));
  };
  return (
    <div className={`turn ${p.hl ? 'hl' : ''}`} data-para-at={p.s}>
      <Avatar sp={sp} size={30} />
      <div className="turn-main">
        <p className="turn-head">
          <Popover trigger={(_o, t) => <b className="who" style={{ color: colorOf(sp) }} onClick={editable ? t : undefined}>{sp?.name ?? 'Speaker'}</b>} className="speaker-pop">
            {(close) => <SpeakerMenu m={m} p={p} sp={sp} speakers={speakers} close={close} apply={apply} />}
          </Popover>
          <button className="stamp mono" onClick={() => seek(p.s, m.hasAudio)}>{fmtTime(p.s)}</button>
          {editable && (
            <span className="turn-tools">
              <button title="Highlight" className={p.hl ? 'on' : ''} onClick={() => apply(api.updatePara(m.id, p.id, { hl: !p.hl }))}><Highlighter size={13} /></button>
              <button title="Add a note" className={p.note ? 'on' : ''} onClick={() => setNoting(true)}><StickyNote size={13} /></button>
              <button title="Edit text" onClick={() => setEditing(true)}><Pencil size={13} /></button>
              <button title="Copy" onClick={() => void api.copyText(p.text).then(() => toast('Copied', 'ok'))}><Copy size={13} /></button>
            </span>
          )}
        </p>
        {editing ? (
          <p className="turn-text editing" ref={textRef} contentEditable="true" suppressContentEditableWarning onBlur={saveEdit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') setEditing(false); }}>{p.text}</p>
        ) : (
          <p className="turn-text">
            {p.words.map((w, i) => (
              <span key={i} className={`w ${terms.length && terms.some((t) => w.t.toLowerCase().includes(t)) ? 'hit' : ''}`} data-s={w.s} data-e={w.e}>{w.t} </span>
            ))}
          </p>
        )}
        {(p.note || noting) && (
          noting ? <textarea className="note-in" autoFocus defaultValue={p.note} placeholder="Your note on this moment…" onBlur={(e) => { setNoting(false); if (e.target.value.trim() !== (p.note ?? '')) apply(api.updatePara(m.id, p.id, { note: e.target.value })); }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) e.currentTarget.blur(); }} />
            : <p className="note" onClick={() => editable && setNoting(true)}><StickyNote size={12} /> {p.note}</p>
        )}
      </div>
    </div>
  );
});

function SpeakerMenu({ m, p, sp, speakers, close, apply }: { m: Meeting; p: Para; sp?: Speaker; speakers: Speaker[]; close: () => void; apply: (r: Promise<Para[]>) => void }) {
  const remember = useStore((s) => s.settings.rememberVoices);
  const [name, setName] = useState(sp && !/^Speaker \d+$/.test(sp.name) ? sp.name : '');
  const others = speakers.filter((s) => s.id !== p.sp);
  const rename = () => {
    if (!sp || !name.trim()) return;
    void run(api.renameSpeaker(m.id, sp.id, name)).then(() => toast(remember ? `Got it. I'll recognise ${name.trim()}'s voice from now on.` : 'Renamed', 'ok'));
    close();
  };
  return (
    <div className="menu">
      <p className="menu-label">Who is this?</p>
      <div className="rename">
        <input autoFocus value={name} placeholder="Type a name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename()} />
        <button className="btn small primary" disabled={!name.trim()} onClick={rename}>Save</button>
      </div>
      {remember && <p className="menu-hint">Hark remembers this voice and names it automatically next time.</p>}
      {!!others.length && (
        <>
          <hr />
          <p className="menu-label">Just this paragraph is…</p>
          {others.map((o) => <button key={o.id} onClick={() => { apply(api.updatePara(m.id, p.id, { sp: o.id })); close(); }}><Avatar sp={o} size={18} /> {o.name}</button>)}
          <hr />
          <p className="menu-label">Same person as…</p>
          {others.map((o) => <button key={o.id} onClick={() => { void run(api.mergeSpeakers(m.id, p.sp, o.id)).then((r) => r && set((s) => ({ transcripts: { ...s.transcripts, [m.id]: r.paras } }))); close(); }}><UserRound size={14} /> Merge into {o.name}</button>)}
        </>
      )}
    </div>
  );
}

function SummaryTab({ m, seek, hasText }: { m: Meeting; seek: Seek; hasText: boolean }) {
  const sid = `sum:${m.id}`;
  const stream = useStore((s) => s.streams[sid]);
  const llm = useStore((s) => s.status.llm);
  const [tpl, setTpl] = useState<TemplateId>(m.template);
  const [flipped, setFlipped] = useState<Record<number, boolean>>({});
  const running = m.summaryState === 'running';
  const live = useMemo(() => (running && stream?.text ? parseSummary(stream.text, m.template, m.summary) : null), [running, stream?.text, m.template, m.summary]);
  const s: Summary | null | undefined = live ?? (running ? null : m.summary);
  const generate = (t: TemplateId) => {
    startStream(sid);
    void api.summarize(m.id, sid, t).catch((e) => toast(String(e.message ?? e), 'error')).finally(() => clearStream(sid));
  };
  if (llm === 'missing' && !m.summary)
    return (
      <div className="side-empty">
        <Sparkles size={24} /><h3>Add an AI model for notes</h3>
        <p>The transcript is ready. To get summaries, action items and chat, download an AI model once. It runs on this computer.</p>
        <button className="btn primary" onClick={() => set({ settingsOpen: 'models' })}>Choose a model</button>
      </div>
    );
  if (!s && !running)
    return (
      <div className="side-empty">
        <Sparkles size={24} /><h3>{m.status === 'processing' ? 'Notes arrive when transcription finishes' : 'Turn this into notes'}</h3>
        {m.summaryState === 'error' && <p className="err-text">{m.summaryError}</p>}
        {m.status === 'ready' && hasText && (<><TemplatePicker value={tpl} onChange={setTpl} /><button className="btn primary" onClick={() => generate(tpl)}><Sparkles size={15} /> Write notes</button></>)}
      </div>
    );
  const hints = Object.entries(m.nameHints ?? {}).filter(([id]) => m.speakers.some((x) => x.id === id && !x.named));
  return (
    <div className="summary">
      {running && (
        <div className="writing">
          <span className="shimmer"><Sparkles size={14} /> {stream?.stage ?? (stream?.text ? 'Writing notes…' : 'Reading the conversation…')}</span>
          <button className="btn ghost small" onClick={() => void api.abort(sid)}><Square size={11} fill="currentColor" /> Stop</button>
        </div>
      )}
      {!running && hints.map(([spId, name]) => {
        const sp = m.speakers.find((x) => x.id === spId)!;
        return (
          <div className="hint" key={spId}>
            <Avatar sp={sp} size={24} />
            <span>{sp.name} sounds like <b>{name}</b></span>
            <button className="btn small primary" onClick={() => void run(api.renameSpeaker(m.id, spId, name)).then(() => toast(`Named ${name}. Hark will recognise this voice next time.`, 'ok'))}>Use name</button>
            <button className="icon-btn" onClick={() => void run(api.dismissHint(m.id, spId))}><X size={13} /></button>
          </div>
        );
      })}
      {s?.overview && <p className="overview">{s.overview}</p>}
      {!!s?.topics.length && <p className="topics">{s.topics.map((t) => <span key={t}>{t}</span>)}</p>}
      {!!s?.actions.length && (
        <section>
          <h5><ListChecks size={13} /> Action items</h5>
          {s.actions.map((a) => (
            <div key={a.id} className={`task ${a.done ? 'done' : ''}`}>
              <button className="check" disabled={running} onClick={() => toggleAction(m, a)}>{a.done && <Check size={13} strokeWidth={3} />}</button>
              <span className="task-text">{a.text}</span>
              {a.owner && <span className="chip">{a.owner}</span>}
              {a.due && <span className="chip due"><CalendarClock size={11} /> {a.due}</span>}
            </div>
          ))}
        </section>
      )}
      {!!s?.keyPoints.length && <section><h5>Key points</h5><ul>{s.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul></section>}
      {!!s?.decisions.length && <section><h5>Decisions</h5><ul className="decisions">{s.decisions.map((k, i) => <li key={i}>{k}</li>)}</ul></section>}
      {!!s?.questions.length && <section><h5>Open questions</h5><ul className="questions">{s.questions.map((k, i) => <li key={i}>{k}</li>)}</ul></section>}
      {!!s?.chapters.length && (
        <section>
          <h5>Chapters</h5>
          <div className="chapters">
            {s.chapters.map((c, i) => (
              <button key={i} onClick={() => seek(c.t, m.hasAudio)}>
                <span className="mono">{fmtTime(c.t)}</span>
                <span><b>{c.title}</b>{c.note && <i>{c.note}</i>}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {!!s?.cards.length && (
        <section>
          <h5>Flashcards <span className="dim">tap to flip</span></h5>
          <div className="flashcards">
            {s.cards.map((c, i) => (
              <button key={i} className={`flash-card ${flipped[i] ? 'flipped' : ''}`} onClick={() => setFlipped((f) => ({ ...f, [i]: !f[i] }))}>
                <span className="fc-tag">{flipped[i] ? 'Answer' : `Question ${i + 1}`}</span>
                {flipped[i] ? c.a : c.q}
              </button>
            ))}
          </div>
        </section>
      )}
      {!running && s && (
        <footer className="sum-foot">
          <span className="dim">{TEMPLATES[s.template].name} notes{s.model ? ` · ${s.model} model` : ''} · written on this computer</span>
          <Popover align="right" trigger={(_o, t) => <button className="btn ghost small" onClick={t}><RotateCw size={13} /> Rewrite</button>}>
            {(close) => (
              <div className="menu">
                <p className="menu-label">Rewrite as…</p>
                {(Object.keys(TEMPLATES) as TemplateId[]).map((t) => <button key={t} onClick={() => { close(); generate(t); }}><span className="grow"><b>{TEMPLATES[t].name}</b><i>{TEMPLATES[t].blurb}</i></span></button>)}
              </div>
            )}
          </Popover>
        </footer>
      )}
    </div>
  );
}

function ChatTab({ m, seek }: { m: Meeting; seek: Seek }) {
  const sid = `chat:${m.id}`;
  const stream = useStore((s) => s.streams[sid]);
  const llm = useStore((s) => s.status.llm);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [m.chat.length, stream?.text, pending]);
  const send = async (text: string) => {
    text = text.trim();
    if (!text || pending) return;
    if (llm === 'missing') return void set({ settingsOpen: 'models' });
    setQ('');
    setPending(text);
    startStream(sid);
    try {
      await api.chat(m.id, text, sid);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPending(null);
      clearStream(sid);
    }
  };
  const ideas = m.template === 'lecture' ? ['Explain the hardest idea simply', 'Quiz me on this', 'What should I revise first?', 'List every case or example mentioned'] : ['What did I miss?', 'Draft a follow-up email', 'What was left unresolved?', 'Summarise in three bullets'];
  return (
    <div className="chat">
      <div className="chat-scroll">
        {!m.chat.length && !pending && (
          <div className="side-empty">
            <MessageCircle size={24} /><h3>Ask about this conversation</h3>
            <p>Answers come from the transcript, with timestamps you can click.</p>
            <div className="ideas">{ideas.map((i) => <button key={i} onClick={() => void send(i)}>{i}</button>)}</div>
          </div>
        )}
        {m.chat.map((c) => <div key={c.id} className={`msg ${c.role}`}>{c.role === 'assistant' ? <Md text={c.text} onTime={(t) => seek(t, m.hasAudio)} /> : c.text}</div>)}
        {pending && (<><div className="msg user">{pending}</div><div className="msg assistant">{stream?.text ? <Md text={stream.text} onTime={(t) => seek(t, m.hasAudio)} /> : <p className="thinking"><Spinner /> Reading the transcript…</p>}</div></>)}
        <div ref={end} />
      </div>
      {!!m.chat.length && !pending && <button className="clear-chat" onClick={() => void run(api.clearChat(m.id))}>Clear chat</button>}
      <div className="composer">
        <textarea rows={1} value={q} placeholder={llm === 'missing' ? 'Needs an AI model (Settings)' : 'Ask about this conversation…'} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(q); } }} />
        {pending ? <button className="send stop" onClick={() => void api.abort(sid)}><Square size={13} fill="currentColor" /></button> : <button className="send" disabled={!q.trim()} onClick={() => void send(q)}><ArrowUp size={16} /></button>}
      </div>
    </div>
  );
}

function NotesTab({ m }: { m: Meeting }) {
  const [text, setText] = useState(m.notes);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (latest.current !== m.notes) void api.updateMeeting(m.id, { notes: latest.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <textarea className="my-notes" value={text} placeholder={'Your own notes.\n\nThey are saved with the conversation and included when you export.'} onChange={(e) => {
      setText(e.target.value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void api.updateMeeting(m.id, { notes: latest.current }), 600);
    }} />
  );
}

function InsightsTab({ m, paras, speakers, seek }: { m: Meeting; paras: Para[]; speakers: Speaker[]; seek: Seek }) {
  const stats = useMemo(() => {
    const by = new Map<string, { talk: number; words: number; turns: number; longest: number; questions: number }>();
    for (const p of paras) {
      const s = by.get(p.sp) ?? { talk: 0, words: 0, turns: 0, longest: 0, questions: 0 };
      s.talk += p.e - p.s;
      s.words += p.words.length;
      s.turns++;
      s.longest = Math.max(s.longest, p.e - p.s);
      s.questions += (p.text.match(/\?/g) ?? []).length;
      by.set(p.sp, s);
    }
    const total = [...by.values()].reduce((n, s) => n + s.talk, 0) || 1;
    return speakers.map((sp) => ({ sp, ...(by.get(sp.id) ?? { talk: 0, words: 0, turns: 0, longest: 0, questions: 0 }), share: (by.get(sp.id)?.talk ?? 0) / total })).sort((a, b) => b.talk - a.talk);
  }, [paras, speakers]);
  const talk = stats.reduce((n, s) => n + s.talk, 0);
  const dur = Math.max(1, m.duration);
  if (!paras.length) return <div className="side-empty"><BarChart3 size={24} /><h3>Insights appear once there is a transcript</h3></div>;
  return (
    <div className="insights">
      <section>
        <h5>Who spoke</h5>
        {stats.map((s) => (
          <div className="talk" key={s.sp.id}>
            <Avatar sp={s.sp} size={24} />
            <div className="talk-main">
              <p><b>{s.sp.name}</b><span className="mono">{Math.round(s.share * 100)}%</span></p>
              <div className="talk-bar"><span style={{ width: `${s.share * 100}%`, background: colorOf(s.sp) }} /></div>
              <p className="dim small">{fmtDuration(s.talk)} · {s.turns} turns · {s.talk > 3 ? Math.round(s.words / (s.talk / 60)) : 0} words/min{s.questions ? ` · ${s.questions} question${s.questions > 1 ? 's' : ''}` : ''}</p>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h5>Rhythm <span className="dim">click to jump</span></h5>
        <svg className="lanes" viewBox={`0 0 1000 ${stats.length * 18 + 4}`} preserveAspectRatio="none" style={{ height: stats.length * 18 + 4 }}>
          {stats.map((s, row) => paras.filter((p) => p.sp === s.sp.id).map((p) => (
            <rect key={p.id} x={(p.s / dur) * 1000} y={row * 18 + 4} width={Math.max(3, ((p.e - p.s) / dur) * 1000)} height={11} rx={3} fill={colorOf(s.sp)} onClick={() => seek(p.s, m.hasAudio)}><title>{`${s.sp.name} · ${fmtTime(p.s)}`}</title></rect>
          )))}
        </svg>
      </section>
      <section className="facts">
        <div><b>{Math.round((talk / dur) * 100)}%</b><span>of the time someone was speaking</span></div>
        <div><b>{fmtDuration(Math.max(0, ...stats.map((s) => s.longest)))}</b><span>longest uninterrupted turn{stats.length > 1 ? ` (${[...stats].sort((a, b) => b.longest - a.longest)[0].sp.name})` : ''}</span></div>
        <div><b>{paras.filter((p) => p.hl).length}</b><span>highlights</span></div>
        <div><b>{Math.round(m.words / Math.max(1, talk / 60))}</b><span>words per minute overall</span></div>
      </section>
    </div>
  );
}
