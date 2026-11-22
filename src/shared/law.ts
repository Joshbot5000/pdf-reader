/**
 * Legal content in a lecture transcript, found without any AI where that can be done reliably:
 * the lecturer's own emphasis, case names, and statutory references, each with the moment it was
 * said. The AI then explains them, and anything it adds that cannot be found in the transcript is
 * flagged rather than trusted.
 */
import type { Para } from './types';

// ------------------------------------------------------------------ study data (stored per lecture)

export type NoteStyle = 'detailed' | 'concise' | 'beginner' | 'exam' | 'onepage';
export const NOTE_STYLES: Record<NoteStyle, { name: string; blurb: string }> = {
  detailed: { name: 'Detailed lecture notes', blurb: 'Everything taught, organised under headings' },
  concise: { name: 'Concise revision notes', blurb: 'The essentials, ready to learn' },
  beginner: { name: 'Beginner-friendly', blurb: 'Plain English with simple examples' },
  exam: { name: 'Exam-focused', blurb: 'Rules, tests, authorities and how to apply them' },
  onepage: { name: 'One-page summary', blurb: 'The whole lecture on a page' },
};

export type CaseRef = {
  name: string; facts: string; issue: string; judgment: string; principle: string; why: string;
  /** Seconds into the lecture where it was first mentioned (-1 if it could not be found). */
  t: number;
  /** True when the case name was found in the transcript; false means the AI may have misheard or invented it. */
  found: boolean;
  uncertain?: string;
};
/** The result of looking a statute up on legislation.gov.uk. */
export type LawCheck = { status: 'verified' | 'not-found' | 'section-missing' | 'offline'; at: number; title?: string; url?: string; heading?: string; text?: string; note?: string };
export type LawRef = { name: string; section?: string; said: string; t: number; found: boolean; link: string; check?: LawCheck };
export type Emphasis = { text: string; t: number; kind: 'explicit' | 'inferred'; cue?: string };

export type Card = { id: string; front: string; back: string; kind: string; topic: string; t?: number };
export type Sbaq = { id: string; stem: string; options: string[]; answer: number; why: string[]; explanation: string; authority?: string; difficulty: Difficulty; topic: string };
export type ShortQ = { id: string; q: string; a: string; topic: string };
export type Problem = { id: string; scenario: string; issues: string[]; outline: string; topic: string };
export type Difficulty = 'easy' | 'medium' | 'hard';

export type StudyPack = {
  notes?: { style: NoteStyle; text: string; at: number; model?: string };
  legal?: { cases: CaseRef[]; laws: LawRef[]; emphasis: Emphasis[]; topics: string[]; at: number; model?: string };
  cards?: Card[];
  sbaqs?: Sbaq[];
  shortQs?: ShortQ[];
  problems?: Problem[];
};

// ------------------------------------------------------------------ lecturer emphasis

