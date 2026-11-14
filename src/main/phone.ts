/**
 * The phone's door into Hark: a small web server on this computer that serves the phone app,
 * a live connection for the library, and endpoints to send recordings in and play audio back.
 * Every request that touches the library must carry the pairing key.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Meeting, TemplateId } from '../shared/types';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export const lanAddresses = (): string[] =>
  Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

export type UploadMeta = { rid: string; createdAt: number; template: TemplateId; bookmarks: number[]; name?: string };

export type PhoneHost = {
  dataDir: string;
  uiDir: string;
  /** The calls a paired phone may make. Anything not listed here is refused. */
  api: Record<string, (...args: any[]) => unknown>;
  /** A copy of the conversation's audio that every phone can play (AAC), made on first request. */
  audioFile(id: string): Promise<string | null>;
  /** Take ownership of an uploaded recording and queue it for transcription. */
  upload(file: string, meta: UploadMeta): Meeting;
  hasMeeting(id: string): boolean;
};

export type PhoneServer = { port: number; token: string; broadcast(event: string, data: unknown): void; clients(): number; close(): void };

const same = (a: string, b: string): boolean => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function phoneToken(dataDir: string): string {
  const file = path.join(dataDir, 'phone.json');
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8')).token;
    if (typeof t === 'string' && t.length >= 24) return t;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
  return token;
}

export function servePhone(host: PhoneHost, port: number): Promise<PhoneServer> {
  const token = phoneToken(host.dataDir);
  const inbox = path.join(host.dataDir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  // Recordings already received, so a phone that retries after a dropped reply never creates a duplicate.
  const seenFile = path.join(inbox, 'received.json');
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  } catch {
    /* none yet */
  }
  const inFlight = new Set<string>();

  const json = (res: http.ServerResponse, code: number, body: unknown): void => void res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  const authed = (url: URL): boolean => same(url.searchParams.get('k') ?? '', token);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/health') return json(res, 200, { ok: true, app: 'hark' });

    if (p === '/upload' && req.method === 'POST') {
      if (!authed(url)) return json(res, 401, { error: 'This phone is not paired.' });
      const rid = (url.searchParams.get('rid') ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (!rid) return json(res, 400, { error: 'Missing recording id.' });
      if (seen[rid] && host.hasMeeting(seen[rid])) {
        req.resume();
        return json(res, 200, { meetingId: seen[rid], duplicate: true });
      }
      if (inFlight.has(rid)) {
        req.resume();
        return json(res, 409, { error: 'Already receiving this recording.' });
      }
      inFlight.add(rid);
      const ext = (url.searchParams.get('ext') ?? 'm4a').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'm4a';
      const file = path.join(inbox, `${rid}.${ext}`);
      const out = fs.createWriteStream(file);
      let bytes = 0;
      req.on('data', (d: Buffer) => (bytes += d.length));
      req.pipe(out);
      const fail = (): void => {
        inFlight.delete(rid);
        out.destroy();
        fs.rm(file, { force: true }, () => undefined);
        if (!res.headersSent) json(res, 400, { error: 'The recording did not arrive in full.' });
      };
      req.on('aborted', fail);
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        inFlight.delete(rid);
        const expected = Number(req.headers['content-length'] ?? bytes);
        if (!bytes || bytes !== expected) return fail();
        try {
          const marks = (url.searchParams.get('marks') ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
          const tpl = url.searchParams.get('tpl') ?? 'meeting';
          const m = host.upload(file, {
            rid,
            createdAt: Number(url.searchParams.get('t')) || Date.now(),
            template: (['meeting', 'lecture', 'interview', 'memo'].includes(tpl) ? tpl : 'meeting') as TemplateId,
            bookmarks: marks,
            name: url.searchParams.get('name')?.slice(0, 120) || undefined,
          });
          seen[rid] = m.id;
          const keys = Object.keys(seen);
          if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete seen[k];
          fs.writeFileSync(seenFile, JSON.stringify(seen));
          json(res, 200, { meetingId: m.id });
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    const audio = p.match(/^\/audio\/([a-z0-9]+)$/);
    if (audio) {
      if (!authed(url)) return void res.writeHead(401).end();
      void host.audioFile(audio[1]).then(
        (file) => {
          if (!file) return void res.writeHead(404).end();
          const size = fs.statSync(file).size;
          const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
          const start = range?.[1] ? +range[1] : 0;
          const end = Math.min(range?.[2] ? +range[2] : size - 1, size - 1);
          if (start > end) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          res.writeHead(range ? 206 : 200, {
            'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'private, max-age=3600',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
          });
          if (req.method === 'HEAD') return void res.end();
          fs.createReadStream(file, { start, end }).pipe(res);
        },
        () => void res.writeHead(500).end(),
      );
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    if (p === '/manifest.webmanifest') {
      // The home-screen app has its own storage on iOS, so the pairing key travels in its start address.
      const k = authed(url) ? `?k=${token}` : '';
      res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify({
        name: 'Hark', short_name: 'Hark', description: 'Your private AI notetaker.', start_url: `./${k}`, scope: './', display: 'standalone', orientation: 'portrait',
        background_color: '#08090e', theme_color: '#08090e',
        icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
      }));
    }
    let rel = p.replace(/^\/+/, '') || 'index.html';
    let file = path.join(host.uiDir, rel);
    if (!file.startsWith(host.uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) (rel = 'index.html'), (file = path.join(host.uiDir, rel));
    if (!fs.existsSync(file)) return void res.writeHead(404).end('The phone app has not been built.');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': rel === 'index.html' || rel === 'sw.js' || rel === 'manifest.webmanifest' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const sockets = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || !authed(url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('message', async (raw) => {
        let msg: { id?: number; method?: string; args?: unknown[] };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        const fn = Object.hasOwn(host.api, msg.method ?? '') ? host.api[msg.method!] : undefined;
        if (!fn) return void ws.send(JSON.stringify({ id: msg.id, error: `Unknown call ${msg.method}` }));
        try {
          const result = await fn(...(Array.isArray(msg.args) ? msg.args : []));
          ws.send(JSON.stringify({ id: msg.id, result: result === undefined ? null : result }));
        } catch (err) {
          ws.send(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }));
        }
      });
      const drop = (): void => void sockets.delete(ws);
      ws.on('close', drop);
      ws.on('error', drop);
    });
  });
  // Phones on mobile networks drop idle connections silently; a heartbeat keeps the link honest.
  const beat = setInterval(() => {
    for (const ws of sockets) if (ws.readyState === 1) ws.ping();
  }, 25000);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        token,
        broadcast: (event, data) => {
          if (!sockets.size) return;
          const s = JSON.stringify({ event, data });
          for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
        },
        clients: () => sockets.size,
        close: () => {
          clearInterval(beat);
          for (const ws of sockets) ws.terminate();
          wss.close();
          server.close();
        },
      });
    });
  });
}
