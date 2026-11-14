import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Square, Trash2 } from 'lucide-react';
import { api } from '../api';
import { clearStream, go, set, startStream, toast, useStore } from '../store';
import { Md, Spinner, dayLabel } from '../ui/bits';
import { fmtTime } from '../../../shared/text';
import type { ChatMsg, Source } from '../../../shared/types';

export function Sources({ sources, text }: { sources?: Source[]; text?: string }) {
  // Once the answer is written, show only the moments it actually cites.
  const cited = text ? sources?.filter((s) => text.includes(`[${s.n}]`)) : undefined;
  if (cited?.length) sources = cited;
  if (!sources?.length) return null;
  return (
    <div className="sources">
      {sources.map((s) => (
        <button key={s.n} onClick={() => go({ name: 'meeting', id: s.meetingId, t: s.t })}>
          <i>{s.n}</i><span>{s.title}</span><em className="mono">{fmtTime(s.t)}</em>
        </button>
      ))}
    </div>
  );
}

export function Ask() {
  const msgs = useStore((s) => s.ask);
  const stream = useStore((s) => s.streams.ask);
  const meetings = useStore((s) => s.meetings);
  const llm = useStore((s) => s.status.llm);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const openSource = (s: Source) => go({ name: 'meeting', id: s.meetingId, t: s.t });

  const send = async (text: string) => {
    text = text.trim();
    if (!text || pending) return;
    if (llm === 'missing') return void set({ settingsOpen: 'models' });
    setQ('');
    setPending(text);
    startStream('ask');
    try {
      const reply = await api.ask(text, 'ask');
      const user: ChatMsg = { id: `u${Date.now()}`, role: 'user', text, at: Date.now() };
      set((s) => ({ ask: [...s.ask, user, reply] }));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPending(null);
      clearStream('ask');
    }
  };
  useEffect(() => {
    const seeded = sessionStorage.getItem('hark.ask');
    if (seeded) {
      sessionStorage.removeItem('hark.ask');
      void send(seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs, stream?.text, pending]);

  const ideas = useMemo(() => {
    const topic = meetings.find((m) => m.summary?.topics.length)?.summary?.topics[0];
    return ['What did I agree to do, and by when?', 'What decisions were made recently?', topic ? `Remind me what was said about ${topic}` : 'What were the main topics this week?', 'What questions are still unanswered?'];
  }, [meetings]);

  return (
    <div className="page ask">
      <header className="page-head">
        <div><p className="eyebrow">Across {meetings.length} conversation{meetings.length === 1 ? '' : 's'}</p><h1>Ask Hark</h1></div>
        {!!msgs.length && <button className="btn ghost small" onClick={() => void api.clearAsk().then(() => set({ ask: [] }))}><Trash2 size={14} /> Clear</button>}
      </header>
      <div className="chat-scroll">
        {!msgs.length && !pending && (
          <div className="ask-empty">
            <span className="ask-glyph"><Sparkles size={26} /></span>
            <h2>Everything you have heard, one question away.</h2>
            <p>Hark searches every conversation by meaning, then answers with links to the exact moments.</p>
            <div className="ideas">{ideas.map((i) => <button key={i} onClick={() => void send(i)}>{i}</button>)}</div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? <><Md text={m.text} sources={m.sources} onSource={openSource} /><Sources sources={m.sources} text={m.text} /></> : m.text}
          </div>
        ))}
        {pending && (
          <>
            <div className="msg user">{pending}</div>
            <div className="msg assistant">
              {stream?.text ? <Md text={stream.text} sources={stream.sources} onSource={openSource} /> : <p className="thinking"><Spinner /> {stream?.sources ? `Reading ${stream.sources.length} moments…` : 'Searching your conversations…'}</p>}
              <Sources sources={stream?.sources} />
            </div>
          </>
        )}
        <div ref={end} />
      </div>
      <div className="composer">
        <textarea rows={1} value={q} placeholder={llm === 'missing' ? 'Download an AI model in Settings to ask questions' : 'Ask anything about your conversations…'} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(q); } }} autoFocus />
        {pending ? <button className="send stop" onClick={() => void api.abort('ask')} title="Stop"><Square size={13} fill="currentColor" /></button> : <button className="send" disabled={!q.trim()} onClick={() => void send(q)}><ArrowUp size={16} /></button>}
      </div>
    </div>
  );
}
