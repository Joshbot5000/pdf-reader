/** Build a .pptx deck from an AI slide outline. */
import PptxGenJS from 'pptxgenjs';
import type { SlideOutline } from '../shared/ipc';

const INK = '12131A';
const PAPER = 'FFFFFF';
const VIOLET = '7C5CFF';
const PINK = 'FF5C8A';
const MUTED = '6B7080';

export async function buildDeck(outline: SlideOutline): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = outline.title;

  // Title slide
  const title = pptx.addSlide();
  title.background = { color: INK };
  title.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: VIOLET } });
  title.addShape(pptx.ShapeType.rect, { x: 0.35, y: 0, w: 0.12, h: 7.5, fill: { color: PINK } });
  title.addText(outline.title, {
    x: 1.1, y: 2.3, w: 11, h: 1.6, fontFace: 'Segoe UI', fontSize: 44, bold: true, color: PAPER, valign: 'bottom',
  });
  title.addText(outline.subtitle, { x: 1.1, y: 4.05, w: 11, h: 0.8, fontFace: 'Segoe UI', fontSize: 22, color: 'B9BDD0' });

  outline.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: PAPER };
    slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 0.65, w: 0.9, h: 0.08, fill: { color: VIOLET } });
    slide.addText(s.title, { x: 0.7, y: 0.8, w: 11.9, h: 1.0, fontFace: 'Segoe UI', fontSize: 30, bold: true, color: INK });
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 22 }, breakLine: true } })),
      { x: 0.7, y: 2.0, w: 11.9, h: 4.6, fontFace: 'Segoe UI', fontSize: 20, color: '2B2E3A', paraSpaceAfter: 12, valign: 'top' },
    );
    slide.addText(`${i + 2}`, { x: 12.2, y: 6.9, w: 0.6, h: 0.35, fontSize: 11, color: MUTED, align: 'right' });
    if (s.notes) slide.addNotes(s.notes);
  });

  const out = (await pptx.write({ outputType: 'uint8array' })) as Uint8Array;
  return out;
}
