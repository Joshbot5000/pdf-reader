/** Offline OCR with Tesseract (English model bundled via @tesseract.js-data/eng). */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { OcrWord } from '../shared/ipc';

const nodeRequire = createRequire(import.meta.url);
type Worker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function langPath(): string {
  // Packaged apps unpack this folder from the asar archive (see build.asarUnpack).
  const dir = dirname(nodeRequire.resolve('@tesseract.js-data/eng/package.json'));
  return join(dir.replace('app.asar', 'app.asar.unpacked'), '4.0.0_best_int');
}

async function getWorker(): Promise<Worker> {
  worker ??= import('tesseract.js').then(({ createWorker }) =>
    createWorker('eng', 1, { langPath: langPath(), cacheMethod: 'none', gzip: true }),
  );
  return worker;
}

/** Recognise one page image. Calls are queued so pages are processed one at a time. */
export function recognize(png: Uint8Array): Promise<OcrWord[]> {
  const run = queue.then(async () => {
    const w = await getWorker();
    const { data } = await w.recognize(Buffer.from(png), {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const word of line.words) {
            if (word.text.trim()) words.push({ text: word.text, confidence: word.confidence, bbox: word.bbox });
          }
        }
      }
    }
    return words;
  });
  queue = run.catch(() => {});
  return run;
}

export async function shutdownOcr() {
  if (worker) await (await worker).terminate();
  worker = null;
}
