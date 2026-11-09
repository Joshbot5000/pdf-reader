// AI Assistant end-to-end test with the free Gemini provider, against a local
// mock of the Gemini API: picks the best free Flash model from the model list,
// falls back to the next model when the first is out of free quota, sends the
// PDF inline, streams the answer, links "[p. N]" references to pages, keeps the
// conversation history, and builds a slide outline from structured JSON output.
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { tenancyAgreement } from './sample-docs.mjs';

const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, 'http://x');
  requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: body ? JSON.parse(body) : null });
  if (req.method === 'GET' && url.pathname === '/v1beta/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      models: [
        { name: 'models/gemini-9.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-9.9-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-9.9-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-9.9-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
      ],
    }));
    return;
  }
  const [, model, method] = /models\/([^:]+):(\w+)/.exec(url.pathname) ?? [];
  if (model === 'gemini-9.9-flash') {
    // Best model's free quota is used up: the app should move on to the next one.
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }));
    return;
  }
  if (model === 'gemini-9.5-flash') {
    // Older model not offered to this account (not a quota error): skip it too.
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 403, message: 'This model is not available to new users.', status: 'PERMISSION_DENIED' } }));
    return;
  }
  const json = JSON.parse(body);
  if (method === 'generateContent') {
    const outline = { title: 'Tenancy Essentials', subtitle: 'What the tenant needs to know', slides: [
      { title: 'Rent', bullets: ['£1,850 per month', 'Paid in advance'], notes: 'Money first.' },
      { title: 'Deposit', bullets: ['Protected within 30 days'], notes: 'Deposit rules.' },
    ] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(outline) }] }, finishReason: 'STOP' }] }));
    return;
  }
  const turn = json.contents.filter((c) => c.role === 'user').length;
  if (turn === 1 && !/IMPORTANT: Answer entirely in your own words/.test(json.systemInstruction.parts[0].text)) {
    // First try stops for "recitation" before any text: the app should retry asking to paraphrase.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'RECITATION' }] })}\r\n\r\n`);
    return;
  }
  const chunks = turn === 1
    ? ['The rent is **£1,850 per month** [p. 1], paid ', 'in advance. The deposit is protected [p. 1].']
    : ['The landlord repairs the structure [p. 1].'];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [i, t] of chunks.entries()) {
    const cand = { content: { role: 'model', parts: [{ text: t }] }, ...(i === chunks.length - 1 ? { finishReason: 'STOP' } : {}) };
    res.write(`data: ${JSON.stringify({ candidates: [cand] })}\r\n\r\n`);
  }
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'pdf-reader-gemini-'));
const userData = join(dir, 'profile');
mkdirSync(userData);
const pdfPath = join(dir, 'Tenancy agreement.pdf');
writeFileSync(pdfPath, await tenancyAgreement());

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', 'out/main/index.js', pdfPath],
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: '',
    PDF_READER_USER_DATA: userData,
    GEMINI_API_KEY: 'AIza-test-mock',
    GEMINI_BASE_URL: base,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1440, height: 900 });
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log('ok');
};
await win.waitForSelector('.page .textLayer span');

await step('Gemini is the default provider and needs no Claude key', async () => {
  await win.click('.ai-cta');
  await win.waitForSelector('#assistant .chat');
  assert.equal(await win.locator('.key-banner').count(), 0);
  assert.match(await win.locator('.assistant-model').innerText(), /Gemini · free/);
});

await step('skips unavailable models, retries a recitation stop, and streams a cited answer', async () => {
  await win.click('#assistant .chip.action:has-text("Summarize")');
  await win.waitForSelector('#assistant .msg.assistant .md strong');
  const posts = requests.filter((r) => r.method === 'POST');
  assert.deepEqual(posts.map((r) => r.path.split('/').pop()), [
    'gemini-9.9-flash:streamGenerateContent', // 429 quota used up
    'gemini-9.5-flash:streamGenerateContent', // 403 not offered to this account
    'gemini-9.9-flash-lite:streamGenerateContent', // RECITATION, no text
    'gemini-9.9-flash', // retry on the same chain…
    'gemini-9.5-flash',
    'gemini-9.9-flash-lite:streamGenerateContent', // …succeeds
  ].map((p) => (p.includes(':') ? p : `${p}:streamGenerateContent`)));
  assert.equal(posts[0].headers['x-goog-api-key'], 'AIza-test-mock');
  assert.equal(posts[2].body.generationConfig, undefined, 'no output cap (thinking models need room)');
  assert.match(posts[5].body.systemInstruction.parts[0].text, /IMPORTANT: Answer entirely in your own words/);
  const body = posts[5].body;
  assert.match(body.systemInstruction.parts[0].text, /\[p\. 3\]/);
  const [pdfPart, question] = body.contents[0].parts;
  assert.equal(pdfPart.inline_data.mime_type, 'application/pdf');
  assert.ok(pdfPart.inline_data.data.length > 1000);
  assert.match(question.text, /Summarize this document/);
  // "[p. 1]" became a clickable citation, shown once in the sources list.
  assert.equal(await win.locator('#assistant .msg.assistant .md .cite').count(), 2);
  assert.equal(await win.locator('#assistant .source').count(), 1);
  assert.doesNotMatch(await win.locator('#assistant .msg.assistant .md').innerText(), /\[p\. 1\]/);
});

await step('follow-up questions keep the conversation', async () => {
  await win.fill('#assistant .chat-input', 'Who repairs the structure?');
  await win.keyboard.press('Enter');
  await win.waitForSelector('#assistant .msg.assistant >> nth=1 >> text=landlord repairs');
  const last = requests.filter((r) => r.method === 'POST').pop().body;
  assert.deepEqual(last.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(last.contents[2].parts[0].text, 'Who repairs the structure?');
});

await step('citation jumps to the page', async () => {
  await win.click('#assistant .source >> nth=0');
  await win.waitForFunction(() => document.querySelector('#pager .pager-input')?.value === '1');
});

await step('remix into slides uses structured JSON output', async () => {
  await win.click('#assistant .chip.special');
  await win.fill('.modal input', '');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.slides-preview .title-slide >> text=Tenancy Essentials');
  assert.equal(await win.locator('.slides-preview .slide').count(), 3);
  const req = requests.filter((r) => r.path.endsWith(':generateContent')).pop().body;
  assert.equal(req.generationConfig.responseMimeType, 'application/json');
  assert.equal(req.generationConfig.responseSchema.type, 'OBJECT');
  await win.keyboard.press('Escape');
});

await step('Settings can test the Gemini connection', async () => {
  await win.click('.rail-btn[title="Settings"]');
  await win.click('.modal button:has-text("Test connection")');
  await win.waitForSelector('.test-result.ok');
  assert.match(await win.locator('.test-result').innerText(), /Connected\. Using gemini-9\.9-flash-lite/);
  await win.keyboard.press('Escape');
});

await app.close();
server.close();
assert.deepEqual(errors, [], 'no renderer errors');
console.log('\nAll Gemini e2e checks passed.');
