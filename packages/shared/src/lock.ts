import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isRecord } from './auth.js';
import { readOptional } from './files.js';

const queues = new Map<string, Promise<unknown>>();

function lockTime(content: string): number | null {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) && typeof value.time === 'number' ? value.time : null;
  } catch {
    return null;
  }
}

function busy(error: unknown): boolean {
  return isRecord(error) && (error.code === 'EEXIST' || process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code)));
}

async function age(path: string, content: string | null): Promise<number> {
  return Date.now() - ((content === null ? null : lockTime(content)) ?? (await stat(path)).mtimeMs);
}

async function reclaim(path: string): Promise<void> {
  const seen = await readOptional(path);
  if (seen === null || await age(path, seen) <= 30_000) return;
  const guard = `${path}.reclaim`;
  try {
    await (await open(guard, 'wx', 0o600)).close();
  } catch (error) {
    if (!busy(error)) throw error;
    return;
  }
  try {
    const current = await readOptional(path);
    if (current !== null && await age(path, current) > 30_000) await rm(path, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

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
      if (!busy(error)) throw error;
    }
    try {
      await reclaim(path);
    } catch (error) {
      if (!isRecord(error) || !['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error;
    }
    if (Date.now() - started >= 10_000) {
      const guard = `${path}.reclaim`;
      throw new Error(await readOptional(guard).catch(() => '') === null
        ? '数据目录正被其他 codexplus 进程占用。'
        : `数据目录的锁无法回收：上次回收被中断，留下了 ${guard}。请确认没有其他 codexplus 在运行后删除该文件。`);
    }
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
