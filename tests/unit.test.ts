import { describe, expect, it } from 'vitest';
import { Segmenter, PeakMeter } from '../src/shared/vad';
import { SpeakerBook, cosine, normalize } from '../src/shared/speakers';
import { parseAction, parseNameHints, parseSummary } from '../src/shared/summaryFormat';
import { chunkForIndex, fmtTime, joinWords, parseTime, retime, splitSentences, toMarkdown, toSrt } from '../src/shared/text';
import type { Meeting, Para } from '../src/shared/types';

const SR = 16000;
const tone = (sec: number, amp: number) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i * 0.2) * (0.6 + 0.4 * Math.sin(i * 0.013)));
const noise = (sec: number, amp: number) => Float32Array.from({ length: Math.round(sec * SR) }, () => (Math.random() * 2 - 1) * amp);
const feed = (seg: Segmenter, audio: Float32Array, chunk = 1777) => {
  const out = [];
  for (let i = 0; i < audio.length; i += chunk) out.push(...seg.push(audio.subarray(i, i + chunk)));
  return out;
};
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe('Segmenter', () => {
  it('cuts utterances at pauses with accurate timing', () => {
    const seg = new Segmenter();
    const out = feed(seg, concat(noise(1, 0.001), tone(2, 0.2), noise(1.2, 0.001), tone(3, 0.2), noise(1, 0.001)));
    expect(out).toHaveLength(2);
    expect(out[0].start).toBeGreaterThan(0.6);
    expect(out[0].start).toBeLessThan(1.05);
    expect(out[0].end).toBeGreaterThan(2.9);
    expect(out[0].end).toBeLessThan(3.5);
    expect(out[1].start).toBeGreaterThan(3.8);
    expect(out[1].pcm.length).toBeCloseTo((out[1].end - out[1].start) * SR, -2);
  });
  it('ignores clicks and silence', () => {
    const seg = new Segmenter();
    expect(feed(seg, concat(noise(2, 0.001), tone(0.1, 0.3), noise(2, 0.001)))).toHaveLength(0);
    expect(seg.flush()).toHaveLength(0);
  });
  it('splits non-stop speech at the quietest point and loses no audio', () => {
    const seg = new Segmenter({ maxLen: 10 });
    const audio = concat(tone(8, 0.2), tone(0.3, 0.02), tone(9, 0.2), tone(0.3, 0.02), tone(6, 0.2));
    const out = [...feed(seg, audio), ...seg.flush()];
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const s of out) expect(s.end - s.start).toBeLessThanOrEqual(10.1);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end, 1);
    expect(out[0].end).toBeGreaterThan(7.9);
    expect(out[0].end).toBeLessThan(8.4);
  });
  it('adapts when the room gets noisier', () => {
    const seg = new Segmenter();
    const out = [...feed(seg, concat(noise(1, 0.001), noise(12, 0.03), tone(2, 0.4), noise(2, 0.03))), ...seg.flush()];
    const last = out[out.length - 1];
    expect(last.end - last.start).toBeLessThan(6);
    expect(last.end).toBeGreaterThan(14.5);
  });
  it('exposes the utterance in progress and flushes it', () => {
    const seg = new Segmenter();
    feed(seg, concat(noise(0.5, 0.001), tone(1.5, 0.2)));
    expect(seg.pending()!.end - seg.pending()!.start).toBeGreaterThan(1.2);
    expect(seg.flush()).toHaveLength(1);
    expect(seg.pending()).toBeNull();
  });
  it('compacts peaks', () => {
    const pm = new PeakMeter(100);
    pm.push(tone(10, 0.5));
    expect(pm.compact(50)).toHaveLength(50);
    expect(Math.max(...pm.compact(50))).toBeGreaterThan(0.3);
  });
});

const vec = (seed: number, jitter = 0) => {
  const v = new Float32Array(64);
  let x = seed * 9973;
  for (let i = 0; i < 64; i++) { x = (x * 1103515245 + 12345) % 2147483648; v[i] = x / 2147483648 - 0.5 + (Math.random() - 0.5) * jitter; }
  return normalize(v);
};

