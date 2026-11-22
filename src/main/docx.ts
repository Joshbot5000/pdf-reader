/** Word documents from Markdown notes: headings, bullet and numbered lists, bold and italic, quotes and simple tables. */
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

/** **bold**, *italic* and `code` inside a line. [m:ss] timestamps are kept as plain text. */
function runs(text: string): TextRun[] {
  const out: TextRun[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (/^\*\*.+\*\*$/.test(part)) out.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    else if (/^\*.+\*$/.test(part)) out.push(new TextRun({ text: part.slice(1, -1), italics: true }));
    else if (/^`.+`$/.test(part)) out.push(new TextRun({ text: part.slice(1, -1), font: 'Menlo' }));
    else out.push(new TextRun(part));
  }
  return out;
}

export async function markdownToDocx(md: string, title: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  let table: string[][] | null = null;
  const flushTable = () => {
    if (!table?.length) return void (table = null);
    const cols = Math.max(...table.map((r) => r.length));
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: table.map((r, ri) => new TableRow({ children: Array.from({ length: cols }, (_, ci) => new TableCell({ children: [new Paragraph({ children: ri === 0 ? [new TextRun({ text: r[ci] ?? '', bold: true })] : runs(r[ci] ?? '') })] })) })),
      }),
    );
    table = null;
  };
  let first = true;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) (table ??= []).push(cells);
      continue;
    }
    flushTable();
    if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      children.push(new Paragraph({ heading: first && level === 1 ? HeadingLevel.TITLE : [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1], children: runs(h[2]) }));
      first = false;
      continue;
    }
    first = false;
    const bullet = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (bullet) {
      children.push(new Paragraph({ bullet: { level: Math.min(3, Math.floor(bullet[1].length / 2)) }, children: runs(bullet[2]) }));
      continue;
    }
    const num = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (num) {
      children.push(new Paragraph({ numbering: { reference: 'numbers', level: Math.min(3, Math.floor(num[1].length / 2)) }, children: runs(num[2]) }));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      children.push(new Paragraph({ indent: { left: 400 }, children: [new TextRun({ text: quote[1], italics: true })] }));
      continue;
    }
    children.push(new Paragraph({ children: runs(line) }));
  }
  flushTable();
  const doc = new Document({
    title,
    creator: 'Hark',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2, 3].map((level) => ({ level, format: 'decimal' as const, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 400 * (level + 1), hanging: 260 } } } })) }] },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
