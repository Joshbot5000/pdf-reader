import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AiChatRequest, AiStatus, AppState, MenuAction, OpenedFile, SlideOutline } from '../shared/ipc';
import * as ai from './ai';
import * as gemini from './gemini';
import { recognize, shutdownOcr } from './ocr';
import { buildDeck } from './slides';
import { findFont, warmFontIndex } from './fonts';
import * as spaces from './spaces';
import { addRecent, loadApiKey, loadState, saveApiKey, updateState } from './store';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererDir = resolve(here, '../renderer');
const preloadPath = join(here, '../preload/index.cjs');
const isMac = process.platform === 'darwin';

// Tests and screenshots run against an isolated profile.
if (process.env.PDF_READER_USER_DATA) app.setPath('userData', process.env.PDF_READER_USER_DATA);

// Serve the UI from app:// rather than file:// so fetch() works for pdf.js
// fonts, CMaps and wasm, and so the page gets a proper secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Files the user picked via a dialog, drag-and-drop or the OS; only these may be overwritten. */
const writablePaths = new Set<string>();
/** Per window: unsaved changes and the open document's name. */
const docState = new Map<number, { dirty: boolean; name: string | null }>();
/** Windows allowed to close without asking (after Save or Don't Save). */
const closing = new Set<number>();
let pendingOpen: string | null = pdfFromArgv(process.argv);

function pdfFromArgv(argv: string[]): string | null {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && extname(a).toLowerCase() === '.pdf');
  return arg ? resolve(arg) : null;
}

