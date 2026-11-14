import { useMemo, useState } from 'react';
import { ArrowUp, FileAudio, GraduationCap, Mic, MessagesSquare, NotebookPen, Play, Sparkles, Star, Trash2, Upload, Users } from 'lucide-react';
import { api } from '../api';
import { go, run, set, useStore } from '../store';
import { startRecording } from '../recorder';
import { currentTemplate, importFiles } from '../App';
import { Avatar, Orb, Ring, Spark, clock, relDay } from '../ui/bits';
import { fmtDuration } from '../../../shared/text';
import { TEMPLATES } from '../../../shared/summaryFormat';
import type { Meeting, TemplateId } from '../../../shared/types';

const TEMPLATE_ICONS: Record<TemplateId, React.ReactNode> = { meeting: <Users size={14} />, lecture: <GraduationCap size={14} />, interview: <MessagesSquare size={14} />, memo: <NotebookPen size={14} /> };

export function TemplatePicker({ value, onChange }: { value: TemplateId; onChange: (t: TemplateId) => void }) {
  return (
    <div className="seg" role="tablist">
      {(Object.keys(TEMPLATES) as TemplateId[]).map((t) => (
        <button key={t} className={value === t ? 'on' : ''} onClick={() => onChange(t)} title={TEMPLATES[t].blurb}>
          {TEMPLATE_ICONS[t]} {TEMPLATES[t].name}
        </button>
      ))}
    </div>
  );
}

export function Home() {
  const view = useStore((s) => s.view);
  const meetings = useStore((s) => s.meetings);
  const name = useStore((s) => s.settings.userName);
  const asr = useStore((s) => s.status.asr);
  const [tpl, setTpl] = useState<TemplateId>(currentTemplate());
  const [q, setQ] = useState('');
  const folder = view.name === 'home' ? view.folder : undefined;
  const starred = view.name === 'home' ? view.starred : undefined;
  const shown = useMemo(() => meetings.filter((m) => (!folder || m.folder === folder) && (!starred || m.starred)), [meetings, folder, starred]);
  const groups = useMemo(() => {
    const g: [string, Meeting[]][] = [];
    for (const m of shown) {
      const label = relDay(m.createdAt);
      const last = g[g.length - 1];
      if (last && last[0] === label) last[1].push(m);
      else g.push([label, [m]]);
    }
    return g;
  }, [shown]);
  const stats = useMemo(() => {
    const secs = meetings.reduce((n, m) => n + m.duration, 0);
    return { hours: secs / 3600, words: meetings.reduce((n, m) => n + m.words, 0), open: meetings.reduce((n, m) => n + (m.summary?.actions.filter((a) => !a.done).length ?? 0), 0) };
  }, [meetings]);
  const hour = new Date().getHours();
  const hello = `${hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}`;
  const pickTpl = (t: TemplateId) => {
    localStorage.setItem('hark.template', t);
    setTpl(t);
  };
  const ask = () => {
    if (!q.trim()) return;
    sessionStorage.setItem('hark.ask', q.trim());
    go({ name: 'ask' });
  };
  const missing = asr === 'missing';

  return (
    <div className="page home">
      <header className="page-head">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1>{folder ?? (starred ? 'Starred' : hello)}</h1>
        </div>
        <div className="stats">
          <div><b>{stats.hours < 10 ? stats.hours.toFixed(1) : Math.round(stats.hours)}</b><span>hours kept</span></div>
          <div><b>{stats.words > 9999 ? `${Math.round(stats.words / 1000)}k` : stats.words.toLocaleString()}</b><span>words searchable</span></div>
          <div className="link" onClick={() => go({ name: 'tasks' })}><b>{stats.open}</b><span>open actions</span></div>
        </div>
      </header>

      {!folder && !starred && (
        <section className="hero">
          <div className="hero-rec">
            <div className="hero-orb"><Orb size={150} /></div>
            <div className="hero-copy">
              <h2>Capture a conversation</h2>
              <p>Live transcript, speakers told apart, notes written the moment you stop.</p>
              <TemplatePicker value={tpl} onChange={pickTpl} />
              <div className="row">
                <button className="btn primary big" disabled={missing} onClick={() => void startRecording(tpl)}><Mic size={17} /> Start recording</button>
                <button className="btn ghost" disabled={missing} onClick={() => void startRecording(tpl, true)} title="Also capture what your computer is playing: a Zoom, Meet or Teams call, or a video. Beta.">+ computer audio</button>
              </div>
              {missing && <p className="warn-line" onClick={() => set({ settingsOpen: 'models' })}>Download a speech model first → Settings</p>}
            </div>
          </div>
          <div className="hero-side">
            <button className="tile" disabled={missing} onClick={() => void importFiles()}>
              <span className="tile-ic"><Upload size={18} /></span>
              <b>Import a recording</b>
              <span>Drop any audio or video file anywhere in this window.</span>
            </button>
            <div className="tile ask-tile">
              <span className="tile-ic"><Sparkles size={18} /></span>
              <b>Ask your memory</b>
              <div className="ask-in">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="What did we decide about…" />
                <button className="send" onClick={ask} disabled={!q.trim()}><ArrowUp size={15} /></button>
              </div>
            </div>
          </div>
        </section>
      )}

      {!meetings.length ? (
        <section className="empty">
          <FileAudio size={30} />
          <h3>Your library is empty</h3>
          <p>Record something, import a file, or see how Hark works with a two-minute sample.</p>
          <button className="btn" disabled={missing} onClick={() => void run(api.importSample()).then((m) => m && go({ name: 'meeting', id: m.id }))}><Play size={15} /> Try the sample conversation</button>
        </section>
      ) : !shown.length ? (
        <section className="empty"><Star size={28} /><h3>Nothing here yet</h3><p>{starred ? 'Star a conversation to keep it close.' : 'Move conversations into this folder from their header.'}</p></section>
      ) : (
        groups.map(([label, list]) => (
          <section key={label} className="group">
            <h4>{label}</h4>
            <div className="cards">{list.map((m) => <Card key={m.id} m={m} />)}</div>
          </section>
        ))
      )}
    </div>
  );
}

