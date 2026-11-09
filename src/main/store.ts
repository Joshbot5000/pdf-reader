/** Small JSON store in the app's userData folder, plus encrypted API key storage. */
import { app, safeStorage } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppState } from '../shared/ipc';

const dir = () => app.getPath('userData');
const statePath = () => join(dir(), 'state.json');
const keyPath = () => join(dir(), 'anthropic-key.bin');
export const spacesDir = () => join(dir(), 'spaces');

const empty = (): AppState => ({
  recent: [],
  signatures: [],
  templates: [],
  brand: null,
  spaces: [],
  settings: { theme: 'system' },
});

let cache: AppState | null = null;
let writing = Promise.resolve();

export async function loadState(): Promise<AppState> {
  if (cache) return cache;
  try {
    cache = { ...empty(), ...JSON.parse(await readFile(statePath(), 'utf8')) };
  } catch {
    cache = empty();
  }
  return cache!;
}

/** Apply a change and persist it (writes are serialized). */
export async function updateState(fn: (s: AppState) => void): Promise<AppState> {
  const s = await loadState();
  fn(s);
  writing = writing.then(async () => {
    await mkdir(dir(), { recursive: true });
    const tmp = `${statePath()}.tmp`;
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, statePath()); // atomic replace
  });
  await writing;
  return s;
}

export async function addRecent(path: string, name: string) {
  await updateState((s) => {
    s.recent = [{ path, name, openedAt: Date.now() }, ...s.recent.filter((r) => r.path !== path)].slice(0, 12);
  });
}

// ---------------------------------------------------------------- API key

export async function saveApiKey(key: string | null) {
  if (!key) {
    await rm(keyPath(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system, so the key cannot be saved safely.');
  }
  await mkdir(dir(), { recursive: true });
  await writeFile(keyPath(), safeStorage.encryptString(key.trim()));
}

export async function loadApiKey(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!existsSync(keyPath()) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(await readFile(keyPath()));
  } catch {
    return null;
  }
}
