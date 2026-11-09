// End-to-end test: launches the built app with a sample tenancy agreement and
// exercises search, editing, signing, forms, form building, organizing,
// redaction (with OCR), branding, compare, Spaces and the command palette,
// then saves and verifies the file independently with pdf-lib and pdf.js.
//
// Run with `npm run test:e2e` (needs a display; on Linux CI use
// `xvfb-run -a npm run test:e2e`). Set E2E_SCREENSHOTS=dir for screenshots.
import { _electron as electron } from 'playwright-core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import electronPath from 'electron';
import { tenancyAgreement } from './sample-docs.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pdf-reader-e2e-'));
const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const userData = join(dir, 'profile');
mkdirSync(userData);
const pdfPath = join(dir, 'Tenancy agreement.pdf');
const revisedPath = join(dir, 'Tenancy agreement (revised).pdf');
const originalCopyPath = join(dir, 'Tenancy agreement (original).pdf');
const notesPath = join(dir, 'Revision notes.md');
writeFileSync(pdfPath, await tenancyAgreement());
writeFileSync(revisedPath, await tenancyAgreement({ revised: true }));
writeFileSync(originalCopyPath, await tenancyAgreement());
writeFileSync(notesPath, '# Tenancy notes\n\nSection 21 notices need two months.\n');

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', 'out/main/index.js', pdfPath],
  env: { ...process.env, ELECTRON_RENDERER_URL: '', PDF_READER_USER_DATA: userData },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1440, height: 900 });

/** Make the next native open dialog return these paths. */
const stubOpenDialog = (paths) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p });
  }, paths);

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
  } catch (err) {
    const path = join(shots ?? dir, 'FAILED.png');
    await win.screenshot({ path }).catch(() => {});
    console.log(`FAILED (screenshot: ${path})`);
    throw err;
  }
  if (shots) await win.screenshot({ path: join(shots, `${name.replace(/\W+/g, '-')}.png`) });
  console.log('ok');
};
const idle = () => win.waitForFunction(() => !document.body.classList.contains('busy'));
const pageBox = async (i) => {
  await win.evaluate((i) => {
    const v = document.querySelector('#viewer');
    v.scrollTo({ top: document.querySelectorAll('.page')[i].offsetTop - 16, behavior: 'instant' });
  }, i);
  await win.waitForTimeout(150);
  return win.locator('.page').nth(i).boundingBox();
};
const rail = (mode) => win.click(`.rail-btn[data-mode="${mode}"]`);

await step('opens the file passed on the command line', async () => {
  await win.waitForSelector('.page .textLayer span');
  assert.equal(await win.locator('.page').count(), 3);
  assert.match(await win.locator('#doc-chip').innerText(), /Tenancy agreement\.pdf/);
});

await step('searches and highlights matches', async () => {
  await win.fill('#search', 'deposit');
  await win.waitForFunction(() => /^1\/\d+$/.test(document.querySelector('.search-count')?.textContent ?? ''));
  assert.ok((await win.locator('.hit').count()) >= 2);
  await win.press('#search', 'Escape');
});

await step('adds text with the text tool', async () => {
  await win.click('[data-tool="text"]');
  const b = await pageBox(0);
  await win.mouse.click(b.x + 80, b.y + 60);
  await win.keyboard.type('Reviewed by JL');
  await win.keyboard.press('Enter');
  await idle();
  await win.waitForFunction(() => document.querySelector('.page .textLayer')?.textContent?.includes('Reviewed by JL'));
});

