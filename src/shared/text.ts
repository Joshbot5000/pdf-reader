import type { Meeting, Para, Speaker, Word } from './types';

export const fmtTime = (sec: number): string => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export const fmtDuration = (sec: number): string => {
  const m = Math.round(sec / 60);
  if (sec < 60) return `${Math.max(1, Math.round(sec))} sec`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ''}`.trim();
};

/** "1:23" / "1:02:03" -> seconds, or null. */
export const parseTime = (s: string): number | null => {
  const m = s.trim().match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
};

export const speakerName = (speakers: Speaker[], id: string): string => speakers.find((s) => s.id === id)?.name ?? 'Speaker';

/** Group word timings into sentences, so each can be fingerprinted for speaker identity. */
export function splitSentences(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?…]["')\]]?$/.test(w.t) && !/^(Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e)\.$/i.test(w.t);
    const longGap = next && next.s - w.e > 0.7;
    if (!next || endsSentence || longGap) {
      out.push(cur);
      cur = [];
    }
  }
  // Glue fragments shorter than a second onto a neighbour: too short to fingerprint reliably.
  const merged: Word[][] = [];
  for (const s of out) {
    const dur = s[s.length - 1].e - s[0].s;
    const prev = merged[merged.length - 1];
    if (prev && dur < 1 && s[0].s - prev[prev.length - 1].e < 0.5) prev.push(...s);
    else merged.push(s);
  }
  return merged;
}

export const joinWords = (words: Word[]): string => words.map((w) => w.t).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();

/** After a manual text edit, spread the new words evenly over the paragraph's time span. */
export function retime(text: string, s: number, e: number): Word[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  const total = toks.reduce((n, t) => n + t.length + 1, 0) || 1;
  let at = s;
  return toks.map((t) => {
    const d = ((t.length + 1) / total) * (e - s);
    const w = { t, s: at, e: at + d };
    at += d;
    return w;
  });
}

/** The transcript as the language model reads it: "[m:ss] Name: text". */
export function transcriptForLLM(paras: Para[], speakers: Speaker[]): string {
  return paras.map((p) => `[${fmtTime(p.s)}] ${speakerName(speakers, p.sp)}: ${p.text}`).join('\n');
}

export type IndexChunk = { s: number; e: number; text: string; paraId: string };

/** Overlap-free passages of roughly `target` words for semantic search. */
export function chunkForIndex(paras: Para[], speakers: Speaker[], target = 110): IndexChunk[] {
  const out: IndexChunk[] = [];
  let cur: IndexChunk | null = null;
  let n = 0;
  for (const p of paras) {
    const line = `${speakerName(speakers, p.sp)}: ${p.text}`;
    const wc = p.text.split(/\s+/).length;
    if (cur && n + wc > target * 1.4) {
      out.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { s: p.s, e: p.e, text: line, paraId: p.id };
      n = wc;
    } else {
      cur.text += '\n' + line;
      cur.e = p.e;
      n += wc;
    }
    if (n >= target) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const srtTime = (t: number): string => {
  const ms = Math.round(t * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function toSrt(paras: Para[], speakers: Speaker[]): string {
  const cues: string[] = [];
  let n = 1;
  for (const p of paras) {
    // Subtitle-sized cues: about 12 words each.
    const words = p.words.length ? p.words : retime(p.text, p.s, p.e);
    for (let i = 0; i < words.length; i += 12) {
      const g = words.slice(i, i + 12);
      const who = i === 0 ? `${speakerName(speakers, p.sp)}: ` : '';
      cues.push(`${n++}\n${srtTime(g[0].s)} --> ${srtTime(g[g.length - 1].e)}\n${who}${joinWords(g)}\n`);
    }
  }
  return cues.join('\n');
}

export function toText(m: Meeting, paras: Para[]): string {
  const head = `${m.title}\n${new Date(m.createdAt).toLocaleString()} · ${fmtDuration(m.duration)}\n\n`;
  return head + paras.map((p) => `${speakerName(m.speakers, p.sp)}  ${fmtTime(p.s)}\n${p.text}\n`).join('\n');
}

export function toMarkdown(m: Meeting, paras: Para[]): string {
  const L: string[] = [`# ${m.title}`, '', `*${new Date(m.createdAt).toLocaleString()} · ${fmtDuration(m.duration)} · ${m.speakers.map((s) => s.name).join(', ')}*`, ''];
  const s = m.summary;
  const list = (title: string, items: string[]) => {
    if (items.length) L.push(`## ${title}`, '', ...items.map((i) => `- ${i}`), '');
  };
  if (s) {
    if (s.overview) L.push('## Overview', '', s.overview, '');
    list('Key points', s.keyPoints);
    if (s.actions.length)
      L.push('## Action items', '', ...s.actions.map((a) => `- [${a.done ? 'x' : ' '}] ${a.owner ? `**${a.owner}:** ` : ''}${a.text}${a.due ? ` _(due ${a.due})_` : ''}`), '');
    list('Decisions', s.decisions);
    list('Open questions', s.questions);
    if (s.chapters.length) L.push('## Chapters', '', ...s.chapters.map((c) => `- \`${fmtTime(c.t)}\` **${c.title}**${c.note ? `: ${c.note}` : ''}`), '');
    if (s.cards.length) L.push('## Flashcards', '', ...s.cards.map((c) => `- **Q:** ${c.q}\n  **A:** ${c.a}`), '');
  }
  if (m.notes.trim()) L.push('## My notes', '', m.notes.trim(), '');
  L.push('## Transcript', '');
  for (const p of paras) L.push(`**${speakerName(m.speakers, p.sp)}** \`${fmtTime(p.s)}\`${p.hl ? ' ⭐' : ''}`, '', p.text, ...(p.note ? ['', `> ${p.note}`] : []), '');
  return L.join('\n');
}

