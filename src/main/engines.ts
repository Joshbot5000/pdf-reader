/** Main-process side of the engine channel: start a worker, call it, listen for its events. */
import { EventEmitter } from 'node:events';

export type ChildLike = {
  postMessage(msg: unknown): void;
  on(ev: 'message', cb: (msg: any) => void): void;
  on(ev: 'exit', cb: (code: number) => void): void;
  kill(): void;
};
export type Fork = (script: string, name: string) => ChildLike;

export class Engine extends EventEmitter {
  private child: ChildLike | null = null;
  private ready: Promise<void> | null = null;
  private seq = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** Runs after every (re)start, before queued calls: put model/session setup here. */
  onStart: (() => Promise<void>) | null = null;

  constructor(private fork: Fork, private script: string, private name: string) {
    super();
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve) => {
      const child = this.fork(this.script, this.name);
      this.child = child;
      child.on('message', (msg: any) => {
        if (msg?.event === 'ready') return resolve();
        if (msg?.event) return void this.emit(msg.event, msg.data);
        const p = this.pending.get(msg?.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      });
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.ready = null;
        for (const p of this.pending.values()) p.reject(new Error(`${this.name} engine stopped unexpectedly (code ${code})`));
        this.pending.clear();
        this.emit('exit', code);
      });
    }).then(async () => {
      if (this.onStart) await this.onStart();
    });
    return this.ready;
  }

  /** Call that bypasses onStart (used by onStart itself). */
  raw<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.seq++;
      this.pending.set(id, { resolve, reject });
      this.child!.postMessage({ id, method, params });
    });
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.start();
    return this.raw<T>(method, params);
  }

  get running(): boolean {
    return !!this.child;
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    this.ready = null;
    c?.kill();
  }
}
