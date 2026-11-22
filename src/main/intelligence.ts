/** Everything the language model does: notes, chat about one conversation, questions across all of them. */
import type { Library, VectorChunk } from './store';
import { chunkForIndex, fmtTime, parseTime, roughTokens, transcriptForLLM } from '../shared/text';
import { parseNameHints, parseSummary, summaryInstruction, summarySystem } from '../shared/summaryFormat';
import { uid } from '../shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { loadMaterials, relevantPages } from './materials';
import { checkLaw } from './legislation';
import { findLegislation, type LawRef } from '../shared/law';
import type { ChatMsg, Para, Source, Speaker, StreamEvent, Summary, TemplateId, TutorMode } from '../shared/types';

const MODE_RULES: Record<TutorMode, string> = {
  law: 'Explain accurately at the level of a UK law conversion course (England and Wales): precise terminology, the rule, its elements and the authority for it.',
  explain: 'Explain like a patient tutor to a beginner: plain English, short sentences, one everyday example, legal terms explained as you go.',
  exam: 'Focus on exam technique: how the point would be examined, the issues to spot, how to apply the rule to facts (IRAC), and common mistakes. Offer a short example question when useful.',
  socratic: 'Teach Socratically: do not give the answer straight away. Ask one or two guiding questions that lead the student to it, then confirm or correct their reasoning when they reply.',
  case: 'Explain cases through their facts, the legal issue, the decision and the principle (ratio), and why the case matters for this topic.',
  compare: 'Compare the concepts, cases or tests side by side: what they share, how they differ, and when each applies. Use short parallel bullet points.',
  lecture: 'Answer ONLY from the lecture material below. If the answer is not there, say exactly: "Your lectures don\'t cover that." Do not add outside knowledge.',
  research: 'You may go beyond the lecture using your general knowledge of English law. Clearly separate "From your lecture:" and "Beyond the lecture (check this):". Never invent case names, citations or section numbers: if unsure, say so and suggest where to check (legislation.gov.uk for statutes, BAILII or a law report for cases). When official statute text from legislation.gov.uk is provided, quote it accurately and give its link.',
};

