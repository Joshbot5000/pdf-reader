# PDF Reader

A desktop app for opening, searching, annotating and editing PDFs. Built with
Electron, [pdf.js](https://github.com/mozilla/pdf.js) (rendering, text
selection, search) and [pdf-lib](https://github.com/Hopding/pdf-lib) (editing).

## Features

| Area | What you can do |
|---|---|
| Open | File → Open, drag a PDF onto the window, or pass a path on the command line / "Open with" |
| View | Fit-width or zoom, page thumbnails, selectable/copyable text |
| Search | Live find with highlighted matches, next/previous, match case, whole words; phrases match across line breaks |
| Annotate | Add text (Text tool, click and type, Enter to place, Shift+Enter for a new line), highlight an area, white-out an area, freehand drawing; pick colour and size |
| Pages | Rotate, move up/down or drag thumbnails to reorder, insert blank page, insert pages from another PDF, delete |
| Forms | Fill text fields, checkboxes, dropdowns and radio groups from the Forms panel |
| Files | Save / Save As, undo and redo (Ctrl+Z / Ctrl+Shift+Z), unsaved-changes warning on close |

Keyboard: V select, T text, H highlight, W white-out, D draw, Esc back to
select, Ctrl+F find, Enter / Shift+Enter next / previous match.

## Development

Requires Node.js 22.13+.

```bash
npm install
npm run dev        # run with hot reload
npm test           # unit tests (editing operations, search, geometry)
npm run test:e2e   # builds, launches the real app and drives it end to end
npm run dist       # package an installer for the current OS (electron-builder)
```

On a Linux machine without a display, run the e2e test under Xvfb:
`xvfb-run -a npm run test:e2e`. Set `E2E_SCREENSHOTS=/some/dir` to save a
screenshot after each step.

## How it works

- `src/main` — Electron main process: window, menus, file dialogs, and an
  `app://` protocol that serves the UI so pdf.js can fetch its fonts and
  character maps. The renderer is sandboxed with context isolation; it can only
  overwrite files the user opened or chose in a dialog.
- `src/preload` — the small `window.api` bridge between the two.
- `src/shared/pdfOps.ts` — every edit is a pure function `bytes → bytes` using
  pdf-lib. The renderer keeps the previous bytes on an undo stack and re-renders
  with pdf.js, so the screen always shows exactly what will be saved.
- `src/shared/search.ts` — joins pdf.js text runs per page, normalises
  whitespace, finds matches and maps them back to run offsets for highlighting.
- `src/renderer` — UI, tools and rendering (pages render lazily as they scroll
  into view).

## Limitations

- Added text uses Helvetica, so it supports Western European characters only.
- Text, highlights and drawings are written into the page content, not as
  separate annotation objects, so they can be undone in this app but not moved
  or deleted later in other PDF apps.
- Existing text can't be edited in place. Cover it with White-out and add new
  text on top.
- Encrypted PDFs open read-only; password-protected PDFs are not supported yet.
