/**
 * Claude integration (main process only, so the API key never reaches the UI).
 *
 * - Chat: streams answers about the open PDF or a Space's sources, with
 *   citations. Each conversation's full history (including the assistant's
 *   thinking blocks) is kept here and appended to, never edited.
 * - Slides: structured output describing a deck, exported with pptxgenjs.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { AiBlock, AiChatRequest, AiDoc, AiEvent, SlideOutline } from '../shared/ipc';
import { loadApiKey, loadState, spacesDir } from './store';

const MODEL = 'claude-opus-5-5';
/** Server-side refusal fallback: re-runs a declined request on Anthropic's recommended model. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_REQUEST_BYTES = 30 * 1024 * 1024; // API limit is 32 MB; leave headroom for JSON overhead

const SYSTEM = `You are the AI assistant built into PDF Reader, a desktop app for reading and editing PDFs.
You answer questions about the documents the user has provided, which appear at the start of the conversation.

- Ground every answer in those documents and cite the passages you rely on. If the documents do not contain the answer, say so plainly, then offer general knowledge clearly labelled as such.
- Write in clear, well-structured Markdown: short paragraphs, bullet lists, **bold** for key terms, and headings only for longer answers.
- Be precise with names, dates, figures and defined terms; quote exact wording when it matters (for example contract clauses or statutory language).
- You cannot see edits the user makes after the conversation started.`;

let client: Anthropic | null = null;
let clientKey: string | null = null;

export class NoApiKeyError extends Error {
  constructor() {
    super('Add your Anthropic API key in Settings to use Claude.');
  }
}

async function getClient(): Promise<Anthropic> {
  const key = await loadApiKey('claude');
  if (!key) throw new NoApiKeyError();
  if (!client || key !== clientKey) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

export function resetClient() {
  client = null;
  clientKey = null;
}

// ---------------------------------------------------------------- sources

type DocBlock = Anthropic.Beta.BetaRequestDocumentBlock;

function toDocBlocks(docs: AiDoc[], citations: boolean): DocBlock[] {
  const blocks: DocBlock[] = docs.map((d) =>
    d.kind === 'pdf'
      ? {
          type: 'document',
          title: d.title,
          source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(d.data).toString('base64') },
          ...(citations ? { citations: { enabled: true } } : {}),
        }
      : {
          type: 'document',
          title: d.title,
          source: { type: 'text', media_type: 'text/plain', data: d.text },
          ...(citations ? { citations: { enabled: true } } : {}),
        },
  );
  // Cache everything up to and including the last document: follow-up
  // questions re-send the same prefix and read it from the cache.
  if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  return blocks;
}

export async function spaceDocs(spaceId: string): Promise<AiDoc[]> {
  const space = (await loadState()).spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error('That Space no longer exists.');
  if (!space.sources.length) throw new Error('Add at least one source to this Space first.');
  return Promise.all(
    space.sources.map(async (src): Promise<AiDoc> => {
      const data = await readFile(join(spacesDir(), space.id, src.file));
      return src.kind === 'pdf'
        ? { kind: 'pdf', title: src.title, data: new Uint8Array(data) }
        : { kind: 'text', title: src.url ? `${src.title} (${src.url})` : src.title, text: data.toString('utf8') };
    }),
  );
}

export async function spaceInstructions(spaceId?: string): Promise<string> {
  if (!spaceId) return '';
  const space = (await loadState()).spaces.find((s) => s.id === spaceId);
  return space?.instructions.trim() ? `\n\nThe user set these instructions for this Space:\n${space.instructions.trim()}` : '';
}

function checkSize(docs: AiDoc[]) {
  const bytes = docs.reduce((n, d) => n + (d.kind === 'pdf' ? (d.data.byteLength * 4) / 3 : d.text.length), 0);
  if (bytes > MAX_REQUEST_BYTES) {
    throw new Error(
      `These documents are too large to send in one request (about ${Math.round(bytes / 1e6)} MB; the limit is 32 MB). Try fewer or smaller files.`,
    );
  }
}

// ---------------------------------------------------------------- chat

interface Conversation {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
}
const conversations = new Map<string, Conversation>();
const running = new Map<string, AbortController>();
let nextId = 1;

export function forget(conversationId: string) {
  conversations.delete(conversationId);
}

export function cancel(requestId: string) {
  running.get(requestId)?.abort();
}

function friendlyError(err: unknown): string {
  if (err instanceof NoApiKeyError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Your API key does not have access to this model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function toAiBlocks(content: Anthropic.Beta.BetaContentBlock[]): AiBlock[] {
  const out: AiBlock[] = [];
  for (const block of content) {
    if (block.type !== 'text') continue;
    const citations = (block.citations ?? []).flatMap((c) => {
      if (c.type === 'page_location') {
        return [{ citedText: c.cited_text, documentIndex: c.document_index, documentTitle: c.document_title, startPage: c.start_page_number, endPage: c.end_page_number }];
      }
      if (c.type === 'char_location' || c.type === 'content_block_location') {
        return [{ citedText: c.cited_text, documentIndex: c.document_index, documentTitle: c.document_title }];
      }
      return [];
    });
    out.push({ text: block.text, citations });
  }
  return out;
}

export async function chat(sender: WebContents, req: AiChatRequest): Promise<string> {
  const requestId = `ai-${nextId++}`;
  const emit = (e: AiEvent) => {
    if (!sender.isDestroyed()) sender.send('ai:event', e);
  };

  // Validate and build the conversation before returning, so setup errors
  // (missing key, oversized documents) reach the caller directly.
  const anthropic = await getClient();
  let convo = conversations.get(req.conversationId);
  if (!convo) {
    const docs = req.spaceId ? await spaceDocs(req.spaceId) : (req.docs ?? []);
    checkSize(docs);
    convo = { system: SYSTEM + (await spaceInstructions(req.spaceId)), messages: [] };
    convo.messages.push({ role: 'user', content: [...toDocBlocks(docs, true), { type: 'text', text: req.text }] });
    conversations.set(req.conversationId, convo);
  } else {
    convo.messages.push({ role: 'user', content: req.text });
  }
  const conversation = convo;

  const controller = new AbortController();
  running.set(requestId, controller);
  void (async () => {
    try {
      const stream = anthropic.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 32000,
          system: conversation.system,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          messages: conversation.messages,
        },
        { signal: controller.signal },
      );
      let sentThinking = false;
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'thinking' && !sentThinking) {
          sentThinking = true;
          emit({ requestId, type: 'thinking' });
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emit({ requestId, type: 'delta', text: event.delta.text });
        }
      }
      const message = await stream.finalMessage();
      // Keep the assistant turn exactly as returned so later turns stay valid.
      conversation.messages.push({ role: 'assistant', content: message.content });
      if (message.stop_reason === 'refusal') {
        emit({ requestId, type: 'error', message: 'Claude declined to answer this request.' });
        return;
      }
      emit({ requestId, type: 'done', blocks: toAiBlocks(message.content), stopReason: message.stop_reason });
    } catch (err) {
      // Drop the unanswered user turn so the history stays well-formed.
      if (conversation.messages[conversation.messages.length - 1]?.role === 'user') {
        if (conversation.messages.length === 1) conversations.delete(req.conversationId);
        else conversation.messages.pop();
      }
      emit({
        requestId,
        type: 'error',
        message: controller.signal.aborted ? 'Stopped.' : friendlyError(err),
      });
    } finally {
      running.delete(requestId);
    }
  })();
  return requestId;
}

// ---------------------------------------------------------------- slides

const SlideSchema = z.object({
  title: z.string().describe('Deck title'),
  subtitle: z.string().describe('One-line subtitle'),
  slides: z
    .array(
      z.object({
        title: z.string(),
        bullets: z.array(z.string()).describe('3 to 5 concise bullet points, each under 18 words'),
        notes: z.string().describe('Speaker notes, 2 to 4 sentences'),
      }),
    )
    .describe('Between 5 and 12 content slides'),
});

export async function slides(req: { docs?: AiDoc[]; spaceId?: string; focus: string }): Promise<SlideOutline> {
  try {
    const anthropic = await getClient();
    const docs = req.spaceId ? await spaceDocs(req.spaceId) : (req.docs ?? []);
    checkSize(docs);
    const response = await anthropic.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM + (await spaceInstructions(req.spaceId)),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(SlideSchema) },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            ...toDocBlocks(docs, false),
            {
              type: 'text',
              text: `Turn these documents into a clear, engaging presentation deck.${req.focus.trim() ? ` Focus: ${req.focus.trim()}` : ''}`,
            },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to create this presentation.');
    if (!response.parsed_output) throw new Error('Claude did not return a usable outline. Try again.');
    return response.parsed_output;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}
