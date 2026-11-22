/** Across all lectures: what you know, what you don't, a revision session weakest-first, and the case bank. */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Download, GraduationCap, Play, Scale, Search, X } from 'lucide-react';
import { api } from '../api';
import { go, run, useStore } from '../store';
import { Spinner, dayLabel } from '../ui/bits';
import { fmtTime } from '../../../shared/text';
import type { RevisionItem, RevisionOverview } from '../../../shared/api';
import type { CaseRef, TopicState } from '../../../shared/law';

const STATE: Record<TopicState, [string, string]> = { needs: ['Needs revision', 'bad'], untested: ['Not yet tested', 'none'], improving: ['Improving', 'mid'], strong: ['Strong', 'good'] };
const ago = (t: number): string => {
  if (!t) return 'never';
  const d = Math.floor((Date.now() - t) / 864e5);
  return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

export function ReviseView() {
  const [o, setO] = useState<RevisionOverview | null>(null);
  const [session, setSession] = useState<RevisionItem[] | null>(null);
  const load = () => void api.revisionOverview().then(setO);
  useEffect(load, []);
  if (!o) return <div className="center"><Spinner /></div>;
  if (session) return <Session items={session} done={() => (setSession(null), load())} />;
  return (
    <div className="page revise">
      <header className="page-head">
        <div><p className="eyebrow">{o.totals.items} questions and flashcards across {o.totals.lectures} lecture{o.totals.lectures === 1 ? '' : 's'}</p><h1>Revision</h1></div>
        <div className="row">
          {o.totals.items > 0 && <button className="btn ghost" onClick={() => void run(api.exportStudy('', 'all-anki'))}><Download size={15} /> All flashcards to Anki</button>}
          <button className="btn primary" disabled={!o.session.length} onClick={() => setSession(o.session)}><Play size={15} /> {o.session.length ? `Revise now (${o.session.length})` : 'Nothing due'}</button>
        </div>
      </header>
      {!o.totals.items ? (
        <section className="empty"><GraduationCap size={30} /><h3>Nothing to revise yet</h3><p>Open a lecture, go to <b>Study → Revise</b>, and create flashcards or questions. Your results here show what you know and what needs work, and each session picks your weakest material first.</p></section>
      ) : (
        <>
          <p className="lead">A session gives you what is due under spaced repetition and your weakest topics first, and skips what you already know until it is due again.</p>
          <div className="topics">
            {o.topics.map((t) => (
              <div key={t.topic} className={`topic ${STATE[t.state][1]}`}>
                <b>{t.topic}</b>
                <span className="chip">{STATE[t.state][0]}</span>
                <p className="dim small">{t.tested ? `${Math.round(t.accuracy * 100)}% right · ` : ''}{t.tested}/{t.items} tried · practised {ago(t.lastPractised)}{t.due ? ` · ${t.due} due` : ''}{t.confusing ? ` · ${t.confusing} marked confusing` : ''}</p>
              </div>
            ))}
          </div>
        </>
      )}
      {o.totals.untestedLectures.length > 0 && (
        <section className="task-group"><h4>Never tested yourself on</h4>{o.totals.untestedLectures.map((l) => <button key={l.id} className="link-row" onClick={() => go({ name: 'meeting', id: l.id, tab: 'study' })}>{l.title}</button>)}</section>
      )}
      {o.confusing.length > 0 && (
        <section className="task-group">
          <h4>Passages you marked confusing</h4>
          {o.confusing.map((c) => <button key={c.paraId} className="link-row" onClick={() => go({ name: 'meeting', id: c.meetingId, t: c.t })}><b>{c.title} · {fmtTime(c.t)}</b><span className="dim">{c.text}</span></button>)}
        </section>
      )}
    </div>
  );
}

function Session({ items, done }: { items: RevisionItem[]; done: () => void }) {
  const [i, setI] = useState(0);
  const [show, setShow] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const it = items[i];
  const next = (right: boolean) => {
    void api.practice(it.key, right, it.topic, it.lectureId);
    if (right) setScore((s) => s + 1);
    setShow(false);
    setPick(null);
    setI(i + 1);
  };
  if (!it)
    return (
      <div className="page revise"><section className="empty"><Check size={30} /><h3>Session complete: {score} of {items.length}</h3><p>Missed items come back in a few minutes; the rest return as they fall due.</p><button className="btn primary" onClick={done}>Back to revision</button></section></div>
    );
  return (
    <div className="page revise session">
      <header className="page-head"><div><p className="eyebrow">{i + 1} of {items.length} · {it.topic} · {it.lecture}</p><h1>Revision session</h1></div><button className="btn ghost" onClick={done}><X size={15} /> End</button></header>
      <div className="meter"><span style={{ width: `${(i / items.length) * 100}%` }} /></div>
      {it.kind === 'sbaq' && it.sbaq ? (
        <article className="sbaq">
          <p className="stem">{it.sbaq.stem}</p>
          <ol className="options">{it.sbaq.options.map((o, k) => <li key={k}><button className={pick === null ? '' : k === it.sbaq!.answer ? 'right' : k === pick ? 'wrong' : 'other'} onClick={() => pick === null && setPick(k)}><b>{'ABCDE'[k]}</b> {o}</button>{pick !== null && it.sbaq!.why[k] && <p className="why small">{it.sbaq!.why[k]}</p>}</li>)}</ol>
          {pick !== null && <div className="explain"><p><b>{pick === it.sbaq.answer ? 'Correct.' : `The best answer is ${'ABCDE'[it.sbaq.answer]}.`}</b> {it.sbaq.explanation}</p><button className="btn small primary" onClick={() => next(pick === it.sbaq!.answer)}>Next</button></div>}
        </article>
      ) : (
        <article className="flash">
          <div className={`flash-card ${show ? 'flipped' : ''}`}><span className="dim small">{it.kind === 'card' ? 'Flashcard' : 'Short answer'}</span><p>{show ? (it.back ?? it.a) : (it.front ?? it.q)}</p></div>
          {show ? <div className="row center-row"><button className="btn" onClick={() => next(false)}><X size={14} /> Didn't know it</button><button className="btn primary" onClick={() => next(true)}><Check size={14} /> Knew it</button></div> : <div className="row center-row"><button className="btn primary" onClick={() => setShow(true)}>Show the answer</button></div>}
        </article>
      )}
    </div>
  );
}

export function CasesView() {
  const [all, setAll] = useState<{ c: CaseRef; meetingId: string; title: string; date: number }[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => void api.caseBank().then(setAll), []);
  const groups = useMemo(() => {
    const by = new Map<string, { name: string; uses: NonNullable<typeof all> }>();
    for (const x of all ?? []) {
      const key = x.c.name.toLowerCase().replace(/\b(v|vs|versus|ltd|co|plc|company)\b|[^a-z0-9]+/g, '');
      if (!by.has(key)) by.set(key, { name: x.c.name, uses: [] });
      by.get(key)!.uses.push(x);
    }
    const query = q.trim().toLowerCase();
    return [...by.values()]
      .filter((g) => !query || g.name.toLowerCase().includes(query) || g.uses.some((u) => `${u.c.principle} ${u.c.facts} ${u.title}`.toLowerCase().includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, q]);
  if (!all) return <div className="center"><Spinner /></div>;
  return (
    <div className="page cases-page">
      <header className="page-head"><div><p className="eyebrow">{groups.length} case{groups.length === 1 ? '' : 's'} across your lectures</p><h1>Case bank</h1></div></header>
      <label className="find"><Search size={15} /><input value={q} placeholder="Search cases, principles, facts or lectures" onChange={(e) => setQ(e.target.value)} /></label>
      {!all.length && <section className="empty"><Scale size={30} /><h3>No cases yet</h3><p>Cases are collected when a lecture is analysed (automatically for lectures, or from <b>Study → Cases & law</b>).</p></section>}
      <div className="study-list">
        {groups.map((g) => {
          const best = g.uses.find((u) => u.c.principle) ?? g.uses[0];
          return (
            <article key={g.name} className={`case ${g.uses.some((u) => u.c.found) ? '' : 'unsure'}`}>
              <header><b>{g.name}</b><span className="dim small">{g.uses.length} lecture{g.uses.length === 1 ? '' : 's'}</span></header>
              {!g.uses.some((u) => u.c.found) && <p className="warn-line"><AlertTriangle size={12} /> Not found word for word in any transcript: check the name.</p>}
              <dl>
                {best.c.facts && <><dt>Facts</dt><dd>{best.c.facts}</dd></>}
                {best.c.principle && <><dt>Principle</dt><dd>{best.c.principle}</dd></>}
              </dl>
              {g.uses.map((u, i) => <button key={i} className="link-row" onClick={() => go({ name: 'meeting', id: u.meetingId, t: u.c.t >= 0 ? u.c.t : undefined })}><b>{u.title}</b><span className="dim">{dayLabel(u.date)}{u.c.t >= 0 ? ` · ${fmtTime(u.c.t)}` : ''}{u.c.why ? ` · ${u.c.why}` : ''}</span></button>)}
            </article>
          );
        })}
      </div>
    </div>
  );
}
