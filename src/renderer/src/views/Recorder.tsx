import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Pause, Play, Sparkles, Square, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { clearStream, go, startStream, useStore } from '../store';
import { bookmark, discardRecording, levels, stopRecording, togglePause } from '../recorder';
import { Avatar, Md, Orb, Spinner, colorOf } from '../ui/bits';
import { fmtTime } from '../../../shared/text';

export function Recorder() {
  const rec = useStore((s) => s.rec);
  const paras = useStore((s) => (rec ? s.transcripts[rec.id] : undefined)) ?? [];
  const speakers = useStore((s) => (rec ? s.liveSpeakers[rec.id] : undefined)) ?? [];
  const partial = useStore((s) => (rec ? s.partial[rec.id] : '')) ?? '';
  const asr = useStore((s) => s.status.asr);
  const llm = useStore((s) => s.status.llm);
  const catchStream = useStore((s) => (rec ? s.streams[`catch:${rec.id}`] : undefined));
  const [stopping, setStopping] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const words = useMemo(() => paras.reduce((n, p) => n + p.words.length, 0), [paras]);

  useEffect(() => {
    if (!rec && !stopping) go({ name: 'home' });
  }, [rec, stopping]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [paras, partial]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        bookmark();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  if (!rec) return <div className="page center"><Spinner size={22} /></div>;

  const catchUp = () => {
    const id = `catch:${rec.id}`;
    startStream(id);
    void api.catchUp(rec.id, id).catch(() => undefined);
  };
  const state = rec.paused ? 'Paused' : asr === 'loading' ? 'Waking the speech engine…' : 'Listening';

  return (
    <div className="recorder">
      <div className="rec-stage">
        <div className={`rec-orb ${rec.paused ? 'paused' : ''}`}><Orb size={380} levels={levels} intensity={1.3} /></div>
        <p className="rec-state"><span className={`rec-dot ${rec.paused ? 'off' : ''}`} /> {state}</p>
        <p className="rec-time mono">{fmtTime(rec.elapsed)}</p>
        <p className="rec-sub">{words.toLocaleString()} words · {speakers.length || 1} {speakers.length > 1 ? 'voices' : 'voice'}{rec.system ? ' · mic + computer audio' : ''}</p>
        <div className="rec-controls">
          <button className="round" onClick={togglePause} title={rec.paused ? 'Resume' : 'Pause'}>{rec.paused ? <Play size={20} /> : <Pause size={20} />}</button>
          <button className="round stop" disabled={stopping} title="Stop and write notes" onClick={() => { setStopping(true); void stopRecording(); }}>{stopping ? <Spinner size={22} /> : <Square size={22} fill="currentColor" />}</button>
          <button className="round" onClick={bookmark} title="Bookmark this moment (⌘B)"><Bookmark size={20} /></button>
        </div>
        <div className="rec-extra">
          <button className="btn ghost small" disabled={llm === 'missing' || !paras.length || catchStream?.running} onClick={catchUp} title={llm === 'missing' ? 'Needs an AI model (Settings)' : 'Summarise the last few minutes'}><Sparkles size={14} /> Catch me up</button>
          <button className="btn ghost small danger" onClick={() => confirm('Discard this recording? Nothing will be saved.') && void discardRecording()}><Trash2 size={14} /> Discard</button>
        </div>
        {catchStream && (
          <div className="catch">
            <header><Sparkles size={14} /> The last few minutes {catchStream.running && <Spinner size={12} />}<button className="icon-btn" onClick={() => clearStream(`catch:${rec.id}`)}><X size={14} /></button></header>
            {catchStream.error ? <p className="err-text">{catchStream.error}</p> : <Md text={catchStream.text || '…'} />}
          </div>
        )}
      </div>
      <div className="rec-feed" ref={scroller}>
        {!paras.length && !partial && (
          <div className="rec-hint">
            <h3>Start talking.</h3>
            <p>Words appear here as they are spoken. Each new voice gets its own colour, and voices you have named before are recognised automatically.</p>
            <p className="dim">Everything is processed on this computer. Nothing is uploaded, ever.</p>
          </div>
        )}
        {paras.map((p) => {
          const sp = speakers.find((s) => s.id === p.sp);
          return (
            <div className="turn live" key={p.id}>
              <Avatar sp={sp} size={30} />
              <div>
                <p className="turn-head"><b style={{ color: colorOf(sp) }}>{sp?.name ?? 'Speaker'}</b><span className="mono">{fmtTime(p.s)}</span></p>
                <p className="turn-text">{p.text}</p>
              </div>
            </div>
          );
        })}
        {partial && <div className="turn live partial"><span className="pulse" /><p className="turn-text">{partial}</p></div>}
      </div>
    </div>
  );
}
