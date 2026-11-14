/**
 * Tiny request/response + event channel for the AI engine processes. Works both as an
 * Electron utility process (process.parentPort) and as a plain Node child (process.send),
 * so the engines can be tested without Electron.
 */
type Handler = (params: any) => Promise<unknown> | unknown;
type Port = { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data: any }) => void): void };

const port = (process as unknown as { parentPort?: Port }).parentPort;

const post = (msg: unknown): void => {
  if (port) port.postMessage(msg);
  else process.send?.(msg);
};

export const emit = (event: string, data: unknown): void => post({ event, data });

export function serve(handlers: Record<string, Handler>): void {
  const onMessage = async (msg: { id: number; method: string; params: unknown }) => {
    if (!msg || typeof msg.method !== 'string') return;
    try {
      const fn = handlers[msg.method];
      if (!fn) throw new Error(`Unknown method ${msg.method}`);
      post({ id: msg.id, result: await fn(msg.params) });
    } catch (err) {
      post({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  };
  if (port) port.on('message', (e) => void onMessage(e.data));
  else process.on('message', (m) => void onMessage(m as never));
  process.on('uncaughtException', (err) => emit('crash', String(err?.stack ?? err)));
  process.on('unhandledRejection', (err) => emit('crash', String((err as Error)?.stack ?? err)));
  emit('ready', null);
}
