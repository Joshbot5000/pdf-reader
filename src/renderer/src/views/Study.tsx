/** Study tools for one lecture: law notes, exam focus, cases and legislation, and a revision pack. */
import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Check, Copy, Download, ExternalLink, FileText, Paperclip, Flag, GraduationCap, Layers, ListChecks, Pencil, Plus, RotateCw, Scale, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { clearStream, run, startStream, toast, useStore } from '../store';
import { Md, Spinner } from '../ui/bits';
import { fmtTime } from '../../../shared/text';
import { NOTE_STYLES, type Card, type Difficulty, type NoteStyle, type Sbaq, type StudyPack } from '../../../shared/law';
import type { Meeting } from '../../../shared/types';
import type { MaterialInfo } from '../../../shared/api';
import { uid } from '../../../shared/types';

type Seek = (t: number, play?: boolean) => void;
type Pane = 'notes' | 'exam' | 'cases' | 'revise';

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Run a generation job, showing its live progress; returns the updated pack. */
function useJob(m: Meeting, setPack: (p: StudyPack) => void) {
  const [job, setJob] = useState('');
  const stream = useStore((s) => (job ? s.streams[job] : undefined));
  const start = async (id: string, work: () => Promise<StudyPack>) => {
    startStream(id);
    setJob(id);
    try {
      setPack(await work());
    } catch (e) {
      if (!/Stopped/.test(errText(e))) toast(errText(e), 'error');
    } finally {
      setJob('');
      clearStream(id);
    }
  };
  return { busy: !!job, stream, start, stop: () => job && void api.abort(job) };
}

export function StudyTab({ m, seek }: { m: Meeting; seek: Seek }) {
  const [pack, setPack] = useState<StudyPack | null>(null);
  const [pane, setPane] = useState<Pane>('notes');
  const writing = useStore((s) => s.status.llm !== 'missing');
  // Automatic analysis runs in the background after transcription: pick up what it produced.
  const auto = useStore((s) => s.streams[`legal:${m.id}`]?.running || s.streams[`notes:${m.id}`]?.running);
  useEffect(() => void api.studyGet(m.id).then(setPack), [m.id, auto]);
  if (!pack) return <div className="center"><Spinner /></div>;
  const counts = { exam: pack.legal?.emphasis.length ?? 0, cases: (pack.legal?.cases.length ?? 0) + (pack.legal?.laws.length ?? 0), revise: (pack.cards?.length ?? 0) + (pack.sbaqs?.length ?? 0) + (pack.shortQs?.length ?? 0) + (pack.problems?.length ?? 0) };
  return (
    <div className="study">
      <div className="seg study-nav">
        <button className={pane === 'notes' ? 'on' : ''} onClick={() => setPane('notes')}><BookOpen size={13} /> Notes</button>
        <button className={pane === 'exam' ? 'on' : ''} onClick={() => setPane('exam')}><Flag size={13} /> Exam focus{counts.exam ? <i>{counts.exam}</i> : null}</button>
        <button className={pane === 'cases' ? 'on' : ''} onClick={() => setPane('cases')}><Scale size={13} /> Cases & law{counts.cases ? <i>{counts.cases}</i> : null}</button>
        <button className={pane === 'revise' ? 'on' : ''} onClick={() => setPane('revise')}><GraduationCap size={13} /> Revise{counts.revise ? <i>{counts.revise}</i> : null}</button>
      </div>
      {!writing && <p className="study-warn"><AlertTriangle size={14} /> Study tools need an AI model: add a Groq key or download a model in Settings → AI models.</p>}
      {auto && <p className="study-auto"><Spinner size={12} /> Analysing this lecture…</p>}
      {pane === 'notes' && <NotesPane m={m} pack={pack} setPack={setPack} seek={seek} />}
      {pane === 'exam' && <LegalGate m={m} pack={pack} setPack={setPack}>{(legal) => <ExamPane m={m} legal={legal} seek={seek} />}</LegalGate>}
      {pane === 'cases' && <LegalGate m={m} pack={pack} setPack={setPack}>{(legal) => <CasesPane legal={legal} seek={seek} />}</LegalGate>}
      {pane === 'revise' && <RevisePane m={m} pack={pack} setPack={setPack} seek={seek} />}
    </div>
  );
}

