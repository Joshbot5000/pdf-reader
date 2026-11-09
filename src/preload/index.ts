import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AiEvent, DesktopApi, MenuAction } from '../shared/ipc';

const api: DesktopApi = {
  platform: process.platform,
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  openPath: (path) => ipcRenderer.invoke('file:openPath', path),
  save: (path, data) => ipcRenderer.invoke('file:save', path, data),
  saveAs: (name, data) => ipcRenderer.invoke('dialog:saveAs', name, data),
  exportFile: (name, data, ext, label) => ipcRenderer.invoke('dialog:export', name, data, ext, label),
  pickFiles: (filters, multi) => ipcRenderer.invoke('dialog:pick', filters, multi),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  takePendingOpen: () => ipcRenderer.invoke('app:takePendingOpen'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: (cb) => {
    ipcRenderer.on('menu:action', (_e, action: MenuAction) => cb(action));
  },
  onOpenRequest: (cb) => {
    ipcRenderer.on('file:openRequest', (_e, path: string) => cb(path));
  },

  getState: () => ipcRenderer.invoke('state:get'),
  setState: (key, value) => ipcRenderer.invoke('state:set', key, value),

  ocr: (png) => ipcRenderer.invoke('ocr:recognize', png),

  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSetKey: (key) => ipcRenderer.invoke('ai:setKey', key),
  aiChat: (req) => ipcRenderer.invoke('ai:chat', req),
  aiCancel: (id) => ipcRenderer.send('ai:cancel', id),
  aiForget: (id) => ipcRenderer.send('ai:forget', id),
  onAiEvent: (cb) => {
    ipcRenderer.on('ai:event', (_e, ev: AiEvent) => cb(ev));
  },
  aiSlides: (req) => ipcRenderer.invoke('ai:slides', req),
  saveSlides: (outline) => ipcRenderer.invoke('slides:save', outline),

  spaceAddFiles: (spaceId) => ipcRenderer.invoke('space:addFiles', spaceId),
  spaceAddUrl: (spaceId, url) => ipcRenderer.invoke('space:addUrl', spaceId, url),
  spaceAddPath: (spaceId, path) => ipcRenderer.invoke('space:addPath', spaceId, path),
  spaceRemoveSource: (spaceId, sourceId) => ipcRenderer.invoke('space:removeSource', spaceId, sourceId),
  spaceDelete: (spaceId) => ipcRenderer.invoke('space:delete', spaceId),
};

contextBridge.exposeInMainWorld('api', api);
