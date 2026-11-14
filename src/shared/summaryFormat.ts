import type { ActionItem, Chapter, Flashcard, Summary, TemplateId } from './types';
import { parseTime } from './text';

/**
 * Summaries are requested as plain labelled sections rather than JSON. Small on-device models
 * follow this far more reliably, and it can be shown while it is still being written.
 */
export const TEMPLATES: Record<TemplateId, { name: string; blurb: string; role: string; focus: string; actionLabel: string }> = {
  meeting: {
    name: 'Meeting',
    blurb: 'Decisions, owners and next steps',
    role: 'You are a meticulous meeting notetaker.',
    focus: 'Capture what was decided, who owns what, and anything left unresolved.',
    actionLabel: 'tasks someone agreed or was asked to do',
  },
  lecture: {
    name: 'Lecture',
    blurb: 'Study notes with flashcards',
    role: 'You are an expert study-notes writer helping a student revise.',
    focus: 'Explain the key concepts, definitions, rules, named cases or examples and why they matter. Write key points as revision notes a student can learn from.',
    actionLabel: 'reading, assignments or follow-up the lecturer set',
  },
  interview: {
    name: 'Interview',
    blurb: 'Answers, quotes and themes',
    role: 'You are a researcher writing up an interview.',
    focus: 'Capture what the interviewee said on each topic, their strongest claims and notable quotes.',
    actionLabel: 'follow-ups promised by either side',
  },
  memo: {
    name: 'Voice memo',
    blurb: 'Tidy up loose thoughts',
    role: 'You turn rambling voice notes into clear, organised notes.',
    focus: 'Organise the ideas, keeping the speaker\'s intent. Turn intentions ("I need to…") into action items.',
    actionLabel: 'things the speaker said they need or want to do',
  },
};

export function summarySystem(t: TemplateId): string {
  return `${TEMPLATES[t].role} Use only what is in the transcript. Never invent names, numbers or dates. Be specific and concise.`;
}

export function summaryInstruction(t: TemplateId): string {
  const tp = TEMPLATES[t];
  const cards = t === 'lecture' ? '\nFLASHCARDS:\n- Q: <question testing one key idea> | A: <short answer>' : '';
  return `${tp.focus}

Write the notes in EXACTLY this format. Keep every heading. One item per line starting with "- ". Write "- none" under a heading with nothing to report.

TITLE: <specific title, at most 8 words>
OVERVIEW: <2-4 sentences>
KEY POINTS:
- <point>
ACTION ITEMS:
- <owner name>: <task> (due: <when, or unspecified>)
DECISIONS:
- <decision>
OPEN QUESTIONS:
- <question>
CHAPTERS:
- [m:ss] <topic title>: <one sentence>
TOPICS: <3-6 comma separated keywords>${cards}

Action items are ${tp.actionLabel}. Chapters use the timestamps from the transcript, in order, 3 to 8 of them.${t === 'lecture' ? ' Write 5 to 10 flashcards.' : ''}`;
}

const HEADS: [RegExp, keyof Sections][] = [
  [/^title$/i, 'title'],
  [/^(overview|summary|tl;?dr)$/i, 'overview'],
  [/^key (points|concepts|takeaways)$/i, 'keyPoints'],
  [/^(action items?|actions|next steps|to-?dos?|tasks)$/i, 'actions'],
  [/^decisions?( made)?$/i, 'decisions'],
  [/^(open )?questions?$/i, 'questions'],
  [/^(chapters?|outline|timeline)$/i, 'chapters'],
  [/^(topics?|keywords?|tags)$/i, 'topics'],
  [/^flash ?cards?$/i, 'cards'],
];
type Sections = { title: string[]; overview: string[]; keyPoints: string[]; actions: string[]; decisions: string[]; questions: string[]; chapters: string[]; topics: string[]; cards: string[] };

const clean = (s: string): string => s.replace(/^\s*(?:[-*•–]|\d+[.)])(?:\s+|$)/, '').replace(/\*\*/g, '').replace(/^\[[ x]\]\s*/i, '').trim();
const isNone = (s: string): boolean => /^(none|n\/a|nothing|no .{0,30}(mentioned|identified|discussed|made|raised))\.?$/i.test(s);

export function parseAction(line: string, keep?: ActionItem): ActionItem | null {
  let text = clean(line);
  if (!text || isNone(text)) return null;
  let due: string | undefined;
  const d = text.match(/\(\s*due:?\s*([^)]*)\)\s*\.?$/i);
  if (d) {
    text = text.slice(0, d.index).trim();
    if (!/^(unspecified|none|n\/a|tbd|not specified|unknown|-)?$/i.test(d[1].trim())) due = d[1].trim();
  }
  let owner: string | undefined;
  const o = text.match(/^([A-Z][\w.'’-]*(?:\s+(?:and|&|\d+|[A-Z][\w.'’-]*)){0,3}|team|everyone|all|we|i|me)\s*:\s+(.+)$/i);
  if (o && o[1].length <= 40) {
    if (!/^(unassigned|unknown|none|n\/a|owner|tbd)$/i.test(o[1])) owner = o[1];
    text = o[2];
  }
  text = text.replace(/^(unassigned|unknown|n\/a)\s*:\s*/i, '');
  if (!text) return null;
  return { id: keep?.id ?? `a${hash(text)}`, text: text[0].toUpperCase() + text.slice(1), owner, due, done: keep?.done ?? false };
}