describe('SpeakerBook', () => {
  it('groups voices and creates new speakers', () => {
    const b = new SpeakerBook();
    const ids = [vec(1), vec(2), vec(1, 0.3), vec(3), vec(2, 0.3), vec(1, 0.3)].map((v) => b.assign(v, 4));
    expect(ids).toEqual(['S1', 'S2', 'S1', 'S3', 'S2', 'S1']);
    expect(cosine(b.centroid('S1')!, vec(1))).toBeGreaterThan(0.8);
  });
  it('does not create speakers from short clips', () => {
    const b = new SpeakerBook();
    b.assign(vec(1), 4);
    expect(b.assign(vec(7), 0.8)).toBeNull();
    expect(b.assign(vec(1, 0.3), 0.8)).toBe('S1');
    expect(b.clusters).toHaveLength(1);
  });
  it('refine merges duplicates and folds strays', () => {
    const b = new SpeakerBook();
    b.clusters.push({ id: 'S1', sum: vec(1), n: 5, dur: 30 }, { id: 'S2', sum: vec(1, 0.5), n: 3, dur: 12 }, { id: 'S3', sum: vec(5), n: 4, dur: 20 });
    const map = b.refine();
    expect(map.get('S2')).toBe('S1');
    expect(b.clusters.map((c) => c.id)).toEqual(['S1', 'S3']);
  });
});

describe('summary parsing', () => {
  const raw = `TITLE: Mobile App Launch & Onboarding Review
OVERVIEW: The team reviewed onboarding. They moved the launch.
**KEY POINTS:**
- Completion rate rose from 58% to 71%
* Billing tickets dropped 12%
ACTION ITEMS:
- George: Investigate password reset delay (due: Friday)
- Sarah and George: write the beta plan (due: unspecified)
- Speaker 1: Review numbers
- Update the roadmap document
DECISIONS:
- Launch moved to 17 March
OPEN QUESTIONS:
- none
## Chapters
- [0:00] Intro: Kick-off and agenda
- 0:13 Onboarding results
- [1:02:05] Wrap up
TOPICS: onboarding, launch date, beta
FLASHCARDS:
- Q: What was the new completion rate? | A: 71%`;
  it('parses every section', () => {
    const s = parseSummary(raw, 'lecture');
    expect(s.title).toBe('Mobile App Launch & Onboarding Review');
    expect(s.overview).toMatch(/moved the launch/);
    expect(s.keyPoints).toHaveLength(2);
    expect(s.actions.map((a) => [a.owner, a.text, a.due])).toEqual([
      ['George', 'Investigate password reset delay', 'Friday'],
      ['Sarah and George', 'Write the beta plan', undefined],
      ['Speaker 1', 'Review numbers', undefined],
      [undefined, 'Update the roadmap document', undefined],
    ]);
    expect(s.decisions).toEqual(['Launch moved to 17 March']);
    expect(s.questions).toEqual([]);
    expect(s.chapters.map((c) => [c.t, c.title, c.note])).toEqual([[0, 'Intro', 'Kick-off and agenda'], [13, 'Onboarding results', undefined], [3725, 'Wrap up', undefined]]);
    expect(s.topics).toEqual(['onboarding', 'launch date', 'beta']);
    expect(s.cards).toEqual([{ q: 'What was the new completion rate?', a: '71%' }]);
  });
  it('handles half-written output and keeps ticked actions', () => {
    const partial = parseSummary(raw.slice(0, raw.indexOf('Sarah and')), 'meeting');
    expect(partial.actions).toHaveLength(1);
    const done = { ...partial, actions: partial.actions.map((a) => ({ ...a, done: true })) };
    expect(parseSummary(raw, 'meeting', done).actions[0].done).toBe(true);
    expect(parseSummary('', 'meeting').overview).toBe('');
  });
  it('accepts headings written as nested markdown bullets', () => {
    const s = parseSummary('- **Project Falcon**\n  - **Action Items**:\n    - Amara: Send the plan (due: Friday)\n  - **Decisions**:\n    - Budget approved: 12,000 pounds.\n  - **Key Points**:\n    - [0:11] Interviews done.', 'meeting');
    expect(s.actions.map((a) => a.owner)).toEqual(['Amara']);
    expect(s.decisions).toEqual(['Budget approved: 12,000 pounds.']);
    expect(s.keyPoints).toHaveLength(1);
  });
  it('parses actions and name hints defensively', () => {
    expect(parseAction('- none')).toBeNull();
    expect(parseAction('1. Unassigned: Book the room (due: TBD)')!.owner).toBeUndefined();
    const speakers = [{ id: 'S1', name: 'Speaker 1' }, { id: 'S2', name: 'Speaker 2' }, { id: 'S3', name: 'Priya', named: true }];
    const hints = parseNameHints('Speaker 1 = unknown\nSpeaker 2 = George\nSpeaker 9 = Bob\nSpeaker 1 = Zed', speakers, 'thanks George, over to you');
    expect(hints).toEqual({ S2: 'George' });
  });
});

