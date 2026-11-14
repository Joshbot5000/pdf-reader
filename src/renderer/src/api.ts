import type { Api, Bridge } from '../../shared/api';

declare global {
  interface Window {
    hark: Bridge;
  }
}

/** Typed client for the main process: `api.listMeetings()` becomes an IPC call of the same name. */
export const api = new Proxy({} as Api, {
  get: (_t, method: string) =>
    method === 'recAudio' || method === 'recBlob'
      ? (...args: unknown[]) => window.hark.send(method, ...args)
      : (...args: unknown[]) =>
          window.hark.call(method, ...args).catch((err: Error) => {
            // Electron prefixes errors with "Error invoking remote method 'hark': Error: …"
            throw new Error(String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
          }),
});