export type LlmApi = {
  generate(p: { streamId: string; system: string; history?: { role: 'user' | 'assistant'; text: string }[]; prompt: string; maxTokens?: number; temperature?: number; prefix?: string; tier?: 'strong' | 'fast'; json?: boolean }): Promise<string>;
  tokens(text: string): Promise<number>;
  contextSize(): Promise<number>;
  modelName(): string;
};
export type EmbedApi = { embedText(texts: string[]): Promise<number[][]>; available(): boolean };

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export class Intelligence {
  constructor(private lib: Library, private llm: LlmApi, private embed: EmbedApi, private send: (e: StreamEvent) => void, private stopped: (streamId: string) => boolean = () => false) {}

  /** Split a long transcript into pieces that each fit `budget` tokens. */
  private async split(text: string, budget: number): Promise<string[]> {
    const total = await this.llm.tokens(text);
    if (total <= budget) return [text];
    const perChar = total / text.length;
    const maxChars = Math.floor((budget / perChar) * 0.92);
    const out: string[] = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if (cur && cur.length + line.length + 1 > maxChars) {
        out.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) out.push(cur);
    return out;
  }

  async summarize(meetingId: string, streamId: string, template?: TemplateId): Promise<Summary> {
    const m = this.lib.get(meetingId);
    const tpl = template ?? m.template;
    const paras = this.lib.transcript(meetingId);
    if (!paras.length) throw new Error('There is nothing to summarise yet.');
    this.lib.update(meetingId, { summaryState: 'running', summaryError: undefined, template: tpl });
    try {
      const ctx = await this.llm.contextSize();
      const outTokens = tpl === 'lecture' ? 1500 : 1100;
      const transcript = transcriptForLLM(paras, m.speakers);
      // Small models lose the middle of very long inputs, so anything beyond about 20 minutes
      // of speech is read in parts of roughly 15 minutes each.
      const single = Math.min(ctx - outTokens - 700, 4500);
      const parts = (await this.llm.tokens(transcript)) <= single ? [transcript] : await this.split(transcript, Math.min(single, 3500));
      const material = `Transcript:\n${transcript}`;
      let summary: Summary | null = null;

      if (parts.length > 1) {
        const merged = parseSummary('', tpl, m.summary);
        const digest: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          this.send({ streamId, stage: `Reading part ${i + 1} of ${parts.length}` });
          const times = [...parts[i].matchAll(/^\[(\d+(?::\d+)+)\]/gm)].map((x) => x[1]);
          const from = parseTime(times[0] ?? '0:00') ?? 0, to = parseTime(times[times.length - 1] ?? '0:00') ?? m.duration;
          const raw = await this.llm.generate({
            streamId: `${streamId}:part${i}`,
            system: summarySystem(tpl),
            prompt: `This is part ${i + 1} of ${parts.length} of a longer transcript, covering ${fmtTime(from)} to ${fmtTime(to)}.\n\n${parts[i]}\n\nWrite notes on THIS PART ONLY.\n\n${summaryInstruction(tpl)}`,
            prefix: 'TITLE: ',
            maxTokens: 750,
            temperature: 0.2,
          });
          if (this.stopped(streamId)) throw new Error('Stopped');
          const part = parseSummary(raw, tpl, m.summary);
          const seen = (list: string[], item: string) => list.some((x) => x.toLowerCase() === item.toLowerCase());
          for (const k of part.keyPoints.slice(0, 5)) if (!seen(merged.keyPoints, k)) merged.keyPoints.push(k);
          for (const d of part.decisions) if (!seen(merged.decisions, d)) merged.decisions.push(d);
          for (const q of part.questions) if (!seen(merged.questions, q)) merged.questions.push(q);
          for (const a of part.actions) if (!merged.actions.some((x) => x.text.toLowerCase() === a.text.toLowerCase())) merged.actions.push(a);
          // Only trust chapter times that fall inside the stretch this part covers.
          const fresh = part.chapters.filter((c) => c.t >= from - 5 && c.t <= to + 5 && !merged.chapters.some((x) => x.title.toLowerCase() === c.title.toLowerCase()));
          merged.chapters.push(...fresh.filter((c, j, all) => all.findIndex((x) => x.title.toLowerCase() === c.title.toLowerCase()) === j).slice(0, 3));
          merged.cards.push(...part.cards.slice(0, 3));
          digest.push(`Part ${i + 1} (${fmtTime(from)} to ${fmtTime(to)}): ${part.overview}\n${[...part.keyPoints.slice(0, 5), ...part.decisions.map((d) => `Decided: ${d}`)].map((x) => `- ${x}`).join('\n')}`);
        }
        this.send({ streamId, stage: 'Writing the summary' });
        const raw = await this.llm.generate({
          streamId,
          system: summarySystem(tpl),
          prompt: `These are notes on consecutive parts of one long conversation:\n\n${digest.join('\n\n')}\n\nWrite, in EXACTLY this format:\n\nTITLE: <specific title for the whole conversation, at most 8 words>\nOVERVIEW: <3-5 sentences covering the whole conversation from start to finish>\nKEY POINTS:\n- <the 6 to 10 most important points overall, one per line>\nTOPICS: <3-6 comma separated keywords>`,
          prefix: 'TITLE: ',
          maxTokens: 700,
          temperature: 0.2,
        });
        if (this.stopped(streamId)) throw new Error('Stopped');
        const top = parseSummary(raw, tpl);
        merged.title = top.title;
        merged.overview = top.overview;
        merged.topics = top.topics;
        if (top.keyPoints.length >= 3) merged.keyPoints = top.keyPoints;
        else merged.keyPoints = merged.keyPoints.slice(0, 12);
        merged.chapters.sort((x, y) => x.t - y.t);
        merged.cards = merged.cards.slice(0, 12);
        if (merged.overview || merged.keyPoints.length) summary = merged;
      } else {
        for (let attempt = 0; attempt < 2 && !summary; attempt++) {
          const raw = await this.llm.generate({
            streamId,
            system: summarySystem(tpl),
            prompt: `${material}\n\n${summaryInstruction(tpl)}`,
            prefix: 'TITLE: ',
            maxTokens: outTokens,
            temperature: attempt ? 0.5 : 0.2,
          });
          if (this.stopped(streamId)) throw new Error('Stopped');
          const s = parseSummary(raw, tpl, m.summary);
          if (s.overview || s.keyPoints.length) summary = s;
          else this.send({ streamId, stage: 'Trying again' });
        }
        if (summary && !summary.actions.length && !summary.decisions.length && !this.stopped(streamId)) {
          // Small models sometimes skip these sections. Ask once more, just for them.
          const raw = await this.llm
            .generate({
              streamId: `${streamId}:tasks`,
              system: summarySystem(tpl),
              prompt: `${material}\n\nList only the action items and decisions from this conversation, in EXACTLY this format. Write "- none" if there are none.\n\nACTION ITEMS:\n- <owner name>: <task> (due: <when, or unspecified>)\nDECISIONS:\n- <decision>`,
              maxTokens: 400,
              temperature: 0.1,
            })
            .catch(() => '');
          const extra = parseSummary(raw, tpl, m.summary);
          summary.actions = extra.actions;
          summary.decisions = extra.decisions;
        }
      }
      if (!summary) throw new Error('The model did not produce usable notes. Try again, or switch to a larger AI model in Settings.');
      summary.chapters = summary.chapters.filter((c) => c.t <= m.duration + 5);
      summary.model = this.llm.modelName();
      summary.at = Date.now();
      const patch: Parameters<Library['update']>[1] = { summary, summaryState: undefined };
      if (m.titleAuto && summary.title) patch.title = summary.title;
      this.lib.update(meetingId, patch);
      this.send({ streamId, done: true });
      await this.suggestNames(meetingId, parts.length === 1 ? material : `Transcript (the beginning of a longer conversation):\n${parts[0]}`, tpl).catch(() => undefined);
      void this.index(meetingId).catch(() => undefined);
      return summary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Stopped') {
        this.lib.update(meetingId, { summaryState: undefined });
        this.send({ streamId, done: true });
        return this.lib.get(meetingId).summary ?? parseSummary('', tpl);
      }
      this.lib.update(meetingId, { summaryState: 'error', summaryError: msg });
      this.send({ streamId, error: msg });
      throw err;
    }
  }

  /** Work out who "Speaker 2" really is when the conversation makes it clear. Offered as suggestions, never applied silently. */
  private async suggestNames(meetingId: string, material: string, tpl: TemplateId): Promise<void> {
    const m = this.lib.get(meetingId);
    const unnamed = m.speakers.filter((s) => !s.named);
    if (!unnamed.length || m.speakers.length < 2) return;
    const raw = await this.llm.generate({
      streamId: `names:${meetingId}`,
      system: summarySystem(tpl),
      prompt: `${material}\n\nWork out the real first name of each speaker label, but ONLY when the transcript makes it clear: they introduce themselves, or someone addresses them by name and they are the one who replies. Do not guess. Answer with one line per speaker, exactly like:\n${unnamed.map((s) => `${s.name} = <name or unknown>`).join('\n')}`,
      maxTokens: 80,
      temperature: 0,
    });
    const hints = parseNameHints(raw, m.speakers, material);
    if (Object.keys(hints).length) this.lib.update(meetingId, { nameHints: hints });
  }

  /** Build the semantic search index for one conversation. */
  async index(meetingId: string): Promise<void> {
    if (!this.embed.available()) return;
    const m = this.lib.get(meetingId);
    const paras = this.lib.transcript(meetingId);
    const chunks = chunkForIndex(paras, m.speakers);
    const s = m.summary;
    if (s) {
      const digest = [s.overview, ...s.decisions.map((d) => `Decision: ${d}`), ...s.actions.map((a) => `Action: ${a.owner ? a.owner + ' to ' : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`)].filter(Boolean).join('\n');
      if (digest) chunks.unshift({ s: 0, e: m.duration, text: `Summary of "${m.title}": ${digest}`, paraId: '' });
    }
    if (!chunks.length) return;
    const vecs = await this.embed.embedText(chunks.map((c) => c.text));
    this.lib.saveVectors(meetingId, chunks.map((c, i) => ({ ...c, v: vecs[i].map((x) => Math.round(x * 1e4) / 1e4) })));
  }

  private async retrieve(question: string, meetingIds: string[], k: number): Promise<{ meetingId: string; chunk: VectorChunk; score: number }[]> {
    const terms = question.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 3);
    const qv = this.embed.available() ? (await this.embed.embedText([question]))[0] : null;
    const scored: { meetingId: string; chunk: VectorChunk; score: number }[] = [];
    for (const id of meetingIds) {
      for (const chunk of this.lib.vectors(id)) {
        const low = chunk.text.toLowerCase();
        const kw = terms.length ? terms.filter((t) => low.includes(t)).length / terms.length : 0;
        const sem = qv && chunk.v.length === qv.length ? dot(qv, chunk.v) : 0;
        scored.push({ meetingId: id, chunk, score: sem + kw * 0.25 });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** Chat about one conversation. The whole transcript goes in when it fits; otherwise the most relevant passages. */
  async chat(meetingId: string, question: string, streamId: string, mode: TutorMode = 'law', passage?: { text: string; t: number }): Promise<ChatMsg> {
    const m = this.lib.get(meetingId);
    const paras = this.lib.transcript(meetingId);
    const userMsg: ChatMsg = { id: uid(), role: 'user', text: passage ? `“${passage.text.slice(0, 180)}${passage.text.length > 180 ? '…' : ''}” [${fmtTime(passage.t)}]\n\n${question}` : question, at: Date.now() };
    const history = m.chat.slice(-6).map((c) => ({ role: c.role, text: c.text }));
    const ctx = await this.llm.contextSize();
    const mats = loadMaterials(this.lib.folder(meetingId));
    const budget = ctx - 900 - roughTokens(history.map((h) => h.text).join(' ')) - 300 - (mats.length ? 750 : 0) - (mode === 'research' ? 1100 : /\b(Act|Regulations?)\b/.test(question) ? 450 : 0);
    const full = transcriptForLLM(paras, m.speakers);
    let material: string;
    if ((await this.llm.tokens(full)) <= budget) material = `Transcript:\n${full}`;
    else {
      if (!this.lib.vectors(meetingId).length) await this.index(meetingId);
      const top = await this.retrieve(question, [meetingId], 12);
      let used = 0;
      const picked = top.filter((t) => (used += roughTokens(t.chunk.text)) < budget - 400).sort((a, b) => a.chunk.s - b.chunk.s);
      material = `${m.summary?.overview ? `Summary: ${m.summary.overview}\n\n` : ''}Most relevant excerpts from the transcript:\n${picked.map((t) => `[${fmtTime(t.chunk.s)}] ${t.chunk.text}`).join('\n---\n')}`;
    }
    // What this lecture's study pack found (cases and their principles), a short and checked summary.
    let found = '';
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(this.lib.folder(meetingId), 'study.json'), 'utf8'));
      const cases = (pack.legal?.cases ?? []).filter((c: { found: boolean }) => c.found).map((c: { name: string; principle: string }) => `- ${c.name}: ${c.principle}`).join('\n');
      if (cases) found = `\n\nCases discussed in this lecture:\n${cases}`;
    } catch {
      /* no study pack yet */
    }
    // Comparing with other lectures: bring in the most relevant passages from them, with where they came from.
    let others = '';
    if (mode === 'compare' || /\b(previous|last|earlier|other|another|next) (lecture|week|session|class)|\bother lectures\b|\bcompare\b/i.test(question)) {
      const ids = this.lib.list().filter((x) => x.id !== meetingId && x.status === 'ready').map((x) => x.id);
      if (ids.length) {
        const hits = await this.retrieve(question, ids, 6).catch(() => []);
        if (hits.length) others = `\n\nFrom your other lectures (cite as [lecture title, m:ss]):\n${hits.map((h) => `[${this.lib.get(h.meetingId).title}, ${fmtTime(h.chunk.s)}] ${h.chunk.text}`).join('\n---\n')}`;
      }
    }
    // Slides and handouts: the pages that best match the question.
    const pages = mats.length ? relevantPages(mats, `${question} ${passage?.text ?? ''}`, 2500) : '';
    const slides = pages ? `\n\nFrom the course materials for this lecture (cite as [file, slide or page]; these count as lecture material):\n${pages}` : '';
    // Statutes: the official wording from legislation.gov.uk, for statutes named in the question or passage and, in research mode, those the lecture relied on.
    let official = '';
    try {
      const asked = findLegislation([{ id: 'q', sp: '', s: 0, e: 0, text: `${question} ${passage?.text ?? ''}`, words: [] }]);
      let lectureLaws: LawRef[] = [];
      if (mode === 'research') try { lectureLaws = JSON.parse(fs.readFileSync(path.join(this.lib.folder(meetingId), 'study.json'), 'utf8')).legal?.laws ?? []; } catch { /* none */ }
      const refs = [...asked.map((a) => ({ name: a.name, section: a.section })), ...lectureLaws.map((l) => ({ name: l.name, section: l.section }))].filter((r, i, all) => all.findIndex((x) => x.name === r.name && x.section === r.section) === i).slice(0, 3);
      const checks = await Promise.all(refs.map((r) => checkLaw(r.name, r.section)));
      const lines = checks.flatMap((c, i) => (c.status === 'verified' && c.text ? [`${c.title}${refs[i].section ? `, s ${refs[i].section}` : ''} (${c.url}):\n${c.text.slice(0, 1400)}`] : []));
      if (lines.length) official = `\n\nOfficial statute text from legislation.gov.uk (current version; label it as legislation.gov.uk and give the link if you use it):\n${lines.join('\n---\n')}`;
    } catch {
      /* offline: answer without it */
    }
    const focus = passage ? `\n\nThe student is asking about this passage, said at [${fmtTime(passage.t)}]:\n"${passage.text.slice(0, 1500)}"` : '';
    const lecture = m.template === 'lecture';
    const system = `${lecture ? `You are Hark, a law tutor helping a student understand their recorded lecture "${m.title}". ${MODE_RULES[mode]}` : `You are Hark, an assistant answering questions about the recorded conversation "${m.title}".${mode === 'lecture' ? ' Answer only from the material below.' : ''}`}\nGround your answer in the material below and cite its timestamps in square brackets like [1:27]. Never invent cases, statutes, quotations or holdings; label anything that is not from the lecture. Be clear and reasonably brief; use short bullet points for lists.\n\n${material}${found}${slides}${official}${others}${focus}`;
    try {
      const text = await this.llm.generate({ streamId, system, history, prompt: question, maxTokens: mode === 'exam' || mode === 'compare' ? 1000 : 750, temperature: mode === 'socratic' || mode === 'explain' ? 0.5 : 0.3, tier: 'strong' });
      const reply: ChatMsg = { id: uid(), role: 'assistant', text, at: Date.now() };
      this.lib.update(meetingId, { chat: [...this.lib.get(meetingId).chat, userMsg, reply] });
      this.send({ streamId, done: true });
      return reply;
    } catch (err) {
      this.send({ streamId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Ask a question across every conversation in the library. */
  async ask(question: string, streamId: string): Promise<ChatMsg> {
    const all = this.lib.list().filter((m) => m.status === 'ready');
    for (const m of all) if (!this.lib.vectors(m.id).length && this.lib.transcript(m.id).length) await this.index(m.id);
    const top = (await this.retrieve(question, all.map((m) => m.id), 8)).filter((t) => t.score > 0.12);
    const sources: Source[] = top.map((t, i) => {
      const m = this.lib.get(t.meetingId);
      return { n: i + 1, meetingId: m.id, title: m.title, t: t.chunk.s, date: m.createdAt };
    });
    this.send({ streamId, sources });
    const past = this.lib.askHistory();
    const userMsg: ChatMsg = { id: uid(), role: 'user', text: question, at: Date.now() };
    const excerpts = top
      .map((t, i) => `[${i + 1}] From "${sources[i].title}" (${new Date(sources[i].date).toDateString()}, at ${fmtTime(t.chunk.s)}):\n${t.chunk.text}`)
      .join('\n\n');
    const system = `You are Hark, the user's private memory of their recorded conversations. Answer using only the numbered excerpts provided with each question. Cite the excerpts you used with their numbers in square brackets, like [1] or [2][3]. If the excerpts do not contain the answer, say you could not find it in their conversations. Be direct and brief. Today is ${new Date().toDateString()}.`;
    try {
      const text = top.length
        ? await this.llm.generate({
            streamId,
            system,
            history: past.slice(-4).map((c) => ({ role: c.role, text: c.text })),
            prompt: `Excerpts from my conversations:\n\n${excerpts}\n\nQuestion: ${question}`,
            maxTokens: 700,
            temperature: 0.3,
          })
        : "I couldn't find anything about that in your conversations yet.";
      if (!top.length) this.send({ streamId, delta: text });
      const reply: ChatMsg = { id: uid(), role: 'assistant', text, at: Date.now(), sources };
      this.lib.saveAskHistory([...past, userMsg, reply]);
      this.send({ streamId, done: true });
      return reply;
    } catch (err) {
      this.send({ streamId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** "Catch me up": what was just said, for someone who zoned out mid-recording. */
  async catchUp(paras: Para[], speakers: Speaker[], streamId: string): Promise<string> {
    const end = paras[paras.length - 1]?.e ?? 0;
    const recent = paras.filter((p) => p.e >= end - 300);
    try {
      if (!recent.length) throw new Error('Nothing has been said yet.');
      const text = await this.llm.generate({
        streamId,
        system: 'You are a live meeting assistant. Use only the transcript given.',
        prompt: `Here are the last few minutes of a conversation that is still going on:\n\n${transcriptForLLM(recent, speakers)}\n\nCatch me up in 3 to 5 short bullet points: what is being discussed right now, anything decided, and anything asked of someone. Start each line with "- ".`,
        maxTokens: 300,
        temperature: 0.3,
      });
      this.send({ streamId, done: true });
      return text;
    } catch (err) {
      this.send({ streamId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}