/** Phrases lecturers use when something matters. Matched in the transcript itself, so these are never invented. */
const CUES: [RegExp, string][] = [
  // Most specific first: "likely to come up in the exam, so make sure you understand it" is an exam cue.
  [/\b(likely|bound|going) to (come up|appear|be) (in|on) (the |your |an )?(exam|assessment|test)\b/i, 'Exam'],
  [/\b(exam|assessment) (question|tip|technique|favourite|favorite)s?\b/i, 'Exam'],
  [/\b(in|for) (the|your|an) exam\b/i, 'Exam'],
  [/\b(this|that|it) (is|'s) (really |very |extremely |absolutely )?(important|crucial|key|essential|vital|critical)\b/i, 'Important'],
  [/\b(really |very )?important (point|thing|distinction|case|to (remember|note|understand))\b/i, 'Important'],
  [/\b(please |do )?(remember|don'?t forget|make sure you (know|understand|remember))\b/i, 'Remember this'],
  [/\b(a |the )?(common|classic|typical|frequent) (mistake|error|misconception|pitfall|trap)\b/i, 'Common mistake'],
  [/\bstudents (often|always|frequently|tend to) (get|confuse|mix|forget|miss)\b/i, 'Common mistake'],
  [/\b(the )?key (distinction|difference|point|question|issue|test|principle) (is|here)\b/i, 'Key distinction'],
  [/\b(don'?t|do not|never) (confuse|mix up|muddle)\b/i, "Don't confuse"],
  [/\byou (need|have|must|should) (to )?(understand|know|learn|be able to)\b/i, 'You need to know'],
  [/\b(this|that) is (a )?(good|great|classic|perfect|useful) example\b/i, 'Good example'],
  [/\bif you (only )?remember (one|anything)\b/i, 'Remember this'],
  [/\b(pay (close )?attention|take note|note (that|this)|write this down)\b/i, 'Take note'],
];

const sentences = (p: Para): { text: string; t: number }[] => {
  const out: { text: string; t: number }[] = [];
  const parts = p.text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
  let wi = 0;
  for (const s of parts) {
    const n = s.split(/\s+/).filter(Boolean).length;
    out.push({ text: s.trim(), t: p.words[Math.min(wi, Math.max(0, p.words.length - 1))]?.s ?? p.s });
    wi += n;
  }
  return out;
};

/** Every sentence in which the lecturer explicitly flags importance, with when it was said. */
export function explicitEmphasis(paras: Para[]): Emphasis[] {
  const out: Emphasis[] = [];
  for (const p of paras)
    for (const s of sentences(p)) {
      const hit = CUES.find(([re]) => re.test(s.text));
      if (hit && s.text.split(/\s+/).length >= 4) out.push({ text: s.text, t: s.t, kind: 'explicit', cue: hit[1] });
    }
  return out;
}

// ------------------------------------------------------------------ cases and legislation

const CASE = /\b((?:R|Re|In re|Regina)|(?:[A-Z][A-Za-z'’&.-]+)(?: (?:[A-Z][A-Za-z'’&.-]+|of|and|&|the|de|van|von|plc|Ltd|Co|Council|Borough|Bank|Board|Authority|Trust))*)(?:\s+(?:[vV]\.?|vs\.?|versus)\s+|\s+[vV]-)((?:[A-Z][A-Za-z'’&.-]+)(?: (?:[A-Z][A-Za-z'’&.-]+|of|and|&|the|de|plc|Ltd|Co|Council|Borough|Bank|Board|Authority|Trust))*)/g;
const LEAD = new Set(['Compare', 'See', 'In', 'Following', 'Unlike', 'Like', 'Applying', 'Consider', 'Then', 'Also', 'Similarly', 'Contrast', 'Cf', 'Per', 'After', 'Before', 'Where', 'Whereas', 'Because', 'Since', 'Look', 'Take', 'Recall', 'Remember', 'From', 'As', 'Case', 'Cases', 'Both', 'So', 'And', 'But', 'Now', 'Okay', 'Here', 'Today', 'Again', 'Later', 'Under', 'With', 'Following', 'Distinguish', 'Overruling', 'Approving', 'Read', 'Think', 'Note']);
const NOT_PARTY = new Set(['I', 'We', 'You', 'He', 'She', 'They', 'It', 'This', 'That', 'So', 'And', 'But', 'The', 'A', 'An', 'In', 'On', 'At', 'If', 'When', 'Then', 'Now', 'Okay', 'Ok', 'Yes', 'No', 'Section', 'Act', 'Part', 'Chapter', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);

/** Case names in the "X v Y" form, as heard (speech-to-text writes "v" as "v", "versus" or "and"). */
export function findCaseNames(paras: Para[]): { name: string; t: number }[] {
  const seen = new Map<string, { name: string; t: number }>();
  for (const p of paras) {
    for (const m of p.text.matchAll(CASE)) {
      const [, a, b] = m;
      const first = a.split(' ').find((w) => !LEAD.has(w)) ?? '', firstB = b.split(' ')[0];
      // "and" only counts between two capitalised names that are not ordinary words.
      if (/\sand\s/.test(m[0]) && !/\sv\.?\s|versus/.test(m[0]) && (a.split(' ').length > 2 || NOT_PARTY.has(first))) continue;
      if (NOT_PARTY.has(first) || NOT_PARTY.has(firstB)) continue;
      // Sentence openers are not part of a party's name ("Compare Partridge v Crittenden").
      const partyA = a.split(' ').filter((w, i, all) => !(LEAD.has(w) && all.slice(0, i).every((x) => LEAD.has(x)))).join(' ');
      if (!partyA) continue;
      const name = `${partyA} v ${b}`.replace(/\s+/g, ' ').trim();
      const key = norm(name);
      if (!seen.has(key)) seen.set(key, { name, t: timeOf(p, m.index ?? 0) });
    }
  }
  return [...seen.values()];
}

const ACT = /\b((?:[A-Z][A-Za-z'’()-]+ )+(?:Act|Regulations|Order|Directive|Convention|Code))(?: (\d{4}))?/g;
const SECTION = /\b(?:section|sections|s\.|ss\.|sec\.)\s*(\d+[A-Z]?(?:\s*\(\s*\w+\s*\))*)(?:\s+(?:and|to|-)\s+\d+[A-Z]?)?(?:\s+of\s+(?:the\s+)?((?:[A-Z][A-Za-z'’()-]+ )+(?:Act|Regulations|Order))(?: (\d{4}))?)?/gi;

/** Statutes and sections mentioned, with when. */
export function findLegislation(paras: Para[]): { name: string; section?: string; t: number }[] {
  const out = new Map<string, { name: string; section?: string; t: number }>();
  let lastAct = '';
  for (const p of paras) {
    for (const m of p.text.matchAll(ACT)) {
      const name = `${m[1].replace(/^(The|And|Under|Of|In|By|So|Now|That|This) /, '')}${m[2] ? ` ${m[2]}` : ''}`.trim();
      if (name.split(' ').length < 2) continue;
      lastAct = name;
      const key = norm(name);
      if (!out.has(key)) out.set(key, { name, t: timeOf(p, m.index ?? 0) });
    }
    for (const m of p.text.matchAll(SECTION)) {
      const act = m[2] ? `${m[2].trim()}${m[3] ? ` ${m[3]}` : ''}` : lastAct;
      if (!act) continue;
      const section = m[1].replace(/\s+/g, '');
      const key = norm(`${act} s${section}`);
      if (!out.has(key)) out.set(key, { name: act, section, t: timeOf(p, m.index ?? 0) });
    }
  }
  return [...out.values()];
}

/** A page on legislation.gov.uk where the provision can be checked. */
export function legislationLink(name: string, section?: string): string {
  const year = name.match(/(\d{4})$/)?.[1];
  const title = name.replace(/\s*\d{4}$/, '');
  const q = new URLSearchParams({ title, ...(year ? { year } : {}) });
  return `https://www.legislation.gov.uk/search?${q}${section ? `#section-${section}` : ''}`;
}

// ------------------------------------------------------------------ keeping the AI honest

export const norm = (s: string): string => s.toLowerCase().replace(/\b(v|vs|versus|and|the|of|ltd|plc|co|re|r)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Where (if anywhere) the transcript mentions this name, and how sure that is. A case counts as
 * found if either party is heard (speech-to-text often mangles one: "Carlo v Carbolic" for Carlill);
 * `exact` says whether the first party was heard as written.
 */
export function locateName(paras: Para[], name: string): { t: number; exact: boolean } {
  const parties = name.split(/\s+(?:v\.?|vs\.?|versus)\s+|\s+v-/i).map((p) => norm(p).split(' ').filter((w) => w.length > 2 && !['company', 'limited', 'council', 'borough', 'bank'].includes(w))).filter((w) => w.length);
  if (!parties.length) return { t: -1, exact: false };
  const squash = (s: string) => s.replace(/ /g, '');
  for (let k = 0; k < parties.length; k++) {
    const words = parties[k];
    for (const p of paras) {
      const low = norm(p.text), flat = squash(low);
      if (words.every((w) => low.includes(w)) || flat.includes(squash(words.join(' ')))) return { t: timeOf(p, Math.max(0, p.text.toLowerCase().indexOf(words[0]))), exact: k === 0 };
    }
  }
  return { t: -1, exact: false };
}
export const locate = (paras: Para[], name: string): number => locateName(paras, name).t;

/** The time of the word at a character offset in a paragraph. */
function timeOf(p: Para, charAt: number): number {
  const before = p.text.slice(0, charAt).split(/\s+/).filter(Boolean).length;
  return p.words[Math.min(before, Math.max(0, p.words.length - 1))]?.s ?? p.s;
}

/** Parse a JSON object out of a model's reply (tolerating code fences or text around it). */
export function parseJson<T>(raw: string): T | null {
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = text.indexOf(open), b = text.lastIndexOf(close);
    if (a < 0 || b <= a) continue;
    try {
      return JSON.parse(text.slice(a, b + 1)) as T;
    } catch {
      /* try the other shape */
    }
  }
  return null;
}

// ------------------------------------------------------------------ practice and spaced repetition

/** How well each revision item is known. Box 0 = new or missed; 4 = solid. */
export type Practice = Record<string, { box: number; due: number; seen: number; right: number; last: number; topic: string; lecture: string }>;
const INTERVAL_DAYS = [0, 1, 3, 7, 16];

export function record(p: Practice, key: string, right: boolean, topic: string, lecture: string, now = Date.now()): void {
  const r = p[key] ?? { box: 0, due: 0, seen: 0, right: 0, last: 0, topic, lecture };
  r.seen++;
  r.last = now;
  r.topic = topic || r.topic;
  r.lecture = lecture;
  if (right) (r.right++, (r.box = Math.min(4, r.box + 1)), (r.due = now + INTERVAL_DAYS[r.box] * 864e5));
  else (r.box = 0), (r.due = now + 10 * 6e4);
  p[key] = r;
}

export type TopicState = 'strong' | 'improving' | 'needs' | 'untested';
/** Questions to the tutor on one topic before it counts as a weak spot. */
export const REPEATED = 3;

export type TopicRow = { topic: string; state: TopicState; items: number; tested: number; accuracy: number; due: number; lastPractised: number; confusing: number; asked: number; lectures: string[] };

/** One row per topic: how it is going, from practice history, "confusing" bookmarks and how often the tutor was asked about it. */
export function topicStatus(items: { key: string; topic: string; lecture: string }[], practice: Practice, confusing: Record<string, number>, now = Date.now(), asked: Record<string, number> = {}): TopicRow[] {
  const rows = new Map<string, TopicRow>();
  const row = (topic: string): TopicRow => {
    const k = topic.trim() || 'General';
    if (!rows.has(k)) rows.set(k, { topic: k, state: 'untested', items: 0, tested: 0, accuracy: 0, due: 0, lastPractised: 0, confusing: 0, asked: 0, lectures: [] });
    return rows.get(k)!;
  };
  const right = new Map<string, number>(), seen = new Map<string, number>(), boxes = new Map<string, number[]>();
  for (const it of items) {
    const r = row(it.topic);
    r.items++;
    if (!r.lectures.includes(it.lecture)) r.lectures.push(it.lecture);
    const p = practice[it.key];
    if (!p) continue;
    r.tested++;
    r.lastPractised = Math.max(r.lastPractised, p.last);
    if (p.due <= now) r.due++;
    right.set(r.topic, (right.get(r.topic) ?? 0) + p.right);
    seen.set(r.topic, (seen.get(r.topic) ?? 0) + p.seen);
    boxes.set(r.topic, [...(boxes.get(r.topic) ?? []), p.box]);
  }
  for (const [topic, n] of Object.entries(confusing)) row(topic).confusing += n;
  // Asking the tutor about a topic again and again is a sign it has not clicked yet.
  for (const [topic, n] of Object.entries(asked)) if (rows.has(topic.trim() || 'General')) row(topic).asked += n;
  for (const r of rows.values()) {
    const s = seen.get(r.topic) ?? 0;
    r.accuracy = s ? (right.get(r.topic) ?? 0) / s : 0;
    const b = boxes.get(r.topic) ?? [];
    const avgBox = b.length ? b.reduce((x, y) => x + y, 0) / b.length : 0;
    r.state = !r.tested ? 'untested' : r.accuracy >= 0.8 && avgBox >= 2.5 && r.tested >= Math.min(5, r.items) && !r.confusing && r.asked < REPEATED ? 'strong' : r.accuracy < 0.55 || r.confusing > 1 || r.asked >= REPEATED || avgBox < 1 ? 'needs' : 'improving';
  }
  const order: Record<TopicState, number> = { needs: 0, untested: 1, improving: 2, strong: 3 };
  return [...rows.values()].sort((a, b) => order[a.state] - order[b.state] || (a.tested && b.tested ? a.accuracy - b.accuracy : 0) || b.due - a.due || a.topic.localeCompare(b.topic));
}

/** A revision session: weakest first, skipping what is already known and not yet due. */
export function pickSession<T extends { key: string; topic: string }>(items: T[], practice: Practice, weak: Set<string>, n = 15, now = Date.now()): T[] {
  const score = (it: T): number => {
    const p = practice[it.key];
    if (!p) return weak.has(it.topic) ? 1 : 3; // never tried
    if (p.due > now) return 99; // not due yet: spaced repetition brings it back at the right time
    return (p.due <= now ? 0 : 5) + p.box + (weak.has(it.topic) ? -1 : 0);
  };
  return items.map((it) => ({ it, s: score(it) })).filter((x) => x.s < 99).sort((a, b) => a.s - b.s).slice(0, n).map((x) => x.it);
}

/** Anki-ready text: tab-separated front/back/tags, with a header Anki understands. */
export function ankiExport(cards: { front: string; back: string; topic?: string }[], deck: string): string {
  const clean = (s: string) => s.replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
  return ['#separator:tab', '#html:true', `#deck:${deck.replace(/[\t\n]/g, ' ')}`, '#tags column:3', ...cards.map((c) => `${clean(c.front)}\t${clean(c.back)}\t${(c.topic ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`)].join('\n');
}