await step('edits existing text smoothly', async () => {
  // Remember the page elements and the untouched pages' canvases.
  await win.evaluate(() => {
    window.__pages = [...document.querySelectorAll('.page')];
    window.__canvases = window.__pages.map((p) => p.querySelector('canvas.render'));
    window.__removed = 0;
    new MutationObserver((ms) => ms.forEach((m) => m.removedNodes.forEach((n) => n.classList?.contains('page') && window.__removed++)))
      .observe(document.querySelector('#pages'), { childList: true });
  });
  await win.click('[data-tool="select"]');
  await pageBox(0);
  const rent = win.locator('.page >> nth=0').locator('.textLayer span', { hasText: '£1,850' }).first();
  // The tool overlay sits above the text layer, so use real mouse positions.
  const at = async (loc) => {
    const b = await loc.boundingBox();
    return [b.x + Math.min(40, b.width / 2), b.y + b.height / 2];
  };
  const rentAt = await at(rent);
  // Double-click the text with the Select tool to start typing into it.
  await win.mouse.dblclick(...rentAt);
  await win.waitForSelector('.text-editor');
  assert.equal(await win.getAttribute('[data-tool="edittext"]', 'aria-checked'), 'true');
  assert.match(await win.inputValue('.text-editor'), /^The rent is £1,850 per calendar month/);
  await win.fill('.text-editor', 'The rent is £1,900 per calendar month, payable in advance on the first day of each month.');
  await win.click('.edit-bar button:has-text("Done")');
  await idle();
  await win.waitForFunction(() => {
    const t = document.querySelector('.page .textLayer')?.textContent ?? '';
    return t.includes('£1,900') && !t.includes('£1,850');
  });
  await win.waitForSelector('.text-editor', { state: 'detached' });

  // Delete a line of the original text.
  const subtitle = win.locator('.page >> nth=0').locator('.textLayer span', { hasText: 'Housing Act 1988' }).first();
  await pageBox(0); // scroll back to the top of page 1
  await win.mouse.click(...(await at(subtitle)));
  await win.click('.edit-bar button:has-text("Delete text")');
  await idle();
  await win.waitForFunction(() => !(document.querySelector('.page .textLayer')?.textContent ?? '').includes('section 19A'));

  const smooth = await win.evaluate(() => ({
    samePages: [...document.querySelectorAll('.page')].every((p, i) => p === window.__pages[i]),
    removed: window.__removed,
    untouched: [1, 2].every((i) => window.__pages[i].querySelector('canvas.render') === window.__canvases[i]),
    redrawn: window.__pages[0].querySelector('canvas.render') !== window.__canvases[0],
  }));
  assert.deepEqual(smooth, { samePages: true, removed: 0, untouched: true, redrawn: true }, 'edits update in place without rebuilding pages');
  await win.click('[data-tool="select"]');
});

await step('highlights an area', async () => {
  await win.click('[data-tool="highlight"]');
  const b = await pageBox(0);
  await win.mouse.move(b.x + 90, b.y + 200);
  await win.mouse.down();
  await win.mouse.move(b.x + 400, b.y + 230, { steps: 5 });
  await win.mouse.up();
  await idle();
  await win.click('[data-tool="select"]');
});