describe('text utilities', () => {
  const w = (t: string, s: number, e: number) => ({ t, s, e });
  it('formats and parses time', () => {
    expect(fmtTime(75)).toBe('1:15');
    expect(fmtTime(3725)).toBe('1:02:05');
    expect(parseTime('1:02:05')).toBe(3725);
    expect(parseTime('abc')).toBeNull();
  });
  it('splits sentences and glues tiny fragments', () => {
    const s = splitSentences([w('Hello', 0, 0.4), w('there.', 0.4, 1.5), w('Yes.', 1.6, 1.9), w('Dr.', 2.4, 2.6), w('Who', 2.6, 3), w('knows?', 3, 4), w('Later', 6, 6.5)]);
    expect(s.map(joinWords)).toEqual(['Hello there. Yes.', 'Dr. Who knows?', 'Later']);
  });
  it('retimes edited text inside the original span', () => {
    const r = retime('one two three', 10, 13);
    expect(r[0].s).toBe(10);
    expect(r[2].e).toBeCloseTo(13);
  });
  const paras: Para[] = [
    { id: 'a', sp: 'S1', s: 0, e: 5, text: 'Hello everyone and welcome.', words: retime('Hello everyone and welcome.', 0, 5) },
    { id: 'b', sp: 'S2', s: 6, e: 9, text: 'Thanks, glad to be here.', words: retime('Thanks, glad to be here.', 6, 9), hl: true, note: 'nice' },
  ];
  const m = { title: 'T', createdAt: 0, duration: 9, speakers: [{ id: 'S1', name: 'Ann', color: 0 }, { id: 'S2', name: 'Bo', color: 1 }], notes: 'mine', summary: parseSummary('OVERVIEW: Hi.\nACTION ITEMS:\n- Ann: Do it (due: Mon)', 'meeting') } as unknown as Meeting;
  it('exports markdown and subtitles', () => {
    const md = toMarkdown(m, paras);
    expect(md).toContain('- [ ] **Ann:** Do it _(due Mon)_');
    expect(md).toContain('**Bo** `0:06` ⭐');
    const srt = toSrt(paras, m.speakers);
    expect(srt).toContain('00:00:00,000 --> 00:00:05,000\nAnn: Hello everyone and welcome.');
    expect(srt.split('\n\n')).toHaveLength(2);
  });
  it('chunks for the search index', () => {
    const many: Para[] = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, sp: 'S1', s: i * 10, e: i * 10 + 9, text: Array(40).fill('word').join(' '), words: [] }));
    const chunks = chunkForIndex(many, m.speakers);
    expect(chunks.length).toBeGreaterThan(8);
    expect(chunks[0].text.startsWith('Ann: ')).toBe(true);
    expect(chunks[chunks.length - 1].e).toBe(299);
  });
});

