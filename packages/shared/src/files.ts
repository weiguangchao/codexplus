import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isRecord } from './auth.js';

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    const started = Date.now();
    for (;;) {
      try { await rename(temporary, path); break; } catch (error) {
        if (process.platform !== 'win32' || !isRecord(error) || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code)) || Date.now() - started >= 2_000) throw error;
        await setTimeout(20);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function expandPath(home: string, path: string): string {
  let trimmed = path.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    trimmed = trimmed.slice(1, -1);
  } else if (process.platform !== 'win32') {
    trimmed = trimmed.replaceAll('\\ ', ' ');
  }
  return trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : resolve(trimmed);
}
