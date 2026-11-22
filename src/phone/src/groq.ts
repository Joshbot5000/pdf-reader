/**
 * Groq: transcription (Whisper) and notes (a large open model) in the cloud, so the phone can do
 * the whole job when the Mac is out of reach. The phone talks to Groq directly with the user's own
 * key; nothing else is involved. Notes use exactly the same format as the Mac's, so a conversation
 * looks the same wherever it was written.
 */
import { retime, transcriptForLLM } from '../../shared/text';
import { parseSummary, summaryInstruction, summarySystem } from '../../shared/summaryFormat';
import type { ChatMsg, Para, Speaker, Summary, TemplateId } from '../../shared/types';

const store = {
  get: (k: string): string => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string): void => {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

export const groqKey = (): string => store.get('hark.groqKey');
export const setGroqKey = (k: string): void => {
  if (k.trim() !== groqKey()) store.set('hark.groqModels', '');
  store.set('hark.groqKey', k.trim());
};
const base = (): string => store.get('hark.groqBase') || 'https://api.groq.com/openai/v1';

export const SPEAKER: Speaker = { id: 'S1', name: 'Speaker 1', color: 0 };

/** Ask Groq something, waiting politely when the free plan's limit is reached. */
async function groq(path: string, init: RequestInit, onWait?: (secs: number) => void, tries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, { ...init, headers: { Authorization: `Bearer ${groqKey()}`, ...(init.headers ?? {}) } });
    } catch {
      throw new Error("Couldn't reach Groq. Is the phone online?");
    }
    if (res.ok) return res;
    let msg = '';
    try {
      msg = ((await res.clone().json()) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      /* no body */
    }
    if (res.status === 401) throw new Error('Groq rejected the key. Check it in Settings (on the phone or on your Mac).');
    if (res.status === 429 && attempt < tries) {
      // The free plan limits how much can be sent per minute; Groq says how long to wait.
      const secs = Math.min(90, Math.max(2, Math.ceil(parseFloat(res.headers.get('retry-after') ?? '') || parseFloat(msg.match(/try again in ([\d.]+)s/i)?.[1] ?? '') || 20)));
      onWait?.(secs);
      await new Promise((r) => setTimeout(r, secs * 1000));
      continue;
    }
    if (res.status === 429) throw new Error(`Groq's free limit has been reached for now. ${msg}`.trim());
    if (res.status === 413) throw new Error('This recording is too large for Groq in one go.');
    throw new Error(`Groq answered ${res.status}${msg ? `: ${msg}` : ''}`);
  }
}

type Models = { speech: string; notes: string; at: number };
/** The best speech and notes models this key can use (names change over time, so they are looked up, not assumed). */
export async function models(): Promise<Models> {
  try {
    const cached = JSON.parse(store.get('hark.groqModels') || 'null') as Models | null;
    if (cached && Date.now() - cached.at < 7 * 864e5) return cached;
  } catch {
    /* look them up */
  }
  const res = await groq('/models', { method: 'GET' });
  const ids = (((await res.json()) as { data?: { id: string; active?: boolean }[] }).data ?? []).filter((m) => m.active !== false).map((m) => m.id);
  const first = (prefer: string[], fallback: (id: string) => boolean): string => prefer.find((p) => ids.includes(p)) ?? ids.find(fallback) ?? '';
  const speech = first(['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'], (id) => /whisper/i.test(id));
  const notes = first(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'qwen/qwen3-32b', 'llama-3.1-8b-instant'], (id) => !/whisper|guard|tts|playai|orpheus|compound/i.test(id));
  if (!speech) throw new Error("This Groq key can't use a speech-to-text model.");
  const m = { speech, notes, at: Date.now() };
  store.set('hark.groqModels', JSON.stringify(m));
  return m;
}

/** Check a key works. */
export async function checkKey(key: string): Promise<void> {
  const before = groqKey();
  setGroqKey(key);
  try {
    await models();
  } catch (err) {
    setGroqKey(before);
    throw err;
  }
}

type Segment = { start: number; end: number; text: string };
const LIMIT = 24 * 1024 * 1024;

async function transcribeOne(file: Blob, name: string, language: string, speech: string, onWait?: (s: number) => void): Promise<Segment[]> {
  const form = new FormData();
  form.append('file', file, name);
  form.append('model', speech);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  const res = await groq('/audio/transcriptions', { method: 'POST', body: form }, onWait);
  const j = (await res.json()) as { text?: string; segments?: Segment[]; duration?: number };
  if (j.segments?.length) return j.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text);
  return j.text?.trim() ? [{ start: 0, end: j.duration ?? 0, text: j.text.trim() }] : [];
}

