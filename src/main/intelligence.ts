/** Everything the language model does: notes, chat about one conversation, questions across all of them. */
import type { Library, VectorChunk } from './store';
import { chunkForIndex, fmtTime, parseTime, roughTokens, transcriptForLLM } from '../shared/text';
import { parseNameHints, parseSummary, summaryInstruction, summarySystem } from '../shared/summaryFormat';
import { uid } from '../shared/types';
import type { ChatMsg, Para, Source, Speaker, StreamEvent, Summary, TemplateId } from '../shared/types';

export type LlmApi = {
  generate(p: { streamId: string; system: string; history?: { role: 'user' | 'assistant'; text: string }[]; prompt: string; maxTokens?: number; temperature?: number; prefix?: string }): Promise<string>;
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
  async chat(meetingId: string, question: string, streamId: string): Promise<ChatMsg> {
    const m = this.lib.get(meetingId);
    const paras = this.lib.transcript(meetingId);
    const userMsg: ChatMsg = { id: uid(), role: 'user', text: question, at: Date.now() };
    const history = m.chat.slice(-6).map((c) => ({ role: c.role, text: c.text }));
    const ctx = await this.llm.contextSize();
    const budget = ctx - 900 - roughTokens(history.map((h) => h.text).join(' ')) - 300;
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
    const system = `You are Hark, an assistant that answers questions about one recorded conversation titled "${m.title}". Answer only from the material below. When you rely on a moment, cite its timestamp in square brackets like [1:27]. If the answer is not there, say so plainly. Be direct and brief; use short bullet points for lists.\n\n${material}`;
    try {
      const text = await this.llm.generate({ streamId, system, history, prompt: question, maxTokens: 700, temperature: 0.3 });
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