function Progress({ stream, label, stop }: { stream?: { text: string; stage?: string }; label: string; stop: () => void }) {
  return (
    <div className="study-progress">
      <span className="sheen"><Sparkles size={14} /> {stream?.stage ?? label}…</span>
      <button className="btn ghost small" onClick={stop}><X size={12} /> Stop</button>
    </div>
  );
}

// ------------------------------------------------------------------ notes

function NotesPane({ m, pack, setPack, seek }: { m: Meeting; pack: StudyPack; setPack: (p: StudyPack) => void; seek: Seek }) {
  const [style, setStyle] = useState<NoteStyle>(pack.notes?.style ?? 'detailed');
  const job = useJob(m, setPack);
  const go = (s: NoteStyle) => {
    const id = `snotes:${m.id}:${Date.now()}`;
    return job.start(id, () => api.studyNotes(m.id, s, id));
  };
  const notes = pack.notes;
  return (
    <>
      <Materials m={m} />
      <div className="study-bar">
        <select value={style} onChange={(e) => setStyle(e.target.value as NoteStyle)} title="Note style">
          {(Object.keys(NOTE_STYLES) as NoteStyle[]).map((s) => <option key={s} value={s}>{NOTE_STYLES[s].name}</option>)}
        </select>
        <button className="btn small primary" disabled={job.busy} onClick={() => void go(style)}>{notes ? <><RotateCw size={13} /> {notes.style === style ? 'Rewrite' : 'Write'}</> : <><Sparkles size={13} /> Write notes</>}</button>
        <span className="grow" />
        {notes && <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(notes.text).then(() => toast('Notes copied.', 'ok'))}><Copy size={13} /> Copy</button>}
        {notes && <button className="btn ghost small" title="Markdown" onClick={() => void run(api.exportStudy(m.id, 'notes'))}><Download size={13} /> .md</button>}
        {notes && <button className="btn ghost small" title="Word document" onClick={() => void run(api.exportStudy(m.id, 'notes-docx'))}><Download size={13} /> Word</button>}
        {notes && <button className="btn ghost small" title="PDF" onClick={() => void run(api.exportStudy(m.id, 'notes-pdf'))}><Download size={13} /> PDF</button>}
      </div>
      {job.busy && <Progress stream={job.stream} label="Writing the notes" stop={job.stop} />}
      {job.busy && job.stream?.text ? <div className="study-notes"><Md text={job.stream.text} onTime={(t) => seek(t, true)} /></div>
        : notes ? <div className="study-notes"><Md text={notes.text} onTime={(t) => seek(t, true)} /><p className="sum-foot dim small">{NOTE_STYLES[notes.style].name} · {notes.model ? `written by ${notes.model}` : ''} · times link to the recording. Check anything marked [check] and anything “not from the lecture”.</p></div>
        : !job.busy && <div className="empty small"><BookOpen size={22} /><p>Structured law notes from this lecture: definitions, rules, tests, cases, legislation, the lecturer's examples, exam tips and points to check. Pick a style and press <b>Write notes</b>.</p></div>}
    </>
  );
}

