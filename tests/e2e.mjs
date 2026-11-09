// End-to-end test: launches the built app with a generated PDF, then searches,
// adds text, highlights, fills a form, rotates and deletes pages, saves, and
// verifies the saved file. Run with `npm run test:e2e` (needs a display; on
// Linux CI use `xvfb-run -a npm run test:e2e`).
import { _electron as electron } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import electronPath from 'electron';

const dir = mkdtempSync(join(tmpdir(), 'pdf-reader-e2e-'));
const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const pdfPath = join(dir, 'sample.pdf');

// ---- fixture
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    ['Duty of care', 'The tort of negligence requires a duty of care, breach and damage.'],
    ['Breach', 'Breach is judged against the reasonable person. Negligence again.'],
    ['Remoteness', 'Damage must not be too remote.'],
  ];
  lines.forEach(([title, body]) => {
    const page = doc.addPage([595, 842]);
    page.drawText(title, { x: 60, y: 760, size: 22, font });
    page.drawText(body, { x: 60, y: 720, size: 12, font });
  });
  const form = doc.getForm();
  form.createTextField('student').addToPage(doc.getPage(0), { x: 60, y: 640, width: 220, height: 22 });
  writeFileSync(pdfPath, await doc.save());
}

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', 'out/main/index.js', pdfPath],
  env: { ...process.env, ELECTRON_RENDERER_URL: '' },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
win.on('dialog', (d) => void d.accept());
await win.setViewportSize({ width: 1280, height: 860 });

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  if (shots) await win.screenshot({ path: join(shots, `${name.replace(/\W+/g, '-')}.png`) });
  console.log('ok');
};
const settle = () => win.waitForFunction(() => !document.querySelector('#status-msg')?.textContent?.startsWith('Applying'));
const pageBox = async (i) => {
  // Bring the top of page i into view before using its coordinates.
  await win.evaluate((i) => {
    const v = document.querySelector('#viewer');
    v.scrollTo({ top: document.querySelectorAll('.page')[i].offsetTop - 12, behavior: 'instant' });
  }, i);
  await win.waitForTimeout(100);
  return win.locator('.page').nth(i).boundingBox();
};

await step('opens the file passed on the command line', async () => {
  await win.waitForSelector('.page .textLayer span');
  assert.equal(await win.locator('.page').count(), 3);
  assert.match(await win.locator('#status-file').innerText(), /sample\.pdf/);
});

await step('searches and highlights matches', async () => {
  await win.fill('#search', 'negligence');
  await win.waitForFunction(() => document.querySelector('#search-count')?.textContent === '1 of 2');
  assert.ok((await win.locator('.hl').count()) >= 2);
  await win.press('#search', 'Enter');
  assert.equal(await win.locator('#search-count').innerText(), '2 of 2');
  await win.waitForFunction(() => document.querySelector('#status-page')?.textContent === 'Page 2 of 3');
});

await step('adds text with the text tool', async () => {
  await win.click('[data-tool="text"]');
  const b = await pageBox(0);
  await win.mouse.click(b.x + 60, b.y + 300);
  await win.keyboard.type('Added by the e2e test');
  await win.keyboard.press('Enter');
  await settle();
  await win.waitForFunction(() =>
    [...document.querySelectorAll('.page')][0].querySelector('.textLayer')?.textContent?.includes('Added by the e2e test'),
  );
});

await step('highlights an area', async () => {
  await win.click('[data-tool="highlight"]');
  const b = await pageBox(0);
  await win.mouse.move(b.x + 50, b.y + 60);
  await win.mouse.down();
  await win.mouse.move(b.x + 300, b.y + 110, { steps: 5 });
  await win.mouse.up();
  await settle();
});

await step('fills a form field', async () => {
  await win.click('#btn-forms');
  await win.fill('#forms-body input', 'Josh');
  await win.click('#forms-body .apply');
  await settle();
  await win.waitForFunction(() => document.querySelector('#forms-body input')?.value === 'Josh');
});

await step('rotates and deletes pages, then undoes and redoes', async () => {
  await win.click('[data-tool="select"]');
  await win.click('.thumb >> nth=1');
  await win.click('#btn-rot-r');
  await settle();
  await win.click('.thumb >> nth=2');
  await win.click('#btn-delete');
  await settle();
  assert.equal(await win.locator('.page').count(), 2);
  await win.locator('#viewer').focus();
  await win.keyboard.press('Control+z');
  await win.waitForFunction(() => document.querySelectorAll('.page').length === 3);
  await win.keyboard.press('Control+Shift+z');
  await win.waitForFunction(() => document.querySelectorAll('.page').length === 2);
});

await step('saves to disk', async () => {
  assert.match(await win.title(), /•/);
  await win.click('#btn-save');
  await win.waitForFunction(() => !document.title.includes('•'));
});

await app.close();

// ---- verify the saved file independently
const saved = readFileSync(pdfPath);
const lib = await PDFDocument.load(saved);
assert.equal(lib.getPageCount(), 2, 'page 3 deleted');
assert.equal(lib.getPage(1).getRotation().angle, 90, 'page 2 rotated');
assert.equal(lib.getForm().getTextField('student').getText(), 'Josh', 'form filled');
const js = await getDocument({ data: new Uint8Array(saved), verbosity: 0 }).promise;
const text = (await (await js.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
assert.match(text, /Added by the e2e test/, 'text added to page 1');
assert.deepEqual(errors, [], 'no renderer errors');
console.log(`\nAll e2e checks passed. Saved file: ${pdfPath}`);