function parseChapter(line: string): Chapter | null {
  const text = clean(line);
  const m = text.match(/^\[?\(?(\d{1,2}(?::\d{1,3})?:\d{2})\)?\]?\s*[-–—:]?\s*(.+)$/);
  if (!m) return null;
  const t = parseTime(m[1]);
  if (t === null) return null;
  const [title, ...rest] = m[2].split(/:\s+/);
  return { t, title: title.trim(), note: rest.join(': ').trim() || undefined };
}

function parseCard(line: string): Flashcard | null {
  const m = clean(line).match(/^Q(?:uestion)?:\s*(.+?)\s*(?:\||\s—\s|\s-\s)?\s*A(?:nswer)?:\s*(.+)$/i);
  return m ? { q: m[1].trim(), a: m[2].trim() } : null;
}

const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** Tolerant parser: works on finished and half-written output alike. */
export function parseSummary(raw: string, template: TemplateId, prev?: Summary): Summary {
  const sec: Sections = { title: [], overview: [], keyPoints: [], actions: [], decisions: [], questions: [], chapters: [], topics: [], cards: [] };
  let cur: keyof Sections | null = null;
  for (const lineRaw of raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const h = line.match(/^[#*\s•–-]*([A-Za-z;?' ]{3,22}?)[*\s]*:[*\s]*(.*)$/);
    const head = h && HEADS.find(([re]) => re.test(h[1].trim()));
    if (h && head) {
      cur = head[1];
      if (h[2].trim()) sec[cur].push(h[2].trim());
      continue;
    }
    const bare = line.match(/^[#*\s•–-]+([A-Za-z ]{3,22})[*\s]*$/);
    const bareHead = bare && HEADS.find(([re]) => re.test(bare[1].trim()));
    if (bareHead) {
      cur = bareHead[1];
      continue;
    }
    if (cur) sec[cur].push(line);
  }
  const items = (k: keyof Sections) => sec[k].map(clean).filter((s) => s && !isNone(s));
  const prevActions = new Map((prev?.actions ?? []).map((a) => [a.text.toLowerCase(), a]));
  const actions: ActionItem[] = [];
  for (const l of sec.actions) {
    const a = parseAction(l);
    if (!a) continue;
    const old = prevActions.get(a.text.toLowerCase());
    actions.push(old ? { ...a, id: old.id, done: old.done } : a);
  }
  return {
    title: clean(sec.title.join(' ')).replace(/^["“]|["”]$/g, '').slice(0, 90),
    overview: sec.overview.map(clean).join(' ').trim(),
    keyPoints: items('keyPoints'),
    actions,
    decisions: items('decisions'),
    questions: items('questions'),
    chapters: sec.chapters.map(parseChapter).filter((c): c is Chapter => !!c).sort((a, b) => a.t - b.t).filter((c, i, all) => !i || c.t !== all[i - 1].t),
    topics: items('topics').join(',').split(/[,;]/).map((t) => t.trim().replace(/\.$/, '')).filter((t) => t && t.length < 40).slice(0, 8),
    cards: sec.cards.map(parseCard).filter((c): c is Flashcard => !!c),
    template,
  };
}

/** Parse "Speaker 2 = Sarah" lines; keeps only names that really occur in the transcript. */
export function parseNameHints(raw: string, speakers: { id: string; name: string; named?: boolean }[], transcript: string): Record<string, string> {
  const out: Record<string, string> = {};
  const low = transcript.toLowerCase();
  const taken = new Set(speakers.filter((s) => s.named).map((s) => s.name.toLowerCase()));
  for (const line of raw.split(/\r?\n/)) {
    const m = clean(line).match(/^(Speaker \d+)\s*(?:=|:|->|is)\s*([A-Z][A-Za-z'’-]{1,19}(?:\s[A-Z][A-Za-z'’-]{1,19})?)\.?$/);
    if (!m) continue;
    const sp = speakers.find((s) => s.name === m[1] && !s.named);
    const name = m[2].trim();
    if (!sp || /^(unknown|unclear|none|speaker|not)$/i.test(name) || taken.has(name.toLowerCase())) continue;
    if (!low.includes(name.toLowerCase()) || Object.values(out).includes(name)) continue;
    out[sp.id] = name;
  }
  return out;
}