describe('phone link', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { servePhone } = await import('../src/main/phone');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-phone-unit-'));
  const ui = path.join(dir, 'ui');
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, 'index.html'), '<p>phone</p>');
  const audio = path.join(dir, 'a.m4a');
  fs.writeFileSync(audio, Buffer.from('0123456789'));
  const uploads: { file: string; meta: { rid: string; bookmarks: number[]; template: string } }[] = [];
  const server = await servePhone(
    { dataDir: dir, uiDir: ui, hasMeeting: (id) => id === 'm1', audioFile: async (id) => (id === 'm1' ? audio : null), upload: (file, meta) => (uploads.push({ file, meta }), { id: 'm1' } as Meeting), api: { echo: (x: unknown) => x } },
    0,
  );
  const base = `http://127.0.0.1:${server.port}`;
  const k = `k=${server.token}`;
  it('serves the app but guards the library', async () => {
    expect(await (await fetch(base + '/')).text()).toBe('<p>phone</p>');
    expect((await fetch(`${base}/audio/m1`)).status).toBe(401);
    expect((await fetch(`${base}/audio/m1?k=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/upload?rid=a1`, { method: 'POST', body: 'x' })).status).toBe(401);
    expect((await fetch(`${base}/../../etc/passwd`)).status).toBe(200); // falls back to the app, never outside it
    expect(await (await fetch(`${base}/..%2F..%2Fphone.json`)).text()).toBe('<p>phone</p>');
  });
  it('plays audio with range requests', async () => {
    const r = await fetch(`${base}/audio/m1?${k}`, { headers: { range: 'bytes=2-5' } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe('2345');
    expect((await fetch(`${base}/audio/nope?${k}`)).status).toBe(404);
  });
  it('receives a recording once, even if the phone retries', async () => {
    const send = () => fetch(`${base}/upload?${k}&rid=rec1&t=1700000000000&tpl=lecture&ext=m4a&marks=1.5,9`, { method: 'POST', body: Buffer.from('audio-bytes') });
    expect(await (await send()).json()).toEqual({ meetingId: 'm1' });
    expect(await (await send()).json()).toEqual({ meetingId: 'm1', duplicate: true });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].meta).toMatchObject({ rid: 'rec1', template: 'lecture', bookmarks: [1.5, 9], createdAt: 1700000000000 });
    expect(fs.readFileSync(uploads[0].file, 'utf8')).toBe('audio-bytes');
  });
  it('only runs calls on the allowed list', async () => {
    const { WebSocket } = await import('ws');
    await expect(new Promise((res, rej) => { const w = new WebSocket(`${base.replace('http', 'ws')}/ws?k=bad`); w.on('open', res); w.on('error', rej); })).rejects.toThrow();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?${k}`);
    await new Promise((r) => ws.on('open', r));
    const ask = (msg: object) => new Promise<any>((r) => { ws.once('message', (d) => r(JSON.parse(String(d)))); ws.send(JSON.stringify(msg)); });
    expect(await ask({ id: 1, method: 'echo', args: ['hi'] })).toEqual({ id: 1, result: 'hi' });
    expect((await ask({ id: 2, method: 'constructor' })).error).toMatch(/Unknown/);
    expect((await ask({ id: 3, method: 'deleteEverything' })).error).toMatch(/Unknown/);
    ws.close();
    server.close();
  });
});

import { ankiExport, explicitEmphasis, findCaseNames, findLegislation, locate, parseJson, pickSession, record, topicStatus, type Practice } from '../src/shared/law';
describe('law lecture intelligence', () => {
  const para = (id: string, s: number, text: string): Para => ({ id, sp: 'S1', s, e: s + 30, text, words: retime(text, s, s + 30) });
  const lecture = [
    para('a', 0, "Okay, today we look at offer and acceptance. The leading case is Carlill v Carbolic Smoke Ball Company, decided in 1893."),
    para('b', 30, "This is really important: an advert is usually only an invitation to treat. A common mistake is to call every advert an offer."),
    para('c', 60, "Compare Partridge versus Crittenden, where an advert for birds was an invitation to treat. Don't confuse this with a unilateral offer."),
    para('d', 90, "Under section 2 of the Misrepresentation Act 1967 there is a statutory claim. Section 2(1) is likely to come up in the exam."),
    para('e', 120, "We also touched on the Consumer Rights Act 2015. Tom and Jerry went to the shop."),
  ];
  it('finds what the lecturer emphasised, word for word, with the time', () => {
    const e = explicitEmphasis(lecture);
    expect(e.map((x) => x.cue)).toEqual(['Important', 'Common mistake', "Don't confuse", 'Exam']);
    expect(e[0].t).toBeGreaterThanOrEqual(30);
    expect(e.every((x) => x.kind === 'explicit')).toBe(true);
  });
  it('finds case names as speech-to-text writes them', () => {
    const c = findCaseNames(lecture).map((x) => x.name);
    expect(c).toContain('Carlill v Carbolic Smoke Ball Company');
    expect(c).toContain('Partridge v Crittenden');
    expect(c.some((x) => /Tom/.test(x))).toBe(false);
  });
  it('finds statutes and sections', () => {
    const l = findLegislation(lecture);
    expect(l.find((x) => x.section === '2')?.name).toBe('Misrepresentation Act 1967');
    expect(l.find((x) => x.section === '2(1)')?.name).toBe('Misrepresentation Act 1967');
    expect(l.some((x) => x.name === 'Consumer Rights Act 2015')).toBe(true);
  });
  it('checks names the AI gives against the transcript', () => {
    expect(locate(lecture, 'Carlill v Carbolic Smoke Ball Co')).toBeGreaterThanOrEqual(0);
    expect(locate(lecture, 'Fisher v Bell')).toBe(-1);
    expect(parseJson<{ a: number }>('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it('tracks practice, topics and what to revise next', () => {
    const now = 1_800_000_000_000;
    const p: Practice = {};
    record(p, 'c1', false, 'Offer', 'L1', now);
    record(p, 'c1', false, 'Offer', 'L1', now);
    record(p, 'c2', true, 'Acceptance', 'L1', now);
    record(p, 'c2', true, 'Acceptance', 'L1', now);
    const items = [{ key: 'c1', topic: 'Offer', lecture: 'L1' }, { key: 'c2', topic: 'Acceptance', lecture: 'L1' }, { key: 'c3', topic: 'Consideration', lecture: 'L2' }];
    const rows = topicStatus(items, p, { Acceptance: 2 }, now);
    expect(rows.map((r) => `${r.topic}:${r.state}`)).toEqual(['Offer:needs', 'Acceptance:needs', 'Consideration:untested']);
    expect(pickSession(items, p, new Set(['Offer']), 5, now + 864e5).map((x) => x.key)).toEqual(['c1', 'c3']);
    expect(ankiExport([{ front: 'What is an offer?', back: 'A definite\npromise', topic: 'Offer & acceptance' }], 'Contract')).toBe('#separator:tab\n#html:true\n#deck:Contract\n#tags column:3\nWhat is an offer?\tA definite<br>promise\toffer_acceptance');
  });
});

import { locateName } from '../src/shared/law';
describe('case names as speech-to-text actually writes them', () => {
  const t = 'In Fisher V-Bell, a shopkeeper displayed a flick knife. In Carlo V. Carbolic Smokeball Company, the company promised £100.';
  const paras: Para[] = [{ id: 'x', sp: 'S1', s: 0, e: 20, text: t, words: retime(t, 0, 20) }];
  it('finds them, and says when the spelling differs', () => {
    expect(findCaseNames(paras).map((c) => c.name)).toEqual(['Fisher v Bell', 'Carlo v Carbolic Smokeball Company']);
    expect(locateName(paras, 'Fisher v Bell')).toMatchObject({ exact: true });
    const c = locateName(paras, 'Carlill v Carbolic Smoke Ball Co');
    expect(c.t).toBeGreaterThan(5);
    expect(c.exact).toBe(false);
    expect(locateName(paras, 'Hyde v Wrench').t).toBe(-1);
  });
});

import { markdownToDocx } from '../src/main/docx';
describe('Word export', () => {
  it('turns notes into a real .docx', async () => {
    const buf = await markdownToDocx('# Offer and acceptance\n\n## Cases\n- **Fisher v Bell** — display is an invitation to treat [0:47]\n1. Offer\n2. Acceptance\n\n| Case | Rule |\n|---|---|\n| Hyde v Wrench | Counter-offer rejects |\n\n> Remember this', 'Test');
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.length).toBeGreaterThan(5000);
  });
});
