# PDF Reader

A desktop app for reading, editing, signing and understanding PDFs. Built with
Electron, [pdf.js](https://github.com/mozilla/pdf.js) (rendering, text,
search), [pdf-lib](https://github.com/Hopding/pdf-lib) (editing),
[Tesseract](https://github.com/naptha/tesseract.js) (OCR) and
[Claude](https://www.anthropic.com/claude) (AI Assistant).

Everything except the AI Assistant runs on your computer; nothing is uploaded.

## Features

| Tool | What it does |
|---|---|
| **Home** | Open or drop a PDF, recent files, launcher for every tool |
| **Edit** | **Edit text**: double-click (or click with Edit text) any paragraph of the PDF's own text to change or delete it. The original is removed from the page and the new text uses the document's own font, or the same font installed on your computer, at the same size and colour. Add new text, highlight (4 colours), draw, **Eraser** (removes only your pen strokes and highlights, never the document), white-out; tool-shaped cursors; undo/redo |
| **Search** | Live find with highlighted matches, match case, whole words; phrases match across line breaks |
| **Organize** | Page grid with multi-select: rotate, delete, reorder by drag, insert blank pages or another PDF, extract pages to a new PDF |
| **Fill & Sign** | Fill form fields; draw, type (3 script styles) or upload a signature and initials, saved for reuse; stamp the date |
| **Prepare form** | Draw text fields, checkboxes, dropdowns and signature fields; save the layout as a reusable form / e-sign template and apply it to other documents |
| **Redact** | Mark areas by hand, find text, or detect personal information (emails, phone numbers, card numbers, NI numbers, postcodes, IBANs). Applying flattens marked pages so the content is removed from the file, clears metadata, and can re-run OCR so the page stays searchable |
| **Scan & OCR** | Detects scanned pages and adds an invisible, selectable text layer (English) |
| **Compare** | Side-by-side view of two PDFs with every added, removed and changed word highlighted, a change list and synced scrolling |
| **Brand** | Stamp a logo, name and clickable custom URL on agreements, with a live preview |
| **AI Assistant** | Chat with the open PDF with page citations; one-click actions (Summarize, Key points, Explain simply, Dates & obligations, Risky terms, Quiz me, Draft email); remix into a PowerPoint deck |
| **PDF Spaces** | Collections of PDFs, Word documents, text files and web links to ask questions across, with optional custom instructions |
| **Command palette** | <kbd>Ctrl/⌘ K</kbd> searches every command |

Light and dark themes follow the system or can be chosen in Settings.

### AI Assistant setup

Open **Settings** and paste an [Anthropic API key](https://console.anthropic.com/settings/keys).
It is encrypted with the operating system keychain (Electron `safeStorage`) and
only used from the main process. The assistant uses `claude-opus-5-5` with
citations, prompt caching for follow-up questions, and server-side refusal
fallback. When you ask a question, the open document (or the Space's sources) is
sent to Anthropic.

Setting `ANTHROPIC_API_KEY` in the environment also works.

### Not included

Some Acrobat Pro / Studio features need an online service and are out of scope for
a local desktop app: sending documents for signature by email, bulk sending and
tracking, hosted web forms, sharing Spaces with other people, voice prompts on
mobile, Microsoft 365 connectors, a template marketplace and image generation.
Signatures here are visual e-signatures, not certificate-based digital signatures.

## Installing on a Mac

1. Install Node.js (LTS) from https://nodejs.org (one-off).
2. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
3. Double-click **Install PDF Reader.command** in the unzipped folder. If macOS
   says it can't be opened, right-click it → **Open** → **Open**.

It builds the app, replaces any older version in Applications and opens it.
To update later, download a fresh ZIP and double-click the installer again.

## Development

Requires Node.js 22.13+.

```bash
npm install
npm run dev          # run with hot reload
npm test             # unit tests (editing, redaction, OCR layer, forms, search, compare)
npm run test:e2e     # builds, then drives the real app end to end (incl. AI against a mock API)
npm run screenshots  # screenshot tour of every screen, light and dark
npm run dist         # package an installer for the current OS (electron-builder)
```

On Linux without a display, prefix the e2e and screenshot commands with
`xvfb-run -a`.

## How it works

- `src/main` — Electron main process: window and menus, file dialogs, the
  `app://` protocol serving the UI, local storage (`store.ts`), Claude
  (`ai.ts`), OCR (`ocr.ts`), PowerPoint export (`slides.ts`) and Spaces
  (`spaces.ts`). The renderer is sandboxed with context isolation; it can only
  overwrite files the user opened or chose.
- `src/preload` — the `window.api` bridge.
- `src/shared/pdfOps.ts` — every edit is a pure `bytes → bytes` function using
  pdf-lib. The app keeps previous versions on an undo stack and re-renders, so
  the screen always shows exactly what will be saved.
- `src/shared/textEdit.ts` — edits a page's existing text: tokenizes the content
  stream, simulates the text state to locate each text-drawing operator,
  removes the selected ones (keeping the rest of each line in place) and draws
  the replacement. `textBlocks.ts` groups text into editable paragraphs.
- The viewer renders every page off-screen and swaps it in when complete, and
  after an edit redraws only the pages that changed, so updates don't flicker.
- `src/shared/search.ts`, `compare.ts` — text indexing, search, personal-data
  patterns and word-level diffing over pdf.js text.
- `src/renderer/src/core` — the open document and the page viewer.
- `src/renderer/src/features` — one module per tool.

## Limitations

- Added text uses Helvetica, so it supports Western European characters only.
- Pen strokes and highlights are saved as standard PDF annotations, so other
  apps (Acrobat, Preview) can show, move or delete them too. Added text and
  signatures are written into the page content.
- Edited paragraphs use the PDF's own embedded font when it contains every
  character typed (embedded fonts are usually subsets of the characters the
  document used); otherwise the same font installed on your computer; and only
  if neither is available the closest standard font (the app says when). A
  paragraph with mixed styles takes the style of its first line.
- Rotated text, and text that is part of an image or graphic, can't be edited in
  place; for graphics it is covered and replaced instead.
- Redacting a page turns it into an image (with an OCR text layer if chosen),
  which removes its form fields and links.
- OCR is English only.
- Encrypted PDFs open read-only; password-protected PDFs are not supported yet.