/** Rough token estimate when the tokenizer is not at hand (English prose: ~3.6 chars per token). */
export const roughTokens = (s: string): number => Math.ceil(s.length / 3.6);

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Print-ready HTML (used for PDF export). */
export function toHtml(m: Meeting, paras: Para[]): string {
  const s = m.summary;
  const list = (title: string, items: string[]) => (items.length ? `<h2>${title}</h2><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
  const body = [
    `<h1>${esc(m.title)}</h1>`,
    `<p class="meta">${esc(new Date(m.createdAt).toLocaleString())} · ${fmtDuration(m.duration)} · ${esc(m.speakers.map((x) => x.name).join(', '))}</p>`,
    s?.overview ? `<h2>Overview</h2><p>${esc(s.overview)}</p>` : '',
    s ? list('Key points', s.keyPoints) : '',
    s?.actions.length ? `<h2>Action items</h2><ul class="tasks">${s.actions.map((a) => `<li>${a.done ? '☑' : '☐'} ${a.owner ? `<b>${esc(a.owner)}:</b> ` : ''}${esc(a.text)}${a.due ? ` <i>(due ${esc(a.due)})</i>` : ''}</li>`).join('')}</ul>` : '',
    s ? list('Decisions', s.decisions) : '',
    s ? list('Open questions', s.questions) : '',
    s?.chapters.length ? `<h2>Chapters</h2><ul>${s.chapters.map((c) => `<li><code>${fmtTime(c.t)}</code> <b>${esc(c.title)}</b>${c.note ? `: ${esc(c.note)}` : ''}</li>`).join('')}</ul>` : '',
    s?.cards.length ? `<h2>Flashcards</h2><ul>${s.cards.map((c) => `<li><b>${esc(c.q)}</b><br>${esc(c.a)}</li>`).join('')}</ul>` : '',
    m.notes.trim() ? `<h2>My notes</h2><p>${esc(m.notes.trim()).replace(/\n/g, '<br>')}</p>` : '',
    '<h2>Transcript</h2>',
    ...paras.map((p) => `<div class="turn"><div class="who">${esc(speakerName(m.speakers, p.sp))} <code>${fmtTime(p.s)}</code></div><p${p.hl ? ' class="hl"' : ''}>${esc(p.text)}</p>${p.note ? `<blockquote>${esc(p.note)}</blockquote>` : ''}</div>`),
  ].join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:11pt/1.55 -apple-system,"Helvetica Neue",Arial,sans-serif;color:#16181d;margin:0}
    h1{font:600 22pt Georgia,serif;margin:0 0 4pt} h2{font:600 12pt sans-serif;margin:18pt 0 6pt;color:#4b3fd1}
    .meta{color:#666;margin:0 0 12pt} ul{padding-left:16pt;margin:0} li{margin:3pt 0} .tasks{list-style:none;padding:0}
    code{font:9pt ui-monospace,Menlo,monospace;color:#777} .turn{margin:0 0 9pt;break-inside:avoid} .who{font-weight:600;font-size:10pt}
    .turn p{margin:1pt 0 0} .hl{background:#fff3b8} blockquote{margin:3pt 0 0 10pt;color:#555;border-left:2pt solid #ccc;padding-left:6pt}
  </style></head><body>${body}</body></html>`;
}