/** Slides and handouts attached to the lecture: the notes, case analysis and tutor read them alongside the transcript. */
function Materials({ m }: { m: Meeting }) {
  const [list, setList] = useState<MaterialInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => void api.materials(m.id).then(setList);
    load();
    const on = (e: Event) => (e as CustomEvent).detail === m.id && load();
    window.addEventListener('hark-materials', on);
    return () => window.removeEventListener('hark-materials', on);
  }, [m.id]);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.addMaterials(m.id);
      setList(r.list);
      if (r.errors.length) toast(r.errors.join(' '), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!list) return null;
  return (
    <div className="materials">
      <Paperclip size={13} className="dim" />
      {list.map((x) => (
        <span key={x.id} className="mat-chip" title={`${x.pages} ${x.kind === 'pptx' ? 'slide' : 'page'}${x.pages === 1 ? '' : 's'} · used by the notes, case analysis and tutor`}>
          <FileText size={12} /> {x.name}
          <button aria-label={`Remove ${x.name}`} onClick={() => void api.removeMaterial(m.id, x.id).then(setList)}><X size={11} /></button>
        </span>
      ))}
      <button className="btn ghost small" disabled={busy} onClick={() => void add()}>{busy ? <Spinner size={12} /> : <Plus size={13} />} {list.length ? 'Add' : 'Add slides or handout'}</button>
      {!list.length && <span className="dim small">PDF, PowerPoint or Word: helps with case spellings and structure. You can also drop files here.</span>}
    </div>
  );
}

// ------------------------------------------------------------------ cases, legislation, exam focus

function LegalGate({ m, pack, setPack, children }: { m: Meeting; pack: StudyPack; setPack: (p: StudyPack) => void; children: (legal: NonNullable<StudyPack['legal']>) => React.ReactNode }) {
  const job = useJob(m, setPack);
  const go = () => {
    const id = `slegal:${m.id}:${Date.now()}`;
    void job.start(id, () => api.studyLegal(m.id, id));
  };
  return (
    <>
      {job.busy && <Progress stream={job.stream} label="Finding cases, legislation and exam points" stop={job.stop} />}
      {pack.legal ? (
        <>
          {children(pack.legal)}
          <p className="sum-foot dim small">Found {new Date(pack.legal.at).toLocaleDateString()}{pack.legal.model ? ` by ${pack.legal.model}` : ''}. <button className="link" disabled={job.busy} onClick={go}>Analyse again</button></p>
        </>
      ) : !job.busy && (
        <div className="empty small"><Scale size={22} /><p>Find every case and statute discussed, what the lecturer said about each, and the points they flagged as important or exam-worthy.</p><button className="btn small primary" onClick={go}><Sparkles size={13} /> Analyse this lecture</button></div>
      )}
    </>
  );
}

const At = ({ t, seek }: { t: number; seek: Seek }) => (t >= 0 ? <button className="cite time" title="Play from here" onClick={() => seek(t, true)}>{fmtTime(t)}</button> : null);

function ExamPane({ m, legal, seek }: { m: Meeting; legal: NonNullable<StudyPack['legal']>; seek: Seek }) {
  const said = legal.emphasis.filter((e) => e.kind === 'explicit');
  const inferred = legal.emphasis.filter((e) => e.kind === 'inferred');
  const paras = useStore((s) => s.transcripts[m.id] ?? []);
  const tagged = paras.filter((p) => p.tag === 'exam' || p.tag === 'important');
  return (
    <div className="study-list">
      <h4>What the lecturer emphasised <span className="dim">their own words</span></h4>
      {said.length ? said.map((e, i) => <div key={i} className="emph"><span className="chip glow">{e.cue}</span><p>“{e.text}” <At t={e.t} seek={seek} /></p></div>) : <p className="dim small">No explicit cues such as “this is important” or “this will come up in the exam” were heard.</p>}
      <h4>Likely exam material <span className="dim">suggested by the AI, not said outright</span></h4>
      {inferred.length ? inferred.map((e, i) => <div key={i} className="emph inferred"><p>{e.text} <At t={e.t} seek={seek} /></p></div>) : <p className="dim small">None suggested.</p>}
      {tagged.length > 0 && (
        <>
          <h4>Your bookmarks</h4>
          {tagged.map((p) => <div key={p.id} className="emph mine"><span className="chip">{p.tag === 'exam' ? 'Exam focus' : 'Important'}</span><p>{p.text.slice(0, 240)} <At t={p.s} seek={seek} /></p></div>)}
        </>
      )}
    </div>
  );
}

