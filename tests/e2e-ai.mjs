// AI Assistant end-to-end test against a local mock of the Anthropic Messages
// API: checks the request the app sends (model, PDF document block with
// citations, prompt caching, refusal fallback, conversation history) and that
// streamed answers, citations and the slide outline render in the UI.
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { tenancyAgreement } from './sample-docs.mjs';

const requests = [];
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const message = (content, stop = 'end_turn') => ({
  id: `msg_${requests.length}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 40 },
});

const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = JSON.parse(body);
  requests.push({ headers: req.headers, body: json });
  if (json.output_config?.format) {
    // Structured output (slides): return JSON text, non-streaming.
    const outline = {
      title: 'Your Tenancy at a Glance',
      subtitle: 'Key terms of the assured shorthold tenancy',
      slides: [
        { title: 'Rent and deposit', bullets: ['£1,850 per month in advance', 'Deposit protected within 30 days'], notes: 'Cover money first.' },
        { title: 'Your obligations', bullets: ['Keep the interior clean', 'No subletting without consent'], notes: 'Tenant duties.' },
      ],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message([{ type: 'text', text: JSON.stringify(outline) }])));
    return;
  }
  const turn = json.messages.filter((m) => m.role === 'user').length;
  const answer = turn === 1 ? 'The rent is **£1,850 per month**, paid in advance.' : 'The deposit is £2,134.61.';
  const cited = 'The rent is £1,850 per calendar month, payable in advance';
  sse(res, [
    { type: 'message_start', message: message([], null) },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: [] } },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'citations_delta',
        citation: { type: 'page_location', cited_text: cited, document_index: 0, document_title: 'Tenancy agreement.pdf', start_page_number: 1, end_page_number: 2 },
      },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer.slice(0, 20) } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer.slice(20) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'pdf-reader-ai-'));
const userData = join(dir, 'profile');
mkdirSync(userData);
// This suite covers the Claude provider; tests/e2e-gemini.mjs covers Gemini.
writeFileSync(join(userData, 'state.json'), JSON.stringify({ settings: { theme: 'system', aiProvider: 'claude' } }));
const pdfPath = join(dir, 'Tenancy agreement.pdf');
writeFileSync(pdfPath, await tenancyAgreement());

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', 'out/main/index.js', pdfPath],
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: '',
    PDF_READER_USER_DATA: userData,
    ANTHROPIC_API_KEY: 'sk-ant-test-mock',
    ANTHROPIC_BASE_URL: base,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1440, height: 900 });
const shots = process.env.E2E_SCREENSHOTS;
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  if (shots) await win.screenshot({ path: join(shots, `ai-${name.replace(/\W+/g, '-')}.png`) });
  console.log('ok');
};

await win.waitForSelector('.page .textLayer span');

await step('summarize action streams a cited answer', async () => {
  await win.click('.ai-cta');
  await win.waitForSelector('#assistant .chat');
  assert.equal(await win.locator('.key-banner').count(), 0, 'key from environment is picked up');
  await win.click('#assistant .chip.action:has-text("Summarize")');
  await win.waitForSelector('#assistant .msg.assistant .md strong');
  assert.match(await win.locator('#assistant .msg.assistant .md').innerText(), /£1,850 per month/);
  assert.equal(await win.locator('#assistant .msg.user .bubble').innerText(), 'Summarize');
  await win.waitForSelector('#assistant .source >> text=p.1');
});

await step('first request carries the PDF, citations, caching and fallback', async () => {
  const r = requests[0].body;
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual(r.thinking, { type: 'adaptive' });
  assert.equal(r.fallbacks, 'default');
  assert.match(String(requests[0].headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  const auth = requests[0].headers['x-api-key'] ?? requests[0].headers.authorization;
  assert.match(String(auth), /sk-ant-test-mock/, `auth header: ${JSON.stringify(Object.keys(requests[0].headers))}`);
  const [docBlock, text] = r.messages[0].content;
  assert.equal(docBlock.type, 'document');
  assert.equal(docBlock.source.media_type, 'application/pdf');
  assert.ok(docBlock.source.data.length > 1000);
  assert.deepEqual(docBlock.citations, { enabled: true });
  assert.deepEqual(docBlock.cache_control, { type: 'ephemeral' });
  assert.match(text.text, /Summarize this document/);
});

await step('follow-up keeps history including thinking blocks', async () => {
  await win.fill('#assistant .chat-input', 'How much is the deposit?');
  await win.keyboard.press('Enter');
  await win.waitForSelector('#assistant .msg.assistant >> nth=1 >> text=2,134.61');
  const r = requests[1].body;
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[1].role, 'assistant');
  assert.equal(r.messages[1].content[0].type, 'thinking', 'assistant turn replayed unchanged');
  assert.equal(r.messages[2].content, 'How much is the deposit?');
  assert.equal(r.messages[0].content[0].type, 'document', 'document stays at the start for caching');
});

await step('citation jumps to the page', async () => {
  await win.click('#assistant .source >> nth=0');
  await win.waitForFunction(() => /\d+\/\d+/.test(document.querySelector('.search-count')?.textContent ?? ''));
});

await step('remix into slides shows the outline', async () => {
  await win.click('#assistant .chip.special');
  await win.fill('.modal input', 'for a new tenant');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.slides-preview .title-slide >> text=Your Tenancy at a Glance');
  assert.equal(await win.locator('.slides-preview .slide').count(), 3);
  const r = requests[2].body;
  assert.equal(r.output_config.format.type, 'json_schema');
  assert.equal(r.messages[0].content[0].citations, undefined, 'citations off with structured output');
  await win.keyboard.press('Escape');
});

await app.close();
server.close();
assert.deepEqual(errors, [], 'no renderer errors');
console.log('\nAll AI e2e checks passed.');
