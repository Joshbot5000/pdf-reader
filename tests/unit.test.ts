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
