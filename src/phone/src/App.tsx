import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, AudioLines, CalendarClock, Check, ChevronRight, CloudOff, FileAudio, Flag, Library, ListChecks, Mic, Pause, Play, Search, Sparkles, Square, Star, Trash2, X } from 'lucide-react';
import { Avatar, Md, Orb, Spinner, clock, dayLabel, relDay } from '../../renderer/src/ui/bits';
import { fmtDuration, fmtTime } from '../../shared/text';
import { TEMPLATES } from '../../shared/summaryFormat';
import type { ActionItem, ChatMsg, Meeting, SearchHit, Source, TemplateId } from '../../shared/types';
import { call, clearStream, get, haptic, openMeeting, run, set, startStream, toast, token, useLink, type OutItem, type Tab } from './link';
import { addFile, bookmark, canRecord, discard, levels, recState, retry, setTemplate, startRecording, stopRecording, subscribeRec, togglePause } from './rec';
import { MeetingScreen } from './Meeting';

const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
const useRec = () => useSyncExternalStore(subscribeRec, recState);

export const toggleAction = (m: Meeting, a: ActionItem): void => {
  if (!m.summary) return;
  haptic();
  void run(call('setSummary', m.id, { ...m.summary, actions: m.summary.actions.map((x) => (x.id === a.id ? { ...x, done: !x.done } : x)) }));
};

