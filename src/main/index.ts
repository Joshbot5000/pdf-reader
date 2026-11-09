import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MenuAction, OpenedFile } from '../shared/ipc';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererDir = resolve(here, '../renderer');
const preloadPath = join(here, '../preload/index.cjs');

// Serve the UI from app:// rather than file:// so fetch() works for pdf.js
// fonts, CMaps and wasm, and so the page gets a proper secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Files the user picked via a dialog, drag-and-drop or the OS; only these may be overwritten. */
const writablePaths = new Set<string>();
const dirtyWindows = new Set<number>();
let pendingOpen: string | null = pdfFromArgv(process.argv);

function pdfFromArgv(argv: string[]): string | null {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && extname(a).toLowerCase() === '.pdf');
  return arg ? resolve(arg) : null;
}

async function readPdf(path: string): Promise<OpenedFile> {
  if (extname(path).toLowerCase() !== '.pdf') throw new Error('Only .pdf files can be opened.');
  const data = await readFile(path);
  writablePaths.add(path);
  return { path, name: basename(path), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    title: 'PDF Reader',
    backgroundColor: '#1f2125',
    show: false,
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
    if (!dirtyWindows.has(id)) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close the window and discard them?',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => dirtyWindows.delete(id));

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadURL('app://bundle/index.html');
  return win;
}

function send(action: MenuAction) {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:action', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
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
          item('Open…', 'open', 'CmdOrCtrl+O'),
          item('Save', 'save', 'CmdOrCtrl+S'),
          item('Save As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
          { type: 'separator' },
          item('Insert Pages from PDF…', 'insertPdf'),
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      // Standard roles keep copy/paste working in text fields; document
      // undo/redo is handled in the renderer so it does not fight them.
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
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

function registerIpc() {
  ipcMain.handle('dialog:open', async (e): Promise<OpenedFile | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return r.canceled || !r.filePaths[0] ? null : readPdf(r.filePaths[0]);
  });

  ipcMain.handle('file:openPath', (_e, path: unknown) => {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path');
    return readPdf(resolve(path));
  });

  ipcMain.handle('file:save', async (_e, path: unknown, data: unknown) => {
    if (typeof path !== 'string' || !writablePaths.has(path)) throw new Error('That file was not opened in this app.');
    if (!(data instanceof Uint8Array)) throw new Error('Invalid data');
    await writeFile(path, data);
  });

  ipcMain.handle('dialog:saveAs', async (e, suggestedName: unknown, data: unknown): Promise<OpenedFile | null> => {
    if (!(data instanceof Uint8Array)) throw new Error('Invalid data');
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const path = extname(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
    await writeFile(path, data);
    writablePaths.add(path);
    return { path, name: basename(path), data };
  });

  ipcMain.on('doc:dirty', (e, dirty: unknown) => {
    if (dirty) dirtyWindows.add(e.sender.id);
    else dirtyWindows.delete(e.sender.id);
  });

  ipcMain.handle('app:takePendingOpen', () => {
    const p = pendingOpen;
    pendingOpen = null;
    return p;
  });
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

  void app.whenReady().then(() => {
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
