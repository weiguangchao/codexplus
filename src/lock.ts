import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isRecord } from './auth.js';
import { readOptional } from './files.js';

const queues = new Map<string, Promise<unknown>>();

async function acquire(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, '.lock');
  const started = Date.now();
  for (;;) {
    const content = JSON.stringify({ pid: process.pid, id: randomUUID(), time: Date.now() });
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
      return async () => { if (await readOptional(path) === content) await rm(path, { force: true }); };
    } catch (error) {
      if (!isRecord(error) || !(error.code === 'EEXIST' || process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code)))) throw error;
    }
    try {
      const old = await readOptional(path);
      if (old !== null) {
        const value: unknown = JSON.parse(old);
        if (isRecord(value) && typeof value.time === 'number' && Date.now() - value.time > 30_000 && await readOptional(path) === old) await rm(path, { force: true });
      }
    } catch (error) {
      if (!isRecord(error) || !['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (Date.now() - started >= 10_000) throw new Error('数据目录正被其他 codexplus 进程占用。');
    await setTimeout(5 + Math.floor(Math.random() * 21));
  }
}

export async function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(home);
  const operation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const release = await acquire(key);
    try { return await fn(); } finally { await release(); }
  });
  queues.set(key, operation);
  try { return await operation; } finally { if (queues.get(key) === operation) queues.delete(key); }
}