export function App() {
  const paired = useLink((s) => s.paired);
  const tab = useLink((s) => s.tab);
  const open = useLink((s) => s.open);
  const recorder = useLink((s) => s.recorder);
  const sheet = useLink((s) => s.sheet);
  const toasts = useLink((s) => s.toasts);
  if (!paired) return <Gate />;
  return (
    <div className="phone">
      <div className="aurora" />
      <main className="screen" key={tab}>
        {tab === 'library' && <Home />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'ask' && <Ask />}
      </main>
      <TabBar />
      {open && <MeetingScreen id={open} key={open} />}
      {recorder && <Recorder />}
      {sheet === 'link' && <LinkSheet />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
    </div>
  );
}

function Gate() {
  return (
    <div className="phone gate">
      <div className="aurora" />
      <div className="gate-body">
        <Orb size={220} />
        <h1>Hark</h1>
        <p>This phone isn't paired yet.</p>
        <ol>
          <li>Open <b>Hark</b> on your Mac.</li>
          <li>Go to <b>Settings → Phone</b>.</li>
          <li>Point this phone's camera at the code.</li>
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tab bar

async function beginRecording(): Promise<void> {
  haptic(14);
  if (!canRecord) return set({ sheet: 'link' });
  set({ recorder: true });
  const ok = await startRecording((localStorage.getItem('hark.tpl') as TemplateId) || 'meeting');
  if (!ok) haptic(40);
}

function TabBar() {
  const tab = useLink((s) => s.tab);
  const open = useLink((s) => s.meetings.reduce((n, m) => n + (m.summary?.actions.filter((a) => !a.done).length ?? 0), 0));
  const item = (id: Tab, label: string, icon: React.ReactNode, badge?: number) => (
    <button className={tab === id ? 'on' : ''} onClick={() => set({ tab: id })}>
      {icon}
      <span>{label}</span>
      {!!badge && <i>{badge > 99 ? '99+' : badge}</i>}
    </button>
  );
  return (
    <nav className="tabbar">
      {item('library', 'Library', <Library size={21} />)}
      {item('tasks', 'Tasks', <ListChecks size={21} />, open)}
      <button className="fab" aria-label="Record" onClick={() => void beginRecording()}><Mic size={26} strokeWidth={2.2} /></button>
      {item('ask', 'Ask', <Sparkles size={21} />)}
      <FilePick />
    </nav>
  );
}

/** "Add": hand Hark a voice memo or any audio/video file from the phone. */
function FilePick() {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <button onClick={() => ref.current?.click()}>
      <FileAudio size={21} />
      <span>Add file</span>
      <input
        ref={ref} type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac,.webm,.mp4,.mov,.caf" multiple hidden
        onChange={(e) => {
          for (const f of Array.from(e.target.files ?? [])) void addFile(f, 'meeting');
          e.target.value = '';
          set({ tab: 'library' });
        }}
      />
    </button>
  );
}

// ---------------------------------------------------------------- home

const greeting = (): string => {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

function StatusPill() {
  const online = useLink((s) => s.online);
  return (
    <button className={`pill ${online ? 'ok' : 'off'}`} onClick={() => set({ sheet: 'link' })}>
      {online ? <i className="dot" /> : <CloudOff size={13} />}
      {online ? 'Mac connected' : 'Mac out of reach'}
    </button>
  );
}

function Home() {
  const meetings = useLink((s) => s.meetings);
  const outbox = useLink((s) => s.outbox);
  const name = useLink((s) => s.userName);
  const online = useLink((s) => s.online);
  const booted = useLink((s) => s.booted);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || !online) return setHits([]);
    const t = setTimeout(() => void call<SearchHit[]>('search', query).then((h) => setHits(h.slice(0, 20)), () => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q, online]);
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return query ? meetings.filter((m) => m.title.toLowerCase().includes(query) || m.summary?.topics.some((t) => t.toLowerCase().includes(query))) : meetings;
  }, [meetings, q]);
  const minutes = Math.round(meetings.reduce((n, m) => n + m.duration, 0) / 60);
  return (
    <>
      <header className="top">
        <div className="brand"><span className="brand-mark"><AudioLines size={17} /></span><span className="brand-name">Hark</span></div>
        <StatusPill />
      </header>
      <div className="hello">
        <h1>{greeting()}{name ? `, ${name.split(' ')[0]}` : ''}</h1>
        <p>{meetings.length ? `${meetings.length} conversation${meetings.length > 1 ? 's' : ''} · ${minutes < 1 ? 'under a minute' : `${minutes} minute${minutes === 1 ? '' : 's'}`} kept` : 'Everything you record stays between this phone and your Mac.'}</p>
      </div>
      <label className="search"><Search size={16} /><input value={q} placeholder="Search everything that was said" onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />{q && <button onClick={() => setQ('')}><X size={15} /></button>}</label>
      {outbox.length > 0 && !q && (
        <section className="list">
          <h5>On this phone</h5>
          {outbox.map((o) => <OutCard key={o.rid} o={o} />)}
        </section>
      )}
      {hits.length > 0 && (
        <section className="list">
          <h5>Said in conversations</h5>
          {hits.map((h, i) => (
            <button key={i} className="hit" onClick={() => openMeeting(h.meetingId, h.t)}>
              <b>{h.speaker} <span className="mono">{fmtTime(h.t)}</span></b>
              <p>{h.snippet}</p>
              <span className="dim">{h.title}</span>
            </button>
          ))}
        </section>
      )}
      <section className="list">
        {q ? shown.length > 0 && <h5>Conversations</h5> : meetings.length > 0 && <h5>Recent</h5>}
        {shown.map((m) => <MeetingCard key={m.id} m={m} />)}
        {!meetings.length && !outbox.length && (
          <div className="empty">
            {booted || !online ? (
              <>
                <Orb size={170} />
                <h3>Nothing here yet</h3>
                <p>{canRecord ? 'Tap the microphone to record your first conversation. Hark on your Mac will transcribe it and write the notes.' : 'Tap “Add file” to send a voice memo to Hark on your Mac.'}</p>
              </>
            ) : <Spinner size={22} />}
          </div>
        )}
        {q && !shown.length && !hits.length && <div className="empty"><p>Nothing matches “{q}”.</p></div>}
      </section>
    </>
  );
}

function OutCard({ o }: { o: OutItem }) {
  const online = useLink((s) => s.online);
  return (
    <div className="card out">
      <div className="card-top">
        <b>{o.name ?? `Recording, ${clock(o.createdAt)}`}</b>
        <button className="icon" aria-label="Delete" onClick={() => confirm('Delete this recording from your phone? It has not reached your Mac yet.') && void discard(o.rid)}><Trash2 size={16} /></button>
      </div>
      <p className="meta">
        {o.duration > 0 && <span>{fmtDuration(o.duration)}</span>}
        <span>{(o.bytes / 1e6).toFixed(1)} MB</span>
        <span>{o.error ? 'Could not be sent' : o.state === 'sending' ? `Sending to your Mac… ${Math.round((o.sent ?? 0) * 100)}%` : online ? 'Queued' : 'Waiting for your Mac'}</span>
      </p>
      {o.state === 'sending' && <div className="bar"><span style={{ width: `${(o.sent ?? 0) * 100}%` }} /></div>}
      {o.error && <p className="err">{o.error} <button className="link" onClick={() => retry(o.rid)}>Try again</button></p>}
    </div>
  );
}

