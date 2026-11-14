import { useMemo, useState } from 'react';
import { CalendarClock, Check, ListChecks } from 'lucide-react';
import { api } from '../api';
import { go, run, useStore } from '../store';
import { dayLabel } from '../ui/bits';
import type { ActionItem, Meeting } from '../../../shared/types';

export const toggleAction = (m: Meeting, a: ActionItem): void => {
  if (!m.summary) return;
  void run(api.setSummary(m.id, { ...m.summary, actions: m.summary.actions.map((x) => (x.id === a.id ? { ...x, done: !x.done } : x)) }));
};

export function Tasks() {
  const meetings = useStore((s) => s.meetings);
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const groups = useMemo(() => meetings.filter((m) => m.summary?.actions.length).map((m) => ({ m, items: m.summary!.actions.filter((a) => filter === 'all' || (filter === 'done') === a.done) })).filter((g) => g.items.length), [meetings, filter]);
  const total = useMemo(() => meetings.reduce((n, m) => n + (m.summary?.actions.length ?? 0), 0), [meetings]);
  const done = useMemo(() => meetings.reduce((n, m) => n + (m.summary?.actions.filter((a) => a.done).length ?? 0), 0), [meetings]);
  return (
    <div className="page tasks">
      <header className="page-head">
        <div><p className="eyebrow">{done} of {total} done</p><h1>Action items</h1></div>
        <div className="seg">
          {(['open', 'done', 'all'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}
        </div>
      </header>
      {total > 0 && <div className="meter"><span style={{ width: `${(done / total) * 100}%` }} /></div>}
      {!groups.length ? (
        <section className="empty"><ListChecks size={30} /><h3>{total ? (filter === 'open' ? 'All caught up' : 'Nothing here') : 'No action items yet'}</h3><p>Hark pulls out every task, who owns it and when it is due, from each conversation it summarises.</p></section>
      ) : (
        groups.map(({ m, items }) => (
          <section key={m.id} className="task-group">
            <h4 onClick={() => go({ name: 'meeting', id: m.id })}>{m.title}<span>{dayLabel(m.createdAt)}</span></h4>
            {items.map((a) => (
              <label key={a.id} className={`task ${a.done ? 'done' : ''}`}>
                <button className="check" onClick={() => toggleAction(m, a)}>{a.done && <Check size={13} strokeWidth={3} />}</button>
                <span className="task-text">{a.text}</span>
                {a.owner && <span className="chip">{a.owner}</span>}
                {a.due && <span className="chip due"><CalendarClock size={11} /> {a.due}</span>}
              </label>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
