/**
 * Turning a law lecture into study material: structured notes in five styles, the cases and
 * statutes discussed, what the lecturer emphasised, and a revision pack (flashcards, SBAQs,
 * short-answer and problem questions). Everything is grounded in the transcript: names are
 * checked against what was actually said, and anything that cannot be found is flagged.
 * Results are kept with the lecture, so nothing is generated twice unless asked.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Library } from './store';
import type { LlmApi } from './intelligence';
import { fmtTime, parseTime, roughTokens, transcriptForLLM } from '../shared/text';
import { NOTE_STYLES, explicitEmphasis, findCaseNames, findLegislation, legislationLink, locate, locateName, norm, parseJson, type CaseRef, type Card, type Difficulty, type Emphasis, type LawRef, type NoteStyle, type Problem, type Sbaq, type ShortQ, type StudyPack } from '../shared/law';
import { uid } from '../shared/types';
import type { StreamEvent } from '../shared/types';

const FAITHFUL = `You are an expert UK law tutor (England and Wales) helping a student on an MA Law conversion course revise from a recorded lecture.
Ground everything in the lecture transcript. Preserve the lecturer's own explanations, examples and emphasis rather than replacing them with textbook material.
Never invent cases, statutes, section numbers, quotations, dates or holdings. If the transcript is unclear (speech-to-text mistakes are common with case names), say so and mark it "[check]".
When you add general legal knowledge that the lecturer did not say, label it "(not from the lecture)".`;

const STYLE_RULES: Record<NoteStyle, string> = {
  detailed: 'Detailed lecture notes: complete enough to revise from without the recording, but organised and free of padding.',
  concise: 'Concise revision notes: the essential rules, tests, authorities and distinctions only, in tight bullet points.',
  beginner: 'Beginner-friendly notes: plain English, short sentences, a simple everyday example for each idea, legal terms explained when first used.',
  exam: 'Exam-focused notes: rules and their elements, the authority for each, how to apply them to a problem question, issue-spotting cues, and exam tips and pitfalls.',
  onepage: 'A one-page summary: the whole lecture on a single page (about 350 words), the most important rules and authorities only.',
};

const SECTIONS = `Use these markdown headings, in this order, and leave out any heading the lecture gives nothing for:
# <a specific title for the lecture>
## Overview
## Learning objectives
## <topic heading> (one for each main topic, in the order taught; use ### subheadings where helpful)
   Under each topic: definitions, rules and principles, the elements of any legal test (numbered), and the lecturer's examples and hypotheticals.
## Cases
   For each case: **Case name** — facts; issue; decision; ratio (the principle the case stands for); any obiter the lecturer mentioned; why the lecturer used it.
## Legislation
   Each statute and section discussed, and what the lecturer said about it.
## Comparisons and distinctions
## What the lecturer emphasised
## Common misunderstandings
## Exam tips
## Unanswered questions
## Points to check
   Anything uncertain: names or terms that may have been misheard, or points where the legal position was unclear.
Put the [m:ss] time from the transcript after each important point, case or rule, so it can be found in the recording.\nUse headings, bullet points and **bold**; do not use tables.`;

type Send = (e: StreamEvent) => void;

export class Study {
  constructor(private lib: Library, private llm: LlmApi, private send: Send, private stopped: (streamId: string) => boolean) {}

  private file(id: string): string {
    return path.join(this.lib.folder(id), 'study.json');
  }

  get(id: string): StudyPack {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as StudyPack;
    } catch {
      return {};
    }
  }

  save(id: string, patch: Partial<StudyPack>): StudyPack {
    const next = { ...this.get(id), ...patch };
    const tmp = `${this.file(id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, this.file(id));
    return next;
  }

  /** The transcript as the model reads it, in parts that fit the engine's allowance. */
  private async parts(id: string): Promise<string[]> {
    const m = this.lib.get(id);
    const text = transcriptForLLM(this.lib.transcript(id), m.speakers);
    if (!text.trim()) throw new Error('This lecture has no transcript yet.');
    const budget = Math.min(4200, (await this.llm.contextSize()) - 2200);
    if (roughTokens(text) <= budget) return [text];
    const out: string[] = [];
    let cur = '';
    const maxChars = budget * 3.4;
    for (const line of text.split('\n')) {
      if (cur && cur.length + line.length > maxChars) (out.push(cur), (cur = ''));
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) out.push(cur);
    return out;
  }

  private stage(streamId: string, stage: string): void {
    this.send({ streamId, stage });
  }

  private check(streamId: string): void {
    if (this.stopped(streamId)) throw new Error('Stopped');
  }

  /** Law-lecture notes in one of five styles. */
  async notes(id: string, style: NoteStyle, streamId: string): Promise<StudyPack> {
    try {
      const parts = await this.parts(id);
      let source: string;
      if (parts.length === 1) source = `Lecture transcript:\n${parts[0]}`;
      else {
        // Long lecture: take full notes on each part first, then organise the whole.
        const notes: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          this.stage(streamId, `Reading part ${i + 1} of ${parts.length}`);
          notes.push(await this.llm.generate({
            streamId: `${streamId}:part${i}`, tier: 'strong', temperature: 0.2, maxTokens: 1100,
            system: FAITHFUL,
            prompt: `This is part ${i + 1} of ${parts.length} of a lecture transcript.\n\n${parts[i]}\n\nWrite thorough notes on THIS PART ONLY: every definition, rule, legal test and its elements, case (with facts, decision and principle as explained), statute and section, example, comparison, point of emphasis, exam tip and unclear point. Keep the [m:ss] times. Plain markdown bullets, no tables.`,
          }));
          this.check(streamId);
        }
        source = `Notes taken on each part of the lecture, in order:\n\n${notes.map((n, i) => `PART ${i + 1}\n${n}`).join('\n\n')}`;
      }
      this.stage(streamId, `Writing ${NOTE_STYLES[style].name.toLowerCase()}`);
      const text = await this.llm.generate({
        streamId, tier: 'strong', temperature: 0.2, maxTokens: style === 'onepage' ? 700 : style === 'concise' ? 1300 : 2200,
        system: FAITHFUL,
        prompt: `${source}\n\nWrite ${STYLE_RULES[style]}\n\n${style === 'onepage' ? 'Use a title, then short sections for the key rules, cases and exam points, keeping [m:ss] times.' : SECTIONS}`,
      });
      this.check(streamId);
      const pack = this.save(id, { notes: { style, text: text.trim(), at: Date.now(), model: this.llm.modelName() } });
      this.send({ streamId, done: true });
      return pack;
    } catch (err) {
      this.send({ streamId, error: (err as Error).message });
      throw err;
    }
  }

  /** Cases, legislation, lecturer emphasis and topics, checked against the transcript. */
  async legal(id: string, streamId: string): Promise<StudyPack> {
    try {
      const paras = this.lib.transcript(id);
      const m = this.lib.get(id);
      const parts = await this.parts(id);
      type Raw = { cases?: Partial<CaseRef & { time: string }>[]; legislation?: { name?: string; section?: string; said?: string; time?: string }[]; exam_points?: { point?: string; time?: string }[]; topics?: string[] };
      const found: Raw = { cases: [], legislation: [], exam_points: [], topics: [] };
      for (let i = 0; i < parts.length; i++) {
        this.stage(streamId, parts.length > 1 ? `Finding cases and statutes, part ${i + 1} of ${parts.length}` : 'Finding cases, statutes and exam points');
        const raw = await this.llm.generate({
          streamId: `${streamId}:part${i}`, tier: 'strong', temperature: 0.1, maxTokens: 1600, json: true,
          system: FAITHFUL,
          prompt: `Lecture transcript${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''}:\n${parts[i]}\n\nReturn JSON only, in exactly this shape:\n{"cases":[{"name":"case name as said, e.g. Carlill v Carbolic Smoke Ball Co","facts":"","issue":"","judgment":"","principle":"the ratio as the lecturer explained it","why":"why the lecturer mentioned it","time":"m:ss when first mentioned","uncertain":"anything doubtful, or empty"}],"legislation":[{"name":"full Act name with year if said","section":"e.g. 2(1), or empty","said":"what the lecturer said about it","time":"m:ss"}],"exam_points":[{"point":"material likely to matter in an exam even though the lecturer did not flag it explicitly","time":"m:ss"}],"topics":["2 to 6 short topic names, e.g. Offer and acceptance"]}\n\nOnly include cases and legislation actually mentioned in this transcript. Use only what the lecture says for facts and principles; if the lecture does not give the facts, write "Not explained in the lecture". Leave arrays empty if there are none.`,
        });
        this.check(streamId);
        const j = parseJson<Raw>(raw) ?? {};
        found.cases!.push(...(j.cases ?? []));
        found.legislation!.push(...(j.legislation ?? []));
        found.exam_points!.push(...(j.exam_points ?? []));
        found.topics!.push(...(j.topics ?? []));
      }
      const time = (s?: string): number => {
        const t = parseTime(String(s ?? '').replace(/[[\]]/g, ''));
        return t !== null && t >= 0 && t <= m.duration + 5 ? t : -1;
      };
      // Cases: every name the AI gives is looked for in the transcript; names heard in the transcript that the AI missed are added.
      const cases: CaseRef[] = [];
      for (const c of found.cases!) {
        const name = String(c.name ?? '').trim();
        if (!name || cases.some((x) => norm(x.name) === norm(name))) continue;
        const hit = locateName(paras, name.replace(/\s*\[check\]\s*/gi, ' '));
        const at = hit.t;
        cases.push({
          name: name.replace(/\s*\[check\]\s*/gi, ' ').trim(), facts: String(c.facts ?? ''), issue: String(c.issue ?? ''), judgment: String(c.judgment ?? ''), principle: String(c.principle ?? ''), why: String(c.why ?? ''),
          t: at >= 0 ? at : time((c as { time?: string }).time), found: at >= 0,
          uncertain: at < 0 ? 'This name was not found in the transcript: it may have been misheard, or the AI may have added it. Check it before relying on it.'
            : !hit.exact || /\[check\]/i.test(name) ? 'The recording spells this name differently (speech-to-text often mishears case names). Check the spelling.'
            : c.uncertain && !/^(none|no|n\/a)?\.?$/i.test(String(c.uncertain).trim()) ? String(c.uncertain) : undefined,
        });
      }
      for (const h of findCaseNames(paras)) {
        // Already covered: a case the AI described at (about) the same moment.
        if (cases.some((x) => x.t >= 0 && Math.abs(x.t - h.t) < 25)) continue;
        cases.push({ name: h.name, facts: 'Not explained in the lecture.', issue: '', judgment: '', principle: '', why: `Mentioned at ${fmtTime(h.t)}.`, t: h.t, found: true });
      }
      // Legislation: the AI's account of what was said, plus every reference heard in the transcript.
      const laws: LawRef[] = [];
      const addLaw = (name: string, section: string | undefined, said: string, t: number) => {
        const key = norm(`${name} ${section ?? ''}`);
        if (!name || laws.some((x) => norm(`${x.name} ${x.section ?? ''}`) === key)) return;
        const at = locate(paras, name.replace(/\s*\d{4}$/, ''));
        laws.push({ name, section: section || undefined, said, t: at >= 0 ? at : t, found: at >= 0, link: legislationLink(name, section) });
      };
      for (const l of found.legislation!) addLaw(String(l.name ?? '').trim(), l.section ? String(l.section).replace(/^s\.?\s*/i, '') : undefined, String(l.said ?? ''), time(l.time));
      for (const h of findLegislation(paras)) addLaw(h.name, h.section, '', h.t);
      // An Act listed on its own is redundant once its sections are listed.
      for (let i = laws.length - 1; i >= 0; i--) if (!laws[i].section && laws.some((x) => x.section && norm(x.name) === norm(laws[i].name))) laws.splice(i, 1);
      // Emphasis: the lecturer's own words first, then what the AI thinks is exam-worthy.
      const emphasis: Emphasis[] = [...explicitEmphasis(paras)];
      for (const e of found.exam_points!) if (e.point) emphasis.push({ text: String(e.point), t: time(e.time), kind: 'inferred' });
      const topics = [...new Set(found.topics!.map((t) => String(t).trim()).filter(Boolean))].slice(0, 8);
      const pack = this.save(id, { legal: { cases: cases.sort((a, b) => (a.t < 0 ? 1e9 : a.t) - (b.t < 0 ? 1e9 : b.t)), laws: laws.sort((a, b) => a.t - b.t), emphasis, topics, at: Date.now(), model: this.llm.modelName() } });
      this.send({ streamId, done: true });
      return pack;
    } catch (err) {
      this.send({ streamId, error: (err as Error).message });
      throw err;
    }
  }

  /** What revision questions are written from: the notes and case analysis if they exist (shorter and already checked), else the transcript. */
  private async material(id: string, streamId: string): Promise<string> {
    let pack = this.get(id);
    if (!pack.notes) pack = await this.notes(id, 'detailed', `${streamId}:notes`);
    const cases = pack.legal?.cases.filter((c) => c.found).map((c) => `- ${c.name}: ${c.principle || c.facts}`).join('\n');
    return `Lecture notes:\n${pack.notes!.text}${cases ? `\n\nCases discussed:\n${cases}` : ''}`.slice(0, 16000);
  }

  /** Flashcards, SBAQs, short-answer or problem questions, added to what the lecture already has. */
  async revision(id: string, kind: 'cards' | 'sbaqs' | 'shortQs' | 'problems', opts: { count: number; difficulty: Difficulty }, streamId: string): Promise<StudyPack> {
    try {
      const material = await this.material(id, streamId);
      const n = Math.max(1, Math.min(kind === 'problems' ? 3 : kind === 'sbaqs' ? 8 : 20, opts.count));
      const level = { easy: 'straightforward, testing core understanding', medium: 'at the standard of a law conversion course exam', hard: 'demanding, with close distinctions and tricky application' }[opts.difficulty];
      const ask: Record<typeof kind, string> = {
        cards: `Write ${n} flashcards. Cover definitions, case principles, case facts and outcomes, statutory provisions, the elements of legal tests, distinctions between similar concepts, and examples. JSON: {"cards":[{"front":"question","back":"concise answer","kind":"definition|case|statute|test|distinction|example","topic":"short topic name","time":"m:ss from the notes, if given"}]}`,
        sbaqs: `Write ${n} single-best-answer questions (SBAQs), ${level}. Each is a short realistic scenario testing understanding and application, not memorisation, with exactly five options (A-E), one best answer and four plausible distractors. JSON: {"questions":[{"stem":"scenario and question","options":["","","","",""],"answer":0,"explanation":"why the answer is right, applying the rule","why":["for each option, one sentence on why it is right or wrong"],"authority":"the case or statute it turns on, if any","topic":"short topic name"}]}`,
        shortQs: `Write ${n} short-answer questions, ${level}, testing recall and understanding (no multiple choice). JSON: {"questions":[{"q":"","a":"model answer in 1-3 sentences","topic":"short topic name"}]}`,
        problems: `Write ${n} problem question(s), ${level}: a realistic scenario of 120-220 words for the student to advise on, raising several issues from this lecture. JSON: {"problems":[{"scenario":"","issues":["each legal issue raised"],"outline":"a model answer outline using IRAC: issue, rule with authority, application to these facts, conclusion","topic":"short topic name"}]}`,
      };
      this.stage(streamId, `Writing ${kind === 'cards' ? 'flashcards' : kind === 'sbaqs' ? 'SBAQs' : kind === 'shortQs' ? 'short-answer questions' : 'problem questions'}`);
      const raw = await this.llm.generate({
        streamId, tier: kind === 'cards' || kind === 'shortQs' ? 'fast' : 'strong', temperature: 0.5, maxTokens: kind === 'problems' ? 1800 : 2200, json: true,
        system: `${FAITHFUL}\nWrite revision material only from the lecture content below. Use only cases and statutes that appear in it.`,
        prompt: `${material}\n\n${ask[kind]}\nReturn JSON only.`,
      });
      this.check(streamId);
      const j = parseJson<Record<string, unknown[]>>(raw) ?? {};
      const pack = this.get(id);
      const t = (s: unknown) => parseTime(String(s ?? '').replace(/[[\]]/g, '')) ?? undefined;
      let patch: Partial<StudyPack> = {};
      if (kind === 'cards') {
        const cards = (j.cards ?? []).map((c: any): Card => ({ id: uid(), front: String(c.front ?? '').trim(), back: String(c.back ?? '').trim(), kind: String(c.kind ?? 'other'), topic: String(c.topic ?? ''), t: t(c.time) })).filter((c) => c.front && c.back);
        patch = { cards: [...(pack.cards ?? []), ...cards] };
      } else if (kind === 'sbaqs') {
        const qs = (j.questions ?? []).map((q: any): Sbaq => ({ id: uid(), stem: String(q.stem ?? ''), options: (q.options ?? []).map(String).slice(0, 5), answer: Math.max(0, Math.min(4, Number(q.answer) || 0)), explanation: String(q.explanation ?? ''), why: (q.why ?? []).map(String), authority: q.authority ? String(q.authority) : undefined, difficulty: opts.difficulty, topic: String(q.topic ?? '') })).filter((q) => q.stem && q.options.length === 5);
        patch = { sbaqs: [...(pack.sbaqs ?? []), ...qs] };
      } else if (kind === 'shortQs') {
        const qs = (j.questions ?? []).map((q: any): ShortQ => ({ id: uid(), q: String(q.q ?? ''), a: String(q.a ?? ''), topic: String(q.topic ?? '') })).filter((q) => q.q && q.a);
        patch = { shortQs: [...(pack.shortQs ?? []), ...qs] };
      } else {
        const ps = (j.problems ?? []).map((p: any): Problem => ({ id: uid(), scenario: String(p.scenario ?? ''), issues: (p.issues ?? []).map(String), outline: String(p.outline ?? ''), topic: String(p.topic ?? '') })).filter((p) => p.scenario);
        patch = { problems: [...(pack.problems ?? []), ...ps] };
      }
      const after = (patch[kind] as unknown[] | undefined)?.length ?? 0, before = (pack[kind] as unknown[] | undefined)?.length ?? 0;
      if (after === before) throw new Error('The AI did not return usable questions. Try again.');
      const out = this.save(id, patch);
      this.send({ streamId, done: true });
      return out;
    } catch (err) {
      this.send({ streamId, error: (err as Error).message });
      throw err;
    }
  }
}