/** 16-bit mono WAV from samples. */
function wav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Turn the recording into time-stamped paragraphs. Long recordings are sent in ten-minute pieces. */
export async function transcribe(audio: Blob, ext: string, language: string, onStage: (s: string) => void): Promise<{ paras: Para[]; duration: number }> {
  const { speech } = await models();
  const wait = (s: number) => onStage(`Groq's free plan is busy: waiting ${s} s`);
  let segments: Segment[] = [];
  let duration = 0;
  if (audio.size <= LIMIT) {
    onStage('Transcribing');
    segments = await transcribeOne(audio, `recording.${ext}`, language, speech, wait);
  } else {
    // Too big to send whole: decode at 16 kHz (all speech needs) and send in pieces.
    onStage('Preparing a long recording');
    const AC: typeof OfflineAudioContext = window.OfflineAudioContext ?? (window as any).webkitOfflineAudioContext;
    const decoded = await new AC(1, 16000, 16000).decodeAudioData(await audio.arrayBuffer());
    const pcm = decoded.getChannelData(0);
    duration = pcm.length / 16000;
    const piece = 600 * 16000;
    for (let at = 0, n = 0; at < pcm.length; at += piece, n++) {
      onStage(`Transcribing part ${n + 1} of ${Math.ceil(pcm.length / piece)}`);
      const segs = await transcribeOne(wav(pcm.subarray(at, Math.min(pcm.length, at + piece)), 16000), `part${n}.wav`, language, speech, wait);
      segments.push(...segs.map((s) => ({ ...s, start: s.start + at / 16000, end: s.end + at / 16000 })));
    }
  }
  duration = Math.max(duration, segments.at(-1)?.end ?? 0);
  // Join Whisper's short segments into paragraphs, breaking at pauses.
  const paras: Para[] = [];
  let cur: Segment | null = null;
  const push = () => {
    if (!cur) return;
    const text = cur.text.replace(/\s+/g, ' ').trim();
    if (text) paras.push({ id: `p${paras.length}`, sp: SPEAKER.id, s: cur.start, e: cur.end, text, words: retime(text, cur.start, cur.end) });
    cur = null;
  };
  for (const s of segments) {
    if (cur && (s.start - cur.end > 1.4 || cur.text.split(/\s+/).length > 70)) push();
    cur = cur ? { start: cur.start, end: s.end, text: `${cur.text} ${s.text}` } : { ...s };
  }
  push();
  return { paras, duration };
}

async function complete(system: string, prompt: string, maxTokens: number, onWait?: (s: number) => void): Promise<string> {
  const { notes } = await models();
  const res = await groq('/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: notes, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  }, onWait);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  // Some models show their working between <think> tags: only the answer is wanted.
  return (j.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Write the notes. Long conversations are read in parts, then summarised as a whole (as on the Mac). */
export async function summarize(paras: Para[], template: TemplateId, onStage: (s: string) => void): Promise<Summary> {
  const transcript = transcriptForLLM(paras, [SPEAKER]);
  const wait = (s: number) => onStage(`Groq's free plan is busy: waiting ${s} s`);
  const sys = summarySystem(template);
  if (transcript.length <= 36000) {
    onStage('Writing the notes');
    const s = parseSummary(await complete(sys, `Transcript:\n${transcript}\n\n${summaryInstruction(template)}`, 1500, wait), template);
    if (!s.overview && !s.keyPoints.length) throw new Error('Groq did not return usable notes. Try again.');
    return s;
  }
  const lines = transcript.split('\n');
  const parts: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length > 24000 && cur) (parts.push(cur), (cur = ''));
    cur += `${l}\n`;
  }
  if (cur) parts.push(cur);
  const merged = parseSummary('', template);
  const digest: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    onStage(`Reading part ${i + 1} of ${parts.length}`);
    const p = parseSummary(await complete(sys, `This is part ${i + 1} of ${parts.length} of a longer transcript.\n\n${parts[i]}\n\nWrite notes on THIS PART ONLY.\n\n${summaryInstruction(template)}`, 1100, wait), template);
    const seen = (list: string[], x: string) => list.some((y) => y.toLowerCase() === x.toLowerCase());
    for (const d of p.decisions) if (!seen(merged.decisions, d)) merged.decisions.push(d);
    for (const q of p.questions) if (!seen(merged.questions, q)) merged.questions.push(q);
    for (const a of p.actions) if (!merged.actions.some((x) => x.text.toLowerCase() === a.text.toLowerCase())) merged.actions.push(a);
    merged.chapters.push(...p.chapters.slice(0, 3));
    merged.cards.push(...p.cards.slice(0, 3));
    merged.keyPoints.push(...p.keyPoints.slice(0, 4));
    digest.push(`Part ${i + 1}: ${p.overview}\n${p.keyPoints.slice(0, 5).map((k) => `- ${k}`).join('\n')}`);
  }
  onStage('Writing the summary');
  const top = parseSummary(await complete(sys, `These are notes on consecutive parts of one long conversation:\n\n${digest.join('\n\n')}\n\nWrite, in EXACTLY this format:\n\nTITLE: <specific title for the whole conversation, at most 8 words>\nOVERVIEW: <3-5 sentences covering the whole conversation>\nKEY POINTS:\n- <the 6 to 10 most important points overall>\nTOPICS: <3-6 comma separated keywords>`, 900, wait), template);
  merged.title = top.title;
  merged.overview = top.overview;
  merged.topics = top.topics;
  if (top.keyPoints.length >= 3) merged.keyPoints = top.keyPoints;
  merged.chapters.sort((a, b) => a.t - b.t);
  return merged;
}

/** Answer a question about one conversation, from its transcript. */
export async function chat(paras: Para[], history: ChatMsg[], question: string): Promise<string> {
  const transcript = transcriptForLLM(paras, [SPEAKER]).slice(0, 60000);
  const past = history.slice(-6).map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.text}`).join('\n');
  return complete(
    'You answer questions about a recorded conversation using only its transcript. Be concise and specific. Cite the moment with its [m:ss] timestamp. If the transcript does not say, say so.',
    `Transcript:\n${transcript}\n\n${past ? `Earlier in this chat:\n${past}\n\n` : ''}Question: ${question}`,
    600,
  );
}