await step('draws, then erases only its own pen marks', async () => {
  const page1Text = async () => win.evaluate(() => document.querySelectorAll('.page')[1].querySelector('.textLayer')?.textContent ?? '');
  const textBefore = await page1Text();
  await win.click('[data-tool="ink"]');
  assert.match(await win.evaluate(() => getComputedStyle(document.body).getPropertyValue('--tool-cursor')), /^url\("data:image\/svg\+xml/, 'pen cursor');
  const b = await pageBox(1);
  for (const y of [420, 480]) {
    await win.mouse.move(b.x + 120, b.y + y);
    await win.mouse.down();
    await win.mouse.move(b.x + 320, b.y + y + 10, { steps: 8 });
    await win.mouse.up();
    await idle();
  }
  await win.click('[data-tool="eraser"]');
  const undoBefore = await win.evaluate(() => document.querySelector('#btn-undo').disabled);
  // Rubbing over the document's own text erases nothing.
  const b2 = await pageBox(1);
  await win.mouse.move(b2.x + 60, b2.y + 70);
  await win.mouse.down();
  await win.mouse.move(b2.x + 400, b2.y + 140, { steps: 10 });
  await win.mouse.up();
  await idle();
  assert.equal(await page1Text(), textBefore, 'document text untouched by the eraser');
  // Erase the first stroke only.
  await win.mouse.move(b2.x + 200, b2.y + 420);
  await win.mouse.down();
  await win.waitForSelector('.erase-mark');
  await win.mouse.move(b2.x + 260, b2.y + 426, { steps: 4 });
  await win.mouse.up();
  await idle();
  await win.waitForSelector('.erase-mark', { state: 'detached' });
  assert.equal(undoBefore, false);
  await win.click('[data-tool="select"]');
});

await step('fills a form field and signs', async () => {
  await rail('sign');
  await win.fill('.form-fill input', '1 December 2026');
  await win.click('.form-fill .btn-primary');
  await idle();
  await win.waitForFunction(() => document.querySelector('.form-fill input')?.value === '1 December 2026');
  await win.click('.sig-add >> nth=0');
  await win.click('.tab[data-tab="type"]');
  await win.fill('.sig-name', 'Jordan Ellis');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.sig-chip.active');
  const b = await pageBox(0);
  await win.mouse.move(b.x + 200, b.y + 640);
  await win.mouse.click(b.x + 200, b.y + 640);
  await idle();
  await win.waitForFunction(() => !document.body.classList.contains('interacting'));
});

await step('creates a form field and saves a template', async () => {
  await rail('prepare');
  await win.click('#ribbon button:has-text("Text field")');
  const b = await pageBox(1); // page 1 is flattened by redaction later, which removes its fields
  await win.mouse.click(b.x + 80, b.y + 500);
  await idle();
  await win.waitForSelector('.field-outline >> text=Text');
  await win.click('button:has-text("Save fields as template")');
  await win.fill('.modal input', 'Tenancy sign-off');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.list-row >> text=Tenancy sign-off');
});

await step('organizes pages: rotate, delete, undo and redo', async () => {
  await rail('organize');
  await win.waitForSelector('.tile canvas');
  await win.click('.tile >> nth=1');
  await win.click('#ribbon button:has-text("Rotate right")');
  await idle();
  await win.click('.tile >> nth=2');
  await win.click('#ribbon button:has-text("Delete")');
  await win.click('.modal .btn-danger');
  await idle();
  await win.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
  await win.keyboard.press('Control+z');
  await win.waitForFunction(() => document.querySelectorAll('.tile').length === 3);
  await win.keyboard.press('Control+Shift+z');
  await win.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
});

await step('redacts personal information and re-runs OCR', async () => {
  await rail('redact');
  await win.click('#ribbon button:has-text("Personal info")');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.redact-mark');
  const marks = await win.locator('.side-body .list-row').count();
  assert.ok(marks >= 3, `expected ≥3 redaction marks, got ${marks}`);
  await win.click('#ribbon button:has-text("Apply redactions")');
  await win.click('.modal .btn-danger');
  // Flatten, then OCR the redacted page (runs Tesseract locally).
  await win.waitForSelector('.toast-success >> text=/Recognised/', { timeout: 120_000 });
  await idle();
});

await step('applies branding', async () => {
  await rail('brand');
  await win.fill('.side-body input[placeholder*="Solicitors"]', 'Landon & Co. Solicitors');
  await win.fill('.side-body input[placeholder*="agreements"]', 'landon.co.uk/agreements');
  await win.waitForSelector('.brand-preview');
  await win.click('button:has-text("Apply branding")');
  await idle();
});

await step('saves to disk', async () => {
  assert.match(await win.title(), /•/);
  await win.click('#btn-save');
  await win.waitForFunction(() => !document.title.includes('•'));
});

await step('compares two versions', async () => {
  await rail('compare');
  await stubOpenDialog([originalCopyPath]);
  await win.click('.compare-slot >> nth=0');
  await win.waitForSelector('.compare-slot.filled');
  await stubOpenDialog([revisedPath]);
  await win.click('.compare-slot >> nth=1');
  await win.waitForSelector('.compare-slot.filled >> nth=1');
  await win.click('.compare-start .btn-primary');
  await win.waitForSelector('.change');
  const text = await win.locator('.change-list').innerText();
  assert.match(text, /£1,850/);
  assert.match(text, /£1,950/);
  assert.ok((await win.locator('.diff-mark.added').count()) > 0);
});

await step('creates a Space and adds a source', async () => {
  await win.click('.ai-cta');
  await win.waitForSelector('.key-banner');
  await win.click('#assistant .tab:has-text("Spaces")');
  await win.click('#assistant button:has-text("New Space")');
  await win.fill('.modal input', 'Housing law');
  await win.click('.modal .btn-primary');
  await stubOpenDialog([notesPath]);
  await win.click('#assistant button:has-text("Add files")');
  await win.waitForSelector('#assistant .list-row >> text=Revision notes');
  await win.waitForSelector('#assistant .chat-input');
  await win.click('#assistant .assistant-head .btn');
});

await step('runs a command from the palette', async () => {
  await rail('edit');
  await win.keyboard.press('Control+k');
  await win.fill('.palette-input', 'zoom in');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => /%$/.test(document.querySelector('.pager-zoom')?.textContent ?? ''));
});

await step('asks to save when closing a document with changes', async () => {
  await win.click('[data-tool="ink"]');
  const b = await pageBox(1);
  // Page 2 is landscape now (rotated earlier), so draw near its top.
  await win.mouse.move(b.x + 120, b.y + 120);
  await win.mouse.down();
  await win.mouse.move(b.x + 300, b.y + 130, { steps: 6 });
  await win.mouse.up();
  await idle();
  await win.waitForSelector('#btn-save.dirty');
  assert.equal((await win.locator('#btn-save').innerText()).trim(), 'Save');
  await win.keyboard.press('Control+k');
  await win.fill('.palette-input', 'close document');
  await win.keyboard.press('Enter');
  await win.waitForSelector('.modal >> text=Save changes to');
  await win.click('.modal .btn-primary'); // Save
  await win.waitForSelector('.home-inner');
});

await app.close();

// ---- verify the saved file independently
const saved = readFileSync(pdfPath);
const lib = await PDFDocument.load(saved);
assert.equal(lib.getPageCount(), 2, 'page 3 deleted');
assert.equal(lib.getPage(1).getRotation().angle, 90, 'page 2 rotated');
const fields = lib.getForm().getFields().map((f) => f.getName());
assert.ok(fields.includes('Text'), `new text field present (fields: ${fields})`);
assert.equal(lib.getTitle() ?? '', '', 'metadata scrubbed by redaction');
const xobjects = lib.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
assert.ok(xobjects && xobjects.keys().length >= 1, 'page 1 is a flattened image (redacted)');
const js = await getDocument({ data: new Uint8Array(saved), verbosity: 0 }).promise;
const text = (await (await js.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
assert.doesNotMatch(text, /jordan\.ellis@example\.com/, 'email redacted');
assert.doesNotMatch(text, /7946/, 'phone redacted');
assert.match(text, /Tenancy/i, 'OCR restored searchable text');
assert.match(text, /Landon & Co\. Solicitors/, 'branding text added');
const annots = lib.getPage(0).node.Annots()?.asArray() ?? [];
assert.ok(annots.length >= 1, 'brand link annotation present');
const inks = (lib.getPage(1).node.Annots()?.asArray() ?? [])
  .map((r) => lib.context.lookup(r))
  .filter((a) => a.get(PDFName.of('Subtype'))?.decodeText?.() === 'Ink');
assert.equal(inks.length, 2, 'two of three pen strokes remain (one erased) as annotations');
const state = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'));
assert.equal(state.signatures.length, 1, 'signature saved to library');
assert.equal(state.templates[0]?.name, 'Tenancy sign-off', 'template saved');
assert.equal(state.spaces[0]?.sources[0]?.title, 'Revision notes', 'space source saved');
assert.deepEqual(errors, [], 'no renderer errors');
console.log(`\nAll e2e checks passed. Saved file: ${pdfPath}`);
