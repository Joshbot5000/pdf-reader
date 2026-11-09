/**
 * Google Gemini (free tier via Google AI Studio) for the AI Assistant.
 *
 * - The best free Flash model this key can use is chosen from the live model
 *   list, so the app keeps working as Google renames models; if one model's
 *   free quota is used up (HTTP 429) the next one is tried automatically.
 * - PDFs are sent inline, so Gemini reads the pages themselves (layout,
 *   tables, scans). Answers cite pages as "[p. 3]", which the UI turns into
 *   clickable links.
 */
import { net, type WebContents } from 'electron';
import type { AiChatRequest, AiDoc, AiEvent, SlideOutline } from '../shared/ipc';
import { loadApiKey, loadState } from './store';
import { spaceDocs, spaceInstructions } from './ai';

const base = () => (process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
/** Inline request limit is 20 MB; leave room for the rest of the request. */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

const SYSTEM = `You are the AI assistant built into PDF Reader, a desktop app for reading and editing PDFs.
Answer questions about the documents the user has provided at the start of the conversation.

- Ground every answer in those documents. If they don't contain the answer, say so plainly, then offer general knowledge clearly labelled as such.
- Cite where information comes from, right after the statement, in square brackets: [p. 3] for a page of a PDF (the first page is p. 1). When there are several documents, include the document's title: [Lease.pdf, p. 3]. For a document without pages, use its title: [Notes].
- Write in clear Markdown: short paragraphs, bullet lists, **bold** for key terms, and headings only for longer answers.
- Be precise with names, dates, figures and defined terms. Explain in your own words; when exact wording matters (a contract clause, a statutory phrase), quote only the key words, never more than a sentence at a time.
- You cannot see edits the user makes after the conversation started.`;

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export class NoGeminiKeyError extends Error {
  constructor() {
    super('Add your free Google Gemini API key in Settings to use the AI Assistant.');
  }
}

class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function key(): Promise<string> {
  const k = await loadApiKey('gemini');
  if (!k) throw new NoGeminiKeyError();
  return k;
}

// ---------------------------------------------------------------- models

let modelCache: { key: string; models: Promise<string[]> } | null = null;

const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

/** Free-tier text models this key can use, best first (Flash, then Flash-Lite, newest first). */
export async function listModels(): Promise<string[]> {
  const k = await key();
  if (modelCache?.key === k) return modelCache.models;
  const models = (async () => {
    try {
      const res = await net.fetch(`${base()}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': k } });
      if (!res.ok) return FALLBACK_MODELS;
      const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const usable = (data.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
      const ranked = usable
        .map((name) => {
          const m = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(name);
          return m ? { name, version: Number(m[1]), lite: !!m[2] } : null;
        })
        .filter((x): x is { name: string; version: number; lite: boolean } => !!x)
        .sort((a, b) => Number(a.lite) - Number(b.lite) || b.version - a.version)
        .map((x) => x.name);
      const aliases = FALLBACK_MODELS.filter((a) => usable.includes(a));
      const list = [...ranked.filter((n) => !n.includes('lite')), ...aliases, ...ranked.filter((n) => n.includes('lite'))];
      return list.length ? [...new Set(list)] : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    }
  })();
  modelCache = { key: k, models };
  return models;
}

/** Models to try, in order: the one chosen in Settings first, then the automatic ranking. */
async function modelOrder(): Promise<string[]> {
  const chosen = (await loadState()).settings.geminiModel;
  const ranked = await listModels();
  return chosen && chosen !== 'auto' ? [chosen, ...ranked.filter((m) => m !== chosen)] : ranked;
}

let lastModel: string | null = null;
export const currentModel = () => lastModel;

// ---------------------------------------------------------------- requests

function toParts(docs: AiDoc[]): Part[] {
  return docs.map((d) =>
    d.kind === 'pdf'
      ? { inline_data: { mime_type: 'application/pdf', data: Buffer.from(d.data).toString('base64') } }
      : { text: `<document title="${d.title.replace(/"/g, "'")}">\n${d.text}\n</document>` },
  );
}

function checkSize(docs: AiDoc[]) {
  const bytes = docs.reduce((n, d) => n + (d.kind === 'pdf' ? (d.data.byteLength * 4) / 3 : d.text.length), 0);
  if (bytes > MAX_INLINE_BYTES) {
    throw new Error(
      `These documents are too large for Gemini in one request (about ${Math.round(bytes / 1e6)} MB; the limit is about 18 MB). Try fewer or smaller files.`,
    );
  }
}

function describe(status: number, body: string): string {
  let msg = body;
  try {
    msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    /* not JSON */
  }
  if (status === 400 && /api key/i.test(msg)) return 'Your Gemini API key was rejected. Check it in Settings.';
  if (status === 403) return 'This Gemini API key isn’t allowed to use the Gemini API. Create a new key in Google AI Studio.';
  if (status === 429) return 'You’ve reached Gemini’s free usage limit for now. It resets daily; try again later, or a little more slowly.';
  return `Gemini error ${status}: ${msg.slice(0, 300)}`;
}

/** POST to a model, trying the next model if this one is unavailable or out of free quota. */
async function post(path: (model: string) => string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const k = await key();
  let last: GeminiError | null = null;
  for (const model of await modelOrder()) {
    const res = await net.fetch(`${base()}/v1beta/models/${model}:${path(model)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': k },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) {
      lastModel = model;
      return res;
    }
    const text = await res.text();
    last = new GeminiError(describe(res.status, text), res.status);
    console.warn(`Gemini ${model} → HTTP ${res.status}: ${text.slice(0, 500)}`);
    // A bad key fails the same way on every model: stop. Anything else (quota
    // used up, model retired or not offered to this account, overloaded):
    // try the next model.
    if (res.status === 401 || (res.status === 400 && /api[_ ]?key/i.test(text))) throw last;
  }
  throw last ?? new Error('No Gemini model is available for this key.');
}

// ---------------------------------------------------------------- streaming

/** Read a streamed (SSE) response, passing answer text to `onText`. */
async function readStream(res: Response, onText: (t: string) => void) {
  let blocked: string | null = null;
  let finish: string | null = null;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (chunk: string) => {
    const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return;
    const json = JSON.parse(data) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      error?: { code?: number; message?: string };
    };
    if (json.error) throw new GeminiError(describe(json.error.code ?? 500, JSON.stringify(json)), json.error.code ?? 500);
    if (json.promptFeedback?.blockReason) blocked = json.promptFeedback.blockReason;
    const cand = json.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) if (part.text && !part.thought) onText(part.text);
    if (cand?.finishReason) finish = cand.finishReason;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      handle(buffer.slice(0, cut));
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
    }
  }
  if (buffer.trim()) handle(buffer);
  return { blocked, finish } as { blocked: string | null; finish: string | null };
}

/** A clear explanation when Gemini ends without an answer. */
function finishMessage(reason: string | null): string {
  switch (reason) {
    case 'RECITATION':
      return 'Gemini stopped because its answer repeated too much of the document word for word. Try asking for a summary “in your own words”, or about a smaller section.';
    case 'SAFETY':
    case 'BLOCKED':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'Gemini’s safety filter blocked this answer. Try rephrasing the question.';
    case 'MAX_TOKENS':
      return 'Gemini ran out of room before answering. Try a narrower question or a shorter document.';
    default:
      return `Gemini returned no answer${reason ? ` (${reason})` : ''}. Please try again.`;
  }
}

/** Send a tiny request to check the key and find a working model. */
export async function testConnection(): Promise<{ ok: boolean; model: string | null; message: string }> {
  try {
    const res = await post(() => 'generateContent', { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] });
    await res.json();
    return { ok: true, model: lastModel, message: `Connected. Using ${lastModel}.` };
  } catch (err) {
    return { ok: false, model: null, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- chat

interface Conversation {
  system: string;
  contents: Content[];
}
const conversations = new Map<string, Conversation>();
const running = new Map<string, AbortController>();
let nextId = 1;

export const forget = (id: string) => conversations.delete(id);
export const cancel = (id: string) => running.get(id)?.abort();

export async function chat(sender: WebContents, req: AiChatRequest): Promise<string> {
  const requestId = `gem-${nextId++}`;
  const emit = (e: AiEvent) => {
    if (!sender.isDestroyed()) sender.send('ai:event', e);
  };
  await key();
  let convo = conversations.get(req.conversationId);
  if (!convo) {
    const docs = req.spaceId ? await spaceDocs(req.spaceId) : (req.docs ?? []);
    checkSize(docs);
    convo = { system: SYSTEM + (await spaceInstructions(req.spaceId)), contents: [] };
    const titles = docs.length > 1 ? `\n\nThe documents, in order: ${docs.map((d, i) => `${i + 1}. ${d.title}`).join('; ')}.` : '';
    convo.contents.push({ role: 'user', parts: [...toParts(docs), { text: req.text + titles }] });
    conversations.set(req.conversationId, convo);
  } else {
    convo.contents.push({ role: 'user', parts: [{ text: req.text }] });
  }
  const conversation = convo;
  const controller = new AbortController();
  running.set(requestId, controller);

  void (async () => {
    let answer = '';
    try {
      emit({ requestId, type: 'thinking' });
      let finish: string | null = null;
      let blocked: string | null = null;
      // Gemini sometimes stops an answer that repeats source text word for word
      // ("RECITATION"); if that happens before any text, retry once asking it to paraphrase.
      for (let attempt = 0; attempt < 2; attempt++) {
        const system =
          attempt === 0
            ? conversation.system
            : `${conversation.system}\n\nIMPORTANT: Answer entirely in your own words. Do not reproduce passages from the documents; quote at most a few words.`;
        const res = await post(
          () => 'streamGenerateContent?alt=sse',
          // No output cap: newer models think before answering, and a cap can end the reply before it starts.
          { systemInstruction: { parts: [{ text: system }] }, contents: conversation.contents },
          controller.signal,
        );
        ({ finish, blocked } = await readStream(res, (t) => {
          answer += t;
          emit({ requestId, type: 'delta', text: t });
        }));
        if (answer || blocked || finish !== 'RECITATION') break;
      }
      if (!answer) {
        conversation.contents.pop();
        if (conversation.contents.length === 0) conversations.delete(req.conversationId);
        emit({ requestId, type: 'error', message: finishMessage(blocked ? 'BLOCKED' : finish) });
        return;
      }
      conversation.contents.push({ role: 'model', parts: [{ text: answer }] });
      emit({ requestId, type: 'done', blocks: [{ text: answer, citations: [] }], stopReason: finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn' });
    } catch (err) {
      if (conversation.contents[conversation.contents.length - 1]?.role === 'user') {
        if (conversation.contents.length === 1) conversations.delete(req.conversationId);
        else conversation.contents.pop();
      }
      emit({
        requestId,
        type: 'error',
        message: controller.signal.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err),
      });
    } finally {
      running.delete(requestId);
    }
  })();
  return requestId;
}

// ---------------------------------------------------------------- slides

export async function slides(req: { docs?: AiDoc[]; spaceId?: string; focus: string }): Promise<SlideOutline> {
  const docs = req.spaceId ? await spaceDocs(req.spaceId) : (req.docs ?? []);
  checkSize(docs);
  const str = { type: 'STRING' };
  const res = await post(() => 'generateContent', {
    systemInstruction: { parts: [{ text: SYSTEM + (await spaceInstructions(req.spaceId)) }] },
    contents: [
      {
        role: 'user',
        parts: [
          ...toParts(docs),
          {
            text:
              'Turn these documents into a clear, engaging presentation deck: a title, a one-line subtitle, and 5 to 12 content slides, ' +
              'each with 3 to 5 concise bullet points (under 18 words each) and 2 to 4 sentences of speaker notes. Do not include page citations.' +
              (req.focus.trim() ? ` Focus: ${req.focus.trim()}` : ''),
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: str,
          subtitle: str,
          slides: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { title: str, bullets: { type: 'ARRAY', items: str }, notes: str }, required: ['title', 'bullets', 'notes'] },
          },
        },
        required: ['title', 'subtitle', 'slides'],
      },
    },
  });
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  try {
    const outline = JSON.parse(text) as SlideOutline;
    if (!outline.title || !Array.isArray(outline.slides) || !outline.slides.length) throw new Error('empty');
    outline.slides = outline.slides.map((s) => ({ title: s.title ?? '', bullets: Array.isArray(s.bullets) ? s.bullets : [], notes: s.notes ?? '' }));
    outline.subtitle ??= '';
    return outline;
  } catch {
    throw new Error('Gemini did not return a usable outline. Try again.');
  }
}