function CasesPane({ legal, seek }: { legal: NonNullable<StudyPack['legal']>; seek: Seek }) {
  return (
    <div className="study-list">
      <h4>Cases <span className="dim">{legal.cases.length}</span></h4>
      {!legal.cases.length && <p className="dim small">No cases were mentioned.</p>}
      {legal.cases.map((c, i) => (
        <article key={i} className={`case ${c.found ? '' : 'unsure'}`}>
          <header><b>{c.name}</b><At t={c.t} seek={seek} /></header>
          {c.uncertain && <p className="warn-line"><AlertTriangle size={12} /> {c.uncertain}</p>}
          <dl>
            {c.facts && <><dt>Facts</dt><dd>{c.facts}</dd></>}
            {c.issue && <><dt>Issue</dt><dd>{c.issue}</dd></>}
            {c.judgment && <><dt>Decision</dt><dd>{c.judgment}</dd></>}
            {c.principle && <><dt>Principle</dt><dd>{c.principle}</dd></>}
            {c.why && <><dt>Why it was used</dt><dd>{c.why}</dd></>}
          </dl>
        </article>
      ))}
      <h4>Legislation <span className="dim">{legal.laws.length}</span></h4>
      {!legal.laws.length && <p className="dim small">No statutes or sections were mentioned.</p>}
      {legal.laws.map((l, i) => (
        <article key={i} className="case">
          <header><b>{l.name}{l.section ? `, s ${l.section}` : ''}</b><At t={l.t} seek={seek} /></header>
          {l.said && <p className="small">{l.said}</p>}
          <p className="small"><span className="chip">Not verified</span> <a href={l.link} target="_blank" rel="noreferrer">Check it on legislation.gov.uk <ExternalLink size={11} /></a></p>
        </article>
      ))}
      <p className="dim small">Everything above comes from the lecture. Case details are as the lecturer gave them; check citations and holdings against a law report before relying on them.</p>
    </div>
  );
}

// ------------------------------------------------------------------ revision

type Kind = 'cards' | 'sbaqs' | 'shortQs' | 'problems';
const KINDS: [Kind, string][] = [['cards', 'Flashcards'], ['sbaqs', 'SBAQs'], ['shortQs', 'Short answer'], ['problems', 'Problem questions']];