function MeetingCard({ m }: { m: Meeting }) {
  const progress = useLink((s) => s.progress[m.id]);
  const working = m.status === 'processing' || m.status === 'recording';
  const open = m.summary?.actions.filter((a) => !a.done).length ?? 0;
  return (
    <button className="card" onClick={() => openMeeting(m.id)}>
      <div className="card-top">
        <b>{m.title}</b>
        {m.starred && <Star size={14} className="star" fill="currentColor" />}
        <ChevronRight size={16} className="chev" />
      </div>
      <p className="meta">
        <span>{relDay(m.createdAt)}, {clock(m.createdAt)}</span>
        {m.duration > 0 && <span>{fmtDuration(m.duration)}</span>}
        {m.source === 'phone' && <span>phone</span>}
      </p>
      {working ? (
        <>
          <p className="working"><Spinner size={12} /> {m.status === 'recording' ? 'Recording on your Mac' : `Transcribing on your Mac${progress ? ` · ${Math.round(progress * 100)}%` : ''}`}</p>
          <div className="bar"><span style={{ width: `${(progress ?? 0.02) * 100}%` }} /></div>
        </>
      ) : m.status === 'error' ? (
        <p className="err">{m.error ?? 'Something went wrong.'}</p>
      ) : (
        <>
          <p className="preview">{m.summary?.overview || m.preview || 'No speech was found.'}</p>
          <div className="card-foot">
            <span className="faces">{m.speakers.slice(0, 5).map((sp) => <Avatar key={sp.id} sp={sp} size={22} />)}</span>
            {m.summaryState === 'running' && <span className="chip glow"><Spinner size={10} /> Writing notes</span>}
            {open > 0 && <span className="chip todo"><ListChecks size={11} /> {open}</span>}
          </div>
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- tasks

function Tasks() {
  const meetings = useLink((s) => s.meetings);
  const [filter, setFilter] = useState<'open' | 'done'>('open');
  const groups = meetings.filter((m) => m.summary?.actions.length).map((m) => ({ m, items: m.summary!.actions.filter((a) => (filter === 'done') === a.done) })).filter((g) => g.items.length);
  const total = meetings.reduce((n, m) => n + (m.summary?.actions.length ?? 0), 0);
  const done = meetings.reduce((n, m) => n + (m.summary?.actions.filter((a) => a.done).length ?? 0), 0);
  return (
    <>
      <header className="top"><div><p className="eyebrow">{done} of {total} done</p><h1 className="title">Action items</h1></div></header>
      <div className="seg">{(['open', 'done'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'open' ? 'To do' : 'Done'}</button>)}</div>
      {total > 0 && <div className="bar meter"><span style={{ width: `${(done / total) * 100}%` }} /></div>}
      {!groups.length && <div className="empty"><ListChecks size={30} /><h3>{total ? (filter === 'open' ? 'All caught up' : 'Nothing ticked off yet') : 'No action items yet'}</h3><p>Hark pulls every task, its owner and due date out of each conversation.</p></div>}
      {groups.map(({ m, items }) => (
        <section key={m.id} className="list">
          <h5 onClick={() => openMeeting(m.id)}>{m.title} <span>{dayLabel(m.createdAt)}</span></h5>
          {items.map((a) => <TaskRow key={a.id} m={m} a={a} />)}
        </section>
      ))}
    </>
  );
}

export function TaskRow({ m, a }: { m: Meeting; a: ActionItem }) {
  return (
    <div className={`task ${a.done ? 'done' : ''}`} onClick={() => toggleAction(m, a)}>
      <span className="check">{a.done && <Check size={14} strokeWidth={3} />}</span>
      <div>
        <p>{a.text}</p>
        {(a.owner || a.due) && <p className="task-meta">{a.owner && <span className="chip">{a.owner}</span>}{a.due && <span className="chip due"><CalendarClock size={11} /> {a.due}</span>}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ask

export function Composer({ placeholder, busy, onSend, onStop }: { placeholder: string; busy: boolean; onSend: (q: string) => void; onStop: () => void }) {
  const [q, setQ] = useState('');
  const online = useLink((s) => s.online);
  const send = () => {
    const text = q.trim();
    if (!text || busy || !online) return;
    setQ('');
    onSend(text);
  };
  return (
    <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
      <input value={q} placeholder={online ? placeholder : 'Your Mac is out of reach'} disabled={!online} onChange={(e) => setQ(e.target.value)} enterKeyHint="send" />
      {busy ? <button type="button" className="send stop" onClick={onStop} aria-label="Stop"><Square size={14} fill="currentColor" /></button> : <button className="send" disabled={!q.trim() || !online} aria-label="Send"><ArrowUp size={18} strokeWidth={2.6} /></button>}
    </form>
  );
}

export function Bubbles({ msgs, pending, stream, onSource, onTime }: { msgs: ChatMsg[]; pending: string; stream?: { text: string; sources?: Source[]; error?: string }; onSource?: (s: Source) => void; onTime?: (t: number) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length, pending, stream?.text]);
  const cited = (m: { text: string; sources?: Source[] }) => (m.sources ?? []).filter((s) => m.text.includes(`[${s.n}]`));
  return (
    <div className="bubbles">
      {msgs.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          {m.role === 'assistant' ? <Md text={m.text} sources={m.sources} onSource={onSource} onTime={onTime} /> : m.text}
          {m.role === 'assistant' && cited(m).length > 0 && (
            <div className="sources">{cited(m).map((s) => <button key={s.n} onClick={() => onSource?.(s)}><i>{s.n}</i>{s.title} · {fmtTime(s.t)}</button>)}</div>
          )}
        </div>
      ))}
      {pending && <div className="msg user">{pending}</div>}
      {pending && (
        <div className="msg assistant">
          {stream?.text ? <Md text={stream.text} sources={stream.sources} onSource={onSource} onTime={onTime} /> : <p className="thinking"><Spinner /> {stream?.sources?.length ? `Reading ${stream.sources.length} moments…` : 'Thinking on your Mac…'}</p>}
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function Ask() {
  const history = useLink((s) => s.ask);
  const notes = useLink((s) => s.notes);
  const [sid, setSid] = useState('');
  const [pending, setPending] = useState('');
  const stream = useLink((s) => (sid ? s.streams[sid] : undefined));
  const ask = (q: string) => {
    const id = `pask:${Date.now()}`;
    setSid(id);
    setPending(q);
    startStream(id);
    void run(call<ChatMsg>('ask', q, id)).then((a) => {
      if (a) set((s) => ({ ask: [...s.ask, { id: `u${a.id}`, role: 'user', text: q, at: a.at }, a] }));
      setPending('');
      clearStream(id);
    });
  };
  const ideas = ['What did I agree to do this week?', 'What decisions were made recently?', 'Summarise my last conversation'];
  return (
    <div className="ask">
      <header className="top">
        <div><p className="eyebrow">Across everything you've recorded</p><h1 className="title">Ask Hark</h1></div>
        {history.length > 0 && <button className="link" onClick={() => confirm('Clear this conversation with Hark?') && void run(call('clearAsk')).then(() => set({ ask: [] }))}>Clear</button>}
      </header>
      {!history.length && !pending ? (
        <div className="empty ask-empty">
          <Orb size={150} />
          <p>{notes ? 'Ask anything. Hark finds the moments that answer it and shows where it was said.' : 'Download the AI model in Hark on your Mac to ask questions.'}</p>
          {notes && ideas.map((i) => <button key={i} className="idea" onClick={() => ask(i)}>{i}</button>)}
        </div>
      ) : (
        <Bubbles msgs={history} pending={pending} stream={stream} onSource={(s) => openMeeting(s.meetingId, s.t)} />
      )}
      <Composer placeholder="Ask about any conversation" busy={!!pending} onSend={ask} onStop={() => void call('abort', sid).catch(() => undefined)} />
    </div>
  );
}

// ---------------------------------------------------------------- recorder

function Recorder() {
  const rec = useRec();
  const [tpl, setTpl] = useState<TemplateId>((localStorage.getItem('hark.tpl') as TemplateId) || 'meeting');
  const [size] = useState(() => Math.min(340, Math.round(window.innerWidth * 0.86)));
  const close = () => set({ recorder: false });
  const stop = async (keep: boolean) => {
    haptic(18);
    await stopRecording(keep);
    close();
  };
  const pick = (t: TemplateId) => {
    setTpl(t);
    setTemplate(t);
    localStorage.setItem('hark.tpl', t);
  };
  return (
    <div className="recorder">
      <div className="aurora hot" />
      <header>
        <span className="rec-state">{rec.on ? <><i className={`rec-dot ${rec.paused ? 'off' : ''}`} />{rec.paused ? 'Paused' : 'Recording'}</> : rec.error ? 'Not recording' : 'Starting…'}</span>
        {!rec.on && <button className="icon" onClick={close} aria-label="Close"><X size={20} /></button>}
      </header>
      <div className="rec-orb"><Orb size={size} levels={levels} intensity={rec.paused ? 0.3 : 1.25} /></div>
      {rec.error ? (
        <div className="rec-error"><p>{rec.error}</p><button className="btn" onClick={close}>Close</button></div>
      ) : (
        <>
          <div className="rec-time mono">{fmtTime(rec.elapsed)}</div>
          <p className="rec-hint">{rec.marks.length ? `${rec.marks.length} moment${rec.marks.length > 1 ? 's' : ''} flagged · ` : ''}Keep Hark open and the screen on while recording</p>
          <div className="tpls">{(Object.keys(TEMPLATES) as TemplateId[]).map((t) => <button key={t} className={tpl === t ? 'on' : ''} onClick={() => pick(t)}>{TEMPLATES[t].name}</button>)}</div>
          <div className="rec-controls">
            <button className="round" disabled={!rec.on} onClick={() => (haptic(), bookmark())} aria-label="Flag this moment"><Flag size={21} /><span>Flag</span></button>
            <button className="stop" disabled={!rec.on} onClick={() => void stop(true)} aria-label="Stop and save"><Square size={26} fill="currentColor" /></button>
            <button className="round" disabled={!rec.on} onClick={() => (haptic(), togglePause())} aria-label={rec.paused ? 'Resume' : 'Pause'}>{rec.paused ? <Play size={21} /> : <Pause size={21} />}<span>{rec.paused ? 'Resume' : 'Pause'}</span></button>
          </div>
          <button className="link discard" disabled={!rec.on} onClick={() => confirm('Throw this recording away?') && void stop(false)}>Discard</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- connection sheet

function LinkSheet() {
  const online = useLink((s) => s.online);
  const status = useLink((s) => s.status);
  const close = () => set({ sheet: null });
  return (
    <div className="veil" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <i className="grip" />
        <h2>{online ? 'Connected to your Mac' : "Can't reach your Mac"}</h2>
        <p className="lead">
          {online
            ? 'This phone is a window onto Hark on your Mac. Recordings are transcribed and summarised there; nothing goes to the cloud.'
            : 'Make sure Hark is open on your Mac, the Mac is awake, and this phone is on the same Wi-Fi (or connected through Tailscale). You can still record: it is kept on the phone and sent when the Mac is back in reach.'}
        </p>
        {online && status && (status.asr !== 'ready' || status.llm === 'missing') && (
          <p className="note">{status.asr === 'missing' ? 'The speech model has not been downloaded on your Mac yet, so recordings cannot be transcribed.' : status.llm === 'missing' ? 'The AI model has not been downloaded on your Mac yet, so notes and answers are off.' : 'The speech model is warming up on your Mac.'}</p>
        )}
        {!canRecord && (
          <div className="note">
            <b>Recording is off on this link</b>
            <p>Phones only allow the microphone on a secure (https) address. On your Mac, open Hark → Settings → Phone and follow “Record from anywhere”. Until then, use <b>Add file</b> to send voice memos.</p>
          </div>
        )}
        {!standalone && <div className="note"><b>Install Hark on this phone</b><p>In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>. On Android, open the browser menu and tap <b>Install app</b>.</p></div>}
        <div className="sheet-actions">
          <button className="btn danger" onClick={() => { if (confirm('Unpair this phone? Recordings still waiting on the phone are kept.')) { localStorage.removeItem('hark.k'); localStorage.removeItem('hark.cache'); location.replace(location.pathname); } }}>Unpair</button>
          <button className="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}

export { get, toast, token };
