import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, MenuAction } from '../shared/ipc';

const api: DesktopApi = {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  openPath: (path) => ipcRenderer.invoke('file:openPath', path),
  save: (path, data) => ipcRenderer.invoke('file:save', path, data),
  saveAs: (name, data) => ipcRenderer.invoke('dialog:saveAs', name, data),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  takePendingOpen: () => ipcRenderer.invoke('app:takePendingOpen'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: (cb) => {
    ipcRenderer.on('menu:action', (_e, action: MenuAction) => cb(action));
  },
  onOpenRequest: (cb) => {
    ipcRenderer.on('file:openRequest', (_e, path: string) => cb(path));
  },
};

contextBridge.exposeInMainWorld('api', api);