function RevisePane({ m, pack, setPack, seek }: { m: Meeting; pack: StudyPack; setPack: (p: StudyPack) => void; seek: Seek }) {
  const [kind, setKind] = useState<Kind>('cards');
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const job = useJob(m, setPack);
  const save = (patch: Partial<StudyPack>) => void api.studySave(m.id, patch).then(setPack);
  const go = () => {
    const id = `srev:${m.id}:${Date.now()}`;
    void job.start(id, () => api.studyRevision(m.id, kind, { count: kind === 'problems' ? Math.min(count, 3) : kind === 'sbaqs' ? Math.min(count, 8) : count, difficulty }, id));
  };
  const have = (pack[kind] as unknown[] | undefined)?.length ?? 0;
  return (
    <>
      <div className="seg study-kinds">{KINDS.map(([k, label]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{label}{(pack[k] as unknown[] | undefined)?.length ? <i>{(pack[k] as unknown[]).length}</i> : null}</button>)}</div>
      <div className="study-bar">
        <select value={count} onChange={(e) => setCount(+e.target.value)} title="How many">{[3, 5, 10, 15, 20].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        {kind !== 'cards' && <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)} title="Difficulty"><option value="easy">Easy</option><option value="medium">Exam standard</option><option value="hard">Hard</option></select>}
        <button className="btn small primary" disabled={job.busy} onClick={go}><Plus size={13} /> {have ? 'Add more' : 'Create'}</button>
        <span className="grow" />
        {kind === 'cards' && have > 0 && <button className="btn ghost small" title="Anki: File → Import" onClick={() => void run(api.exportStudy(m.id, 'anki'))}><Download size={13} /> Anki</button>}
      </div>
      {job.busy && <Progress stream={job.stream} label="Writing questions" stop={job.stop} />}
      {kind === 'cards' && <Flashcards m={m} cards={pack.cards ?? []} save={(cards) => save({ cards })} seek={seek} />}
      {kind === 'sbaqs' && (pack.sbaqs ?? []).map((q, i) => <SbaqCard key={q.id} n={i + 1} q={q} m={m} remove={() => save({ sbaqs: pack.sbaqs!.filter((x) => x.id !== q.id) })} />)}
      {kind === 'shortQs' && (pack.shortQs ?? []).map((q, i) => <Reveal key={q.id} n={i + 1} q={q.q} a={q.a} onMark={(right) => void api.practice(`${m.id}:${q.id}`, right, q.topic, m.id)} remove={() => save({ shortQs: pack.shortQs!.filter((x) => x.id !== q.id) })} />)}
      {kind === 'problems' && (pack.problems ?? []).map((p, i) => <Reveal key={p.id} n={i + 1} q={p.scenario} a={`**Issues:**\n${p.issues.map((x) => `- ${x}`).join('\n')}\n\n**Model answer outline:**\n${p.outline}`} big remove={() => save({ problems: pack.problems!.filter((x) => x.id !== p.id) })} />)}
      {!have && !job.busy && <div className="empty small"><Layers size={22} /><p>{{ cards: 'Flashcards on the definitions, cases, statutes, tests and distinctions from this lecture.', sbaqs: 'Scenario questions with five options, each explained, at the difficulty you choose.', shortQs: 'Questions to answer in your own words, with a model answer to check against.', problems: 'Realistic scenarios to advise on, with the issues and a model answer outline.' }[kind]}</p></div>}
    </>
  );
}

function Flashcards({ m, cards, save, seek }: { m: Meeting; cards: Card[]; save: (c: Card[]) => void; seek: Seek }) {
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState({ front: '', back: '' });
  const [mode, setMode] = useState<'practise' | 'list'>('practise');
  if (!cards.length) return null;
  const c = cards[Math.min(i, cards.length - 1)];
  const mark = (right: boolean) => {
    void api.practice(`${m.id}:${c.id}`, right, c.topic, m.id);
    setFlip(false);
    setI((i + 1) % cards.length);
  };
  const editing = (card: Card) => (setEdit(card.id), setDraft({ front: card.front, back: card.back }));
  return (
    <>
      <div className="seg study-kinds"><button className={mode === 'practise' ? 'on' : ''} onClick={() => setMode('practise')}>Practise</button><button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>Edit all</button></div>
      {mode === 'practise' ? (
        <div className="flash">
          <button className={`flash-card ${flip ? 'flipped' : ''}`} onClick={() => setFlip(!flip)}>
            <span className="dim small">{i + 1} of {cards.length}{c.topic ? ` · ${c.topic}` : ''}</span>
            <p>{flip ? c.back : c.front}</p>
            <span className="dim small">{flip ? 'Answer' : 'Tap to show the answer'}</span>
          </button>
          {flip ? <div className="row center-row"><button className="btn small" onClick={() => mark(false)}><X size={13} /> Didn't know it</button><button className="btn small primary" onClick={() => mark(true)}><Check size={13} /> Knew it</button>{c.t !== undefined && <button className="btn ghost small" onClick={() => seek(c.t!, true)}>Hear it</button>}</div>
            : <div className="row center-row"><button className="btn ghost small" onClick={() => (setFlip(false), setI((i + cards.length - 1) % cards.length))}>Back</button><button className="btn ghost small" onClick={() => (setFlip(false), setI((i + 1) % cards.length))}>Skip</button></div>}
        </div>
      ) : (
        <div className="study-list">
          {cards.map((card) => edit === card.id ? (
            <div key={card.id} className="card-edit">
              <textarea value={draft.front} onChange={(e) => setDraft({ ...draft, front: e.target.value })} placeholder="Front" />
              <textarea value={draft.back} onChange={(e) => setDraft({ ...draft, back: e.target.value })} placeholder="Back" />
              <div className="row"><button className="btn small primary" onClick={() => (save(cards.map((x) => (x.id === card.id ? { ...x, ...draft } : x))), setEdit(null))}>Save</button><button className="btn ghost small" onClick={() => setEdit(null)}>Cancel</button></div>
            </div>
          ) : (
            <div key={card.id} className="card-row"><div className="grow"><b>{card.front}</b><p className="dim small">{card.back}</p></div><button className="icon-btn" title="Edit" onClick={() => editing(card)}><Pencil size={13} /></button><button className="icon-btn" title="Delete" onClick={() => save(cards.filter((x) => x.id !== card.id))}><Trash2 size={13} /></button></div>
          ))}
          <button className="btn small" onClick={() => { const n: Card = { id: uid(), front: 'New question', back: 'Answer', kind: 'other', topic: '' }; save([...cards, n]); editing(n); }}><Plus size={13} /> Add a card</button>
        </div>
      )}
    </>
  );
}