function Card({ m }: { m: Meeting }) {
  const progress = useStore((s) => s.progress[m.id]);
  const busy = m.status === 'processing' || m.status === 'recording';
  const open = m.summary?.actions.filter((a) => !a.done).length ?? 0;
  return (
    <article className={`card ${busy ? 'busy' : ''} ${m.status === 'error' ? 'err' : ''}`} onClick={() => go(m.status === 'recording' ? { name: 'record' } : { name: 'meeting', id: m.id })}>
      <div className="card-main">
        <div className="card-top">
          <h3>{m.title}</h3>
          {m.starred && <Star size={13} className="starred" fill="currentColor" />}
        </div>
        <p className="card-meta">
          <span>{clock(m.createdAt)}</span>
          {m.duration > 0 && <span>{fmtDuration(m.duration)}</span>}
          {m.folder && <span className="chip">{m.folder}</span>}
          {m.summaryState === 'running' && <span className="chip glow"><Sparkles size={11} /> writing notes</span>}
          {open > 0 && <span className="chip todo">{open} to do</span>}
        </p>
        <p className="card-snip">{m.status === 'error' ? m.error : m.summary?.overview || m.preview || (busy ? 'Listening…' : 'No speech detected.')}</p>
        {!!m.summary?.topics.length && <p className="topics">{m.summary.topics.slice(0, 4).map((t) => <span key={t}>{t}</span>)}</p>}
      </div>
      <div className="card-side">
        {busy ? <div className="card-ring"><Ring value={m.status === 'recording' ? 1 : progress ?? 0.02} /><span>{m.status === 'recording' ? 'Live' : `${Math.round((progress ?? 0) * 100)}%`}</span></div> : <Spark peaks={m.peaks} />}
        <div className="faces">{m.speakers.slice(0, 4).map((s) => <Avatar key={s.id} sp={s} size={22} />)}</div>
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={m.starred ? 'Unstar' : 'Star'} onClick={() => void run(api.updateMeeting(m.id, { starred: !m.starred }))}><Star size={14} fill={m.starred ? 'currentColor' : 'none'} /></button>
        <button className="icon-btn danger" title="Delete" onClick={() => confirm(`Delete “${m.title}”? This removes the recording and transcript.`) && void run(api.deleteMeeting(m.id))}><Trash2 size={14} /></button>
      </div>
    </article>
  );
}
