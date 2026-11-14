import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Ellipsis, Pause, Pencil, Play, RefreshCw, RotateCcw, RotateCw, Share, Sparkles, Star, Trash2 } from 'lucide-react';
import { Avatar, Md, Spinner, clock, colorOf, relDay } from '../../renderer/src/ui/bits';
import { fmtDuration, fmtTime, toMarkdown } from '../../shared/text';
import { TEMPLATES } from '../../shared/summaryFormat';
import type { ChatMsg, Meeting, Para, Speaker } from '../../shared/types';
import { audioUrl, call, clearStream, closeMeeting, haptic, run, speakersOf, startStream, toast, useLink } from './link';
import { Bubbles, Composer, TaskRow } from './App';

type Pane = 'notes' | 'transcript' | 'chat';
const RATES = [1, 1.25, 1.5, 2];

export function MeetingScreen({ id }: { id: string }) {
  const m = useLink((s) => s.meetings.find((x) => x.id === id));
  const paras = useLink((s) => s.transcripts[id]);
  const speakers = useLink((s) => (m ? speakersOf(m, s) : []));
  const progress = useLink((s) => s.progress[id]);
  const seek = useLink((s) => s.seek);
  const online = useLink((s) => s.online);
  const [pane, setPane] = useState<Pane>(seek ? 'transcript' : 'notes');
  const [menu, setMenu] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(seek?.t ?? 0);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const startAt = useRef(seek?.t ?? 0);

  const playFrom = (t: number | null): void => {
    const a = audio.current;
    if (!a) return;
    const at = t ?? startAt.current;
    const jump = () => {
      if (Math.abs(a.currentTime - at) > 0.3) a.currentTime = at;
    };
    if (t !== null || a.currentTime === 0) a.readyState >= 1 ? jump() : a.addEventListener('loadedmetadata', jump, { once: true });
    startAt.current = at;
    setTime(at);
    setLoading(a.readyState < 2);
    a.playbackRate = rate;
    a.play().catch(() => {
      setLoading(false);
      toast(online ? 'The audio could not be played.' : 'Audio plays from your Mac, which is out of reach.', 'alert');
    });
  };
  const toggle = (): void => {
    const a = audio.current;
    if (!a) return;
    haptic();
    if (a.paused) playFrom(null);
    else a.pause();
  };
  const skip = (d: number): void => {
    const a = audio.current;
    if (!a) return;
    const t = Math.max(0, Math.min((m?.duration ?? 0) - 0.2, (a.readyState >= 1 ? a.currentTime : startAt.current) + d));
    startAt.current = t;
    setTime(t);
    if (a.readyState >= 1) a.currentTime = t;
  };

  // A search hit or a source citation lands on the moment it points to.
  useEffect(() => {
    if (!seek || !paras?.length) return;
    setPane('transcript');
    startAt.current = seek.t;
    setTime(seek.t);
    if (audio.current && audio.current.readyState >= 1) audio.current.currentTime = seek.t;
    const p = [...paras].reverse().find((x) => x.s <= seek.t + 0.5) ?? paras[0];
    setFlash(p.id);
    const t1 = setTimeout(() => document.getElementById(`p-${p.id}`)?.scrollIntoView({ block: 'center' }), 60);
    const t2 = setTimeout(() => setFlash(''), 2200);
    return () => (clearTimeout(t1), clearTimeout(t2));
  }, [seek?.n, !!paras?.length]);

  const active = useMemo(() => {
    if (!paras?.length || (!playing && time === 0)) return '';
    let hit = '';
    for (const p of paras) {
      if (p.s <= time + 0.05) hit = p.id;
      else break;
    }
    return hit;
  }, [paras, time, playing]);
  useEffect(() => {
    if (playing && pane === 'transcript' && active) document.getElementById(`p-${active}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active, playing, pane]);

  if (!m) return null;
  const working = m.status === 'processing' || m.status === 'recording';
  const rename = (): void => {
    const title = prompt('Name this conversation', m.title)?.trim();
    if (title && title !== m.title) void run(call('updateMeeting', id, { title }));
  };
  const share = async (): Promise<void> => {
    const text = toMarkdown(m, paras ?? []);
    try {
      if (navigator.share) await navigator.share({ title: m.title, text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Copied the notes and transcript.');
      }
    } catch {
      /* share sheet dismissed */
    }
  };

  return (
    <div className="meeting">
      <header className="m-top">
        <button className="icon" onClick={closeMeeting} aria-label="Back"><ChevronLeft size={24} /></button>
        <span className="grow" />
        <button className={`icon ${m.starred ? 'starred' : ''}`} onClick={() => (haptic(), void run(call('updateMeeting', id, { starred: !m.starred })))} aria-label="Star"><Star size={20} fill={m.starred ? 'currentColor' : 'none'} /></button>
        <button className="icon" onClick={() => setMenu(true)} aria-label="More"><Ellipsis size={22} /></button>
      </header>
      <div className="m-body" ref={body}>
        <h1 className="m-title" onClick={rename}>{m.title}</h1>
        <p className="meta">
          <span>{relDay(m.createdAt)}, {clock(m.createdAt)}</span>
          {m.duration > 0 && <span>{fmtDuration(m.duration)}</span>}
          {speakers.length > 0 && <span>{speakers.length} speaker{speakers.length > 1 ? 's' : ''}</span>}
        </p>
        {working && (
          <div className="progress">
            <p><Spinner size={13} /> {m.status === 'recording' ? 'Recording on your Mac' : `Transcribing on your Mac${progress ? ` · ${Math.round(progress * 100)}%` : ''}`}</p>
            <div className="bar"><span style={{ width: `${(progress ?? 0.02) * 100}%` }} /></div>
          </div>
        )}
        {m.status === 'error' && <p className="err">{m.error ?? 'Something went wrong with this recording.'}</p>}
        {Object.entries(m.nameHints ?? {}).map(([spId, name]) => {
          const sp = speakers.find((s) => s.id === spId);
          return sp && (
            <div key={spId} className="hint">
              <Avatar sp={sp} size={26} />
              <span>Is {sp.name} <b>{name}</b>?</span>
              <button className="btn small primary" onClick={() => void run(call('renameSpeaker', id, spId, name))}>Yes</button>
              <button className="btn small" onClick={() => void run(call('dismissHint', id, spId))}>No</button>
            </div>
          );
        })}
        <div className="seg sticky">
          {(['notes', 'transcript', 'chat'] as const).map((p) => <button key={p} className={pane === p ? 'on' : ''} onClick={() => setPane(p)}>{p[0].toUpperCase() + p.slice(1)}</button>)}
        </div>
        {pane === 'notes' && <Notes m={m} working={working} onTime={(t) => (setPane('transcript'), playFrom(t))} />}
        {pane === 'transcript' && <Transcript m={m} paras={paras} speakers={speakers} active={active} flash={flash} time={time} playing={playing} onPlay={playFrom} />}
        {pane === 'chat' && <Chat m={m} onTime={(t) => (setPane('transcript'), playFrom(t))} />}
      </div>
      {m.hasAudio && pane !== 'chat' && (
        <footer className="player">
          <input
            type="range" min={0} max={Math.max(1, m.duration)} step={0.1} value={Math.min(time, m.duration)} aria-label="Position"
            style={{ ['--p' as string]: `${(Math.min(time, m.duration) / Math.max(1, m.duration)) * 100}%` }}
            onChange={(e) => {
              const t = +e.target.value;
              startAt.current = t;
              setTime(t);
              if (audio.current && audio.current.readyState >= 1) audio.current.currentTime = t;
            }}
          />
          <div className="player-row">
            <span className="mono">{fmtTime(time)}</span>
            <span className="grow" />
            <button className="icon" onClick={() => skip(-15)} aria-label="Back 15 seconds"><RotateCcw size={20} /></button>
            <button className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{loading ? <Spinner size={18} /> : playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button>
            <button className="icon" onClick={() => skip(15)} aria-label="Forward 15 seconds"><RotateCw size={20} /></button>
            <span className="grow" />
            <button className="rate mono" onClick={() => { const r = RATES[(RATES.indexOf(rate) + 1) % RATES.length]; setRate(r); if (audio.current) audio.current.playbackRate = r; }}>{rate}×</button>
          </div>
        </footer>
      )}
      {m.hasAudio && (
        <audio
          ref={audio} src={audioUrl(id)} preload="none"
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onPlaying={() => setLoading(false)} onWaiting={() => setLoading(true)} onCanPlay={() => setLoading(false)}
          onTimeUpdate={(e) => !e.currentTarget.seeking && setTime(e.currentTarget.currentTime)}
        />
      )}
      {menu && (
        <div className="veil" onClick={() => setMenu(false)}>
          <div className="sheet menu" onClick={() => setMenu(false)}>
            <i className="grip" />
            <button onClick={rename}><Pencil size={18} /> Rename</button>
            <button onClick={() => void share()}><Share size={18} /> Share notes and transcript</button>
            {m.status === 'ready' && m.words >= 25 && <button onClick={() => rewrite(m)}><RefreshCw size={18} /> Write the notes again</button>}
            <button className="danger" onClick={() => confirm(`Delete “${m.title}” from your library? This removes it from your Mac too.`) && void run(call('deleteMeeting', id)).then(closeMeeting)}><Trash2 size={18} /> Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

const rewrite = (m: Meeting): void => {
  startStream(`sum:${m.id}`);
  void run(call('summarize', m.id, `sum:${m.id}`, m.template)).then(() => clearStream(`sum:${m.id}`));
};

function Notes({ m, working, onTime }: { m: Meeting; working: boolean; onTime: (t: number) => void }) {
  const stream = useLink((s) => s.streams[`sum:${m.id}`]);
  const canWrite = useLink((s) => s.notes && s.online);
  const s = m.summary;
  const writing = m.summaryState === 'running' || stream?.running;
  if (writing && !s)
    return (
      <div className="writing">
        <span className="sheen"><Sparkles size={15} /> {stream?.stage ?? 'Writing your notes'}…</span>
        <i /><i /><i /><i />
      </div>
    );
  if (!s)
    return (
      <div className="empty small">
        {working ? <p>Notes are written as soon as the transcript is ready.</p> : m.words < 25 ? <p>There wasn't enough speech here to write notes.</p> : (
          <>
            {m.summaryError && <p className="err">{m.summaryError}</p>}
            <p>{canWrite ? 'No notes yet for this conversation.' : 'Notes need the AI model in Hark on your Mac.'}</p>
            {canWrite && <button className="btn primary" onClick={() => rewrite(m)}><Sparkles size={15} /> Write notes</button>}
          </>
        )}
      </div>
    );
  const sec = (title: string, items: string[]) => items.length > 0 && (
    <section className="sum-sec"><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}><Md text={x} onTime={onTime} /></li>)}</ul></section>
  );
  return (
    <div className="summary">
      {writing && <p className="sheen rewriting"><Sparkles size={14} /> {stream?.stage ?? 'Rewriting'}…</p>}
      {s.overview && <p className="overview">{s.overview}</p>}
      {s.topics.length > 0 && <p className="topics">{s.topics.map((t) => <span key={t} className="chip">{t}</span>)}</p>}
      {sec('Key points', s.keyPoints)}
      {s.actions.length > 0 && <section className="sum-sec"><h4>{TEMPLATES[s.template]?.name === 'Lecture' ? 'To do' : 'Action items'}</h4>{s.actions.map((a) => <TaskRow key={a.id} m={m} a={a} />)}</section>}
      {sec('Decisions', s.decisions)}
      {sec('Open questions', s.questions)}
      {s.chapters.length > 0 && (
        <section className="sum-sec">
          <h4>Chapters</h4>
          <div className="chapters">{s.chapters.map((c, i) => <button key={i} onClick={() => onTime(c.t)}><span className="mono">{fmtTime(c.t)}</span><b>{c.title}</b>{c.note && <p>{c.note}</p>}</button>)}</div>
        </section>
      )}
      {s.cards.length > 0 && (
        <section className="sum-sec">
          <h4>Flashcards</h4>
          {s.cards.map((c, i) => <details key={i} className="flash-card"><summary>{c.q}</summary><p>{c.a}</p></details>)}
        </section>
      )}
      <p className="sum-foot">Written on your Mac{s.model ? ` by ${s.model}` : ''}. Check anything important against the transcript.</p>
    </div>
  );
}

function Transcript({ m, paras, speakers, active, flash, time, playing, onPlay }: { m: Meeting; paras?: Para[]; speakers: Speaker[]; active: string; flash: string; time: number; playing: boolean; onPlay: (t: number) => void }) {
  if (!paras) return <div className="empty small"><Spinner size={20} /></div>;
  if (!paras.length) return <div className="empty small"><p>{m.status === 'processing' ? 'The transcript appears here as your Mac works through the recording.' : 'No speech was found in this recording.'}</p></div>;
  const name = (sp: Speaker): void => {
    const n = prompt(`Who is ${sp.name}? Hark will recognise this voice from now on.`, sp.named ? sp.name : '')?.trim();
    if (n) void run(call('renameSpeaker', m.id, sp.id, n));
  };
  return (
    <div className="feed">
      {paras.map((p) => {
        const sp = speakers.find((s) => s.id === p.sp);
        const on = p.id === active;
        return (
          <div key={p.id} id={`p-${p.id}`} className={`turn ${on ? 'on' : ''} ${p.hl ? 'hl' : ''} ${flash === p.id ? 'flash' : ''}`}>
            <div className="turn-head">
              <Avatar sp={sp} size={24} />
              <button className="who" style={{ color: colorOf(sp) }} onClick={() => sp && name(sp)}>{sp?.name ?? 'Speaker'}</button>
              <span className="mono dim">{fmtTime(p.s)}</span>
            </div>
            <p onClick={() => m.hasAudio && onPlay(p.s)}>
              {on && playing && p.words.length ? p.words.map((w, i) => <span key={i} className={w.s <= time ? 'said' : ''}>{w.t} </span>) : p.text}
            </p>
            {p.note && <p className="para-note">{p.note}</p>}
          </div>
        );
      })}
    </div>
  );
}

function Chat({ m, onTime }: { m: Meeting; onTime: (t: number) => void }) {
  const notes = useLink((s) => s.notes);
  const [sid, setSid] = useState('');
  const [pending, setPending] = useState('');
  const stream = useLink((s) => (sid ? s.streams[sid] : undefined));
  const ask = (q: string) => {
    const id = `pchat:${m.id}:${Date.now()}`;
    setSid(id);
    setPending(q);
    startStream(id);
    void run(call<ChatMsg>('chat', m.id, q, id)).then(() => {
      setPending('');
      clearStream(id);
    });
  };
  const ideas = ['What were the main takeaways?', 'What do I need to do next?', 'Was anything left unresolved?'];
  return (
    <div className="chat">
      {!m.chat.length && !pending ? (
        <div className="empty small">
          <p>{notes ? 'Ask anything about this conversation.' : 'Download the AI model in Hark on your Mac to chat with your recordings.'}</p>
          {notes && m.status === 'ready' && ideas.map((i) => <button key={i} className="idea" onClick={() => ask(i)}>{i}</button>)}
        </div>
      ) : <Bubbles msgs={m.chat} pending={pending} stream={stream} onTime={onTime} />}
      <Composer placeholder="Ask about this conversation" busy={!!pending} onSend={ask} onStop={() => void call('abort', sid).catch(() => undefined)} />
    </div>
  );
}