function SbaqCard({ n, q, m, remove }: { n: number; q: Sbaq; m: Meeting; remove: () => void }) {
  const [pick, setPick] = useState<number | null>(null);
  const choose = (i: number) => {
    if (pick !== null) return;
    setPick(i);
    void api.practice(`${m.id}:${q.id}`, i === q.answer, q.topic, m.id);
  };
  return (
    <article className="sbaq">
      <header><span className="dim small">Question {n}{q.topic ? ` · ${q.topic}` : ''} · {q.difficulty === 'medium' ? 'exam standard' : q.difficulty}</span><button className="icon-btn" title="Delete" onClick={remove}><Trash2 size={13} /></button></header>
      <p className="stem">{q.stem}</p>
      <ol className="options">
        {q.options.map((o, i) => (
          <li key={i}>
            <button className={pick === null ? '' : i === q.answer ? 'right' : i === pick ? 'wrong' : 'other'} onClick={() => choose(i)}><b>{'ABCDE'[i]}</b> {o}</button>
            {pick !== null && q.why[i] && <p className="why small">{q.why[i]}</p>}
          </li>
        ))}
      </ol>
      {pick !== null && <div className="explain"><p><b>{pick === q.answer ? 'Correct.' : `The best answer is ${'ABCDE'[q.answer]}.`}</b> {q.explanation}</p>{q.authority && <p className="small dim">Authority: {q.authority}</p>}</div>}
    </article>
  );
}

function Reveal({ n, q, a, big, onMark, remove }: { n: number; q: string; a: string; big?: boolean; onMark?: (right: boolean) => void; remove: () => void }) {
  const [show, setShow] = useState(false);
  const [marked, setMarked] = useState(false);
  return (
    <article className={`sbaq ${big ? 'problem' : ''}`}>
      <header><span className="dim small">{big ? 'Problem' : 'Question'} {n}</span><button className="icon-btn" title="Delete" onClick={remove}><Trash2 size={13} /></button></header>
      <p className="stem">{q}</p>
      {show ? <div className="explain"><Md text={a} />{onMark && !marked && <div className="row"><span className="small dim">How did you do?</span><button className="btn small" onClick={() => (onMark(false), setMarked(true))}>Missed it</button><button className="btn small primary" onClick={() => (onMark(true), setMarked(true))}>Got it</button></div>}</div>
        : <button className="btn small" onClick={() => setShow(true)}><ListChecks size={13} /> {big ? 'Show the issues and model answer' : 'Show the answer'}</button>}
    </article>
  );
}
