import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('hark', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('hark', method, ...args),
  send: (method: string, ...args: unknown[]) => ipcRenderer.send('hark-send', method, ...args),
  on: (event: string, cb: (data: unknown) => void) => {
    const fn = (_e: unknown, data: unknown) => cb(data);
    ipcRenderer.on(`hark:${event}`, fn);
    return () => ipcRenderer.removeListener(`hark:${event}`, fn);
  },
  pathFor: (file: File) => webUtils.getPathForFile(file),
});