async function readPdf(path: string): Promise<OpenedFile> {
  if (extname(path).toLowerCase() !== '.pdf') throw new Error('Only .pdf files can be opened.');
  const data = await readFile(path);
  writablePaths.add(path);
  void addRecent(path, basename(path));
  return { path, name: basename(path), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

const titleBarColors = () =>
  nativeTheme.shouldUseDarkColors
    ? { color: '#0c0d12', symbolColor: '#c9cbe0', height: 44 }
    : { color: '#f6f6fb', symbolColor: '#3a3d52', height: 44 };

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: 'PDF Reader',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0d12' : '#f6f6fb',
    show: false,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 14 } } : { titleBarOverlay: titleBarColors() }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const id = win.webContents.id; // webContents is destroyed by the time 'closed' fires

  win.once('ready-to-show', () => win.show());
  // Never navigate away from the app or open other windows; send links to the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    const state = docState.get(id);
    if (closing.has(id) || !state?.dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', 'Don’t Save', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Do you want to save the changes you made to “${state.name ?? 'this document'}”?`,
      detail: 'Your changes will be lost if you don’t save them.',
    });
    if (choice === 0) win.webContents.send('app:saveAndClose');
    else if (choice === 1) {
      closing.add(id);
      win.close();
    }
  });
  win.on('closed', () => {
    docState.delete(id);
    closing.delete(id);
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadURL('app://bundle/index.html');
  return win;
}

function send(action: MenuAction) {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:action', action);
}

function buildMenu() {
  const item = (label: string, action: MenuAction, accelerator?: string) => ({
    label,
    accelerator,
    click: () => send(action),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          item('Home', 'home', 'CmdOrCtrl+Shift+H'),
          item('Open…', 'open', 'CmdOrCtrl+O'),
          item('Save', 'save', 'CmdOrCtrl+S'),
          item('Save As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
          { type: 'separator' },
          item('Insert Pages from PDF…', 'insertPdf'),
          { type: 'separator' },
          item('Close Document', 'closeTab', 'CmdOrCtrl+W'),
          item('Next Document', 'nextTab', 'Ctrl+Tab'),
          item('Previous Document', 'prevTab', 'Ctrl+Shift+Tab'),
          { type: 'separator' },
          item('Settings…', 'settings', 'CmdOrCtrl+,'),
          { type: 'separator' },
          isMac ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
        ],
      },
      // Undo/redo go to the renderer, which undoes text in a focused field
      // or the last document edit otherwise. Clipboard roles stay native.
      {
        label: 'Edit',
        submenu: [
          item('Undo', 'undo', 'CmdOrCtrl+Z'),
          item('Redo', 'redo', 'CmdOrCtrl+Shift+Z'),
          { ...item('Redo', 'redo', 'Ctrl+Y'), visible: false, acceleratorWorksWhenHidden: true },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          item('Command Palette…', 'palette', 'CmdOrCtrl+K'),
          item('Find…', 'find', 'CmdOrCtrl+F'),
          { type: 'separator' },
          item('Zoom In', 'zoomIn', 'CmdOrCtrl+='),
          item('Zoom Out', 'zoomOut', 'CmdOrCtrl+-'),
          item('Fit Width', 'fitWidth', 'CmdOrCtrl+0'),
          { type: 'separator' },
          { role: 'toggleDevTools' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

function bytes(value: unknown, what = 'data'): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`Invalid ${what}`);
  return value;
}

const STATE_KEYS: (keyof AppState)[] = ['recent', 'signatures', 'templates', 'brand', 'spaces', 'settings'];

function registerIpc() {
  ipcMain.handle('dialog:open', async (e): Promise<OpenedFile | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return r.canceled || !r.filePaths[0] ? null : readPdf(r.filePaths[0]);
  });

  ipcMain.handle('dialog:pick', async (e, filters: unknown, multi: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: Array.isArray(filters) ? filters : [],
    });
    if (r.canceled) return [];
    return Promise.all(
      r.filePaths.map(async (path) => {
        const data = await readFile(path);
        return { path, name: basename(path), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
      }),
    );
  });

  ipcMain.handle('file:openPath', (_e, path: unknown) => {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path');
    return readPdf(resolve(path));
  });

  ipcMain.handle('file:save', async (_e, path: unknown, data: unknown) => {
    if (typeof path !== 'string' || !writablePaths.has(path)) throw new Error('That file was not opened in this app.');
    await writeFile(path, bytes(data));
  });

  ipcMain.handle('dialog:saveAs', async (e, suggestedName: unknown, data: unknown): Promise<OpenedFile | null> => {
    const payload = bytes(data);
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const path = extname(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
    await writeFile(path, payload);
    writablePaths.add(path);
    void addRecent(path, basename(path));
    return { path, name: basename(path), data: payload };
  });

  ipcMain.handle('dialog:export', async (e, name: unknown, data: unknown, ext: unknown, label: unknown) => {
    const payload = bytes(data);
    const extension = typeof ext === 'string' && /^[a-z0-9]{1,8}$/i.test(ext) ? ext : 'bin';
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: typeof name === 'string' ? name : `export.${extension}`,
      filters: [{ name: typeof label === 'string' ? label : extension.toUpperCase(), extensions: [extension] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, payload);
    return r.filePath;
  });

  ipcMain.on('doc:state', (e, state: { dirty?: unknown; path?: unknown; name?: unknown }) => {
    const dirty = !!state?.dirty;
    const name = typeof state?.name === 'string' ? state.name : null;
    docState.set(e.sender.id, { dirty, name });
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win.setDocumentEdited(dirty); // macOS: dot in the close button
    if (isMac) win.setRepresentedFilename(typeof state?.path === 'string' ? state.path : '');
    win.setTitle(name ? `${name}${dirty ? ' — Edited' : ''}` : 'PDF Reader');
  });
  ipcMain.on('app:closeWindow', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    closing.add(e.sender.id);
    win.close();
  });
  ipcMain.handle('fonts:find', (_e, name: unknown, hint: unknown) =>
    typeof name === 'string' ? findFont(name, (hint ?? {}) as { bold?: boolean; italic?: boolean }) : null,
  );

  ipcMain.handle('app:takePendingOpen', () => {
    const p = pendingOpen;
    pendingOpen = null;
    return p;
  });

  // ---- persisted state
  ipcMain.handle('state:get', () => loadState());
  ipcMain.handle('state:set', (_e, key: unknown, value: unknown) => {
    if (!STATE_KEYS.includes(key as keyof AppState)) throw new Error('Unknown setting');
    return updateState((s) => {
      (s as unknown as Record<string, unknown>)[key as string] = value;
      if (key === 'settings') {
        const theme = (value as AppState['settings']).theme;
        nativeTheme.themeSource = theme;
      }
    });
  });

  // ---- OCR
  ipcMain.handle('ocr:recognize', (_e, png: unknown) => recognize(bytes(png, 'image')));

  // ---- AI
  // The AI Assistant uses Gemini (free) by default, or Claude if chosen in Settings.
  const provider = async () => (await loadState()).settings.aiProvider ?? 'gemini';
  ipcMain.handle('ai:status', async (): Promise<AiStatus> => {
    const p = await provider();
    const keys = { gemini: !!(await loadApiKey('gemini')), claude: !!(await loadApiKey('claude')) };
    return { provider: p, hasKey: keys[p], keys, model: p === 'gemini' ? gemini.currentModel() : 'claude-opus-5-5' };
  });
  ipcMain.handle('ai:setKey', async (_e, which: unknown, key: unknown) => {
    if (which !== 'gemini' && which !== 'claude') throw new Error('Unknown AI provider');
    await saveApiKey(which, typeof key === 'string' && key.trim() ? key : null);
    ai.resetClient();
  });
  ipcMain.handle('ai:geminiModels', () => gemini.listModels());
  ipcMain.handle('ai:chat', async (e, req: AiChatRequest) => ((await provider()) === 'claude' ? ai.chat(e.sender, req) : gemini.chat(e.sender, req)));
  ipcMain.on('ai:cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return;
    ai.cancel(id);
    gemini.cancel(id);
  });
  ipcMain.on('ai:forget', (_e, id: unknown) => {
    if (typeof id !== 'string') return;
    ai.forget(id);
    gemini.forget(id);
  });
  ipcMain.handle('ai:slides', async (_e, req) => ((await provider()) === 'claude' ? ai.slides(req) : gemini.slides(req)));
  ipcMain.handle('slides:save', async (e, outline: SlideOutline) => {
    const data = await buildDeck(outline);
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `${outline.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Presentation'}.pptx`,
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, data);
    return r.filePath;
  });

  // ---- Spaces
  ipcMain.handle('space:addFiles', async (e, spaceId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: spaces.SPACE_FILE_FILTERS,
    });
    if (r.canceled) return loadState();
    const added = [];
    const errors: string[] = [];
    for (const p of r.filePaths) {
      try {
        added.push(await spaces.addFile(spaceId, p));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    const state = await spaces.appendSources(spaceId, added);
    if (errors.length) throw new Error(errors.join('\n'));
    return state;
  });
  ipcMain.handle('space:addUrl', async (_e, spaceId: string, url: string) =>
    spaces.appendSources(spaceId, [await spaces.addUrl(spaceId, url)]),
  );
  ipcMain.handle('space:addPath', async (_e, spaceId: string, path: unknown) => {
    // Only documents the user has opened in this session can be added this way.
    if (typeof path !== 'string' || !writablePaths.has(path)) throw new Error('Save the document first, then add it.');
    return spaces.appendSources(spaceId, [await spaces.addFile(spaceId, path)]);
  });
  ipcMain.handle('space:removeSource', (_e, spaceId: string, sourceId: string) => spaces.removeSource(spaceId, sourceId));
  ipcMain.handle('space:delete', (_e, spaceId: string) => spaces.deleteSpace(spaceId));
}

function openInWindow(path: string) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    pendingOpen = path;
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('file:openRequest', path);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const path = pdfFromArgv(argv);
    if (path) openInWindow(path);
    else BrowserWindow.getAllWindows()[0]?.focus();
  });

  // macOS "Open With" / double-click; may fire before the app is ready.
  app.on('open-file', (e, path) => {
    e.preventDefault();
    if (app.isReady()) openInWindow(path);
    else pendingOpen = path;
  });

  void app.whenReady().then(async () => {
    nativeTheme.themeSource = (await loadState()).settings.theme;
    nativeTheme.on('updated', () => {
      if (isMac) return;
      for (const w of BrowserWindow.getAllWindows()) w.setTitleBarOverlay(titleBarColors());
    });
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const target = normalize(join(rendererDir, decodeURIComponent(pathname)));
      if (target !== rendererDir && !target.startsWith(rendererDir + sep)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    });
    registerIpc();
    buildMenu();
    createWindow();
    warmFontIndex();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err: unknown) => {
    console.error('Startup failed:', err);
    dialog.showErrorBox('PDF Reader could not start', err instanceof Error ? err.stack ?? err.message : String(err));
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
  app.on('will-quit', () => void shutdownOcr());
}
