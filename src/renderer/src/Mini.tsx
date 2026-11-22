/** The floating live-transcript window: stays on top of other apps while a lecture is recorded. */
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Maximize2, Square } from 'lucide-react';
import type { Meeting, Para } from '../../shared/types';
import { fmtTime } from '../../shared/text';

export function Mini() {
  const [m, setM] = useState<Meeting | null>(null);
  const [paras, setParas] = useState<Para[]>([]);
  const [partial, setPartial] = useState('');
  const [, tick] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    void window.hark.call('listMeetings').then((list) => setM((list as Meeting[]).find((x) => x.status === 'recording') ?? null));
    const offs = [
      window.hark.on('meeting', (x) => setM((cur) => (x.status === 'recording' ? x : cur?.id === x.id ? x : cur))),
      window.hark.on('live', (e) => {
        if (e.type === 'partial') setPartial(e.text);
        else if (e.type === 'paras') {
          setPartial('');
          setParas((cur) => (e.replace ? e.paras : [...cur.filter((p) => !e.paras.some((q) => q.id === p.id)), ...e.paras].sort((a, b) => a.s - b.s)));
        }
      }),
    ];
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => (offs.forEach((f) => f()), clearInterval(t));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [paras, partial]);
  const live = m?.status === 'recording';
  return (
    <div className="mini">
      <header className="mini-head">
        <span className={`rec-dot ${live ? '' : 'off'}`} />
        <b className="mono">{live ? fmtTime((Date.now() - m!.createdAt) / 1000) : 'Not recording'}</b>
        <span className="grow mini-drag" />
        {live && <button title="Bookmark this moment" onClick={() => void window.hark.call('miniCommand', 'bookmark')}><Bookmark size={14} /></button>}
        {live && <button title="Stop recording" className="stop" onClick={() => void window.hark.call('miniCommand', 'stop-record')}><Square size={12} fill="currentColor" /></button>}
        <button title="Open Hark" onClick={() => void window.hark.call('miniCommand', 'show')}><Maximize2 size={13} /></button>
      </header>
      <div className="mini-feed">
        {paras.slice(-6).map((p) => <p key={p.id}><span className="mono">{fmtTime(p.s)}</span> {p.text}</p>)}
        {partial && <p className="partial">{partial}</p>}
        {!paras.length && !partial && <p className="dim">{live ? 'Listening… the transcript appears here as it is written.' : 'Start a recording and its transcript shows here.'}</p>}
        <div ref={end} />
      </div>
    </div>
  );
}
