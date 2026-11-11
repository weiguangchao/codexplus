import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './auth.js';
import { readOptional, writeAtomic } from './files.js';
import { requestService } from './protocol.js';

export type LocalPurpose = 'pair' | 'admin' | 'verify';

export interface LocalProof {
  id: string;
  code: string;
}

interface LocalCode {
  purpose: LocalPurpose;
  nonce: string;
  endpoint: string;
  code: string;
  expiresAt: number;
}

const purposes: readonly string[] = ['pair', 'admin', 'verify'];
const lifetime = 60_000;
const pendingLimit = 32;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const noncePattern = /^[A-Za-z0-9_-]{43}$/u;

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && noncePattern.test(value);
}

export function isLocalPurpose(value: unknown): value is LocalPurpose {
  return typeof value === 'string' && purposes.includes(value);
}

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function localEndpoint(address: string | undefined, port: number | undefined): string {
  return `${(address ?? '').replace(/^::ffff:/u, '')}:${port ?? 0}`;
}

export function localCodesPath(home: string): string {
  return join(home, 'local-codes');
}

function codePath(home: string, id: string): string | null {
  return idPattern.test(id) ? join(localCodesPath(home), `${id}.json`) : null;
}

function parseCode(content: string | null): LocalCode | null {
  if (content === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) && isLocalPurpose(value.purpose) && typeof value.nonce === 'string' && typeof value.endpoint === 'string' &&
      typeof value.code === 'string' && typeof value.expiresAt === 'number'
      ? { purpose: value.purpose, nonce: value.nonce, endpoint: value.endpoint, code: value.code, expiresAt: value.expiresAt } : null;
  } catch {
    return null;
  }
}

export async function createLocalCode(home: string, purpose: LocalPurpose, nonce: string, endpoint: string, now = Date.now()): Promise<string | null> {
  const directory = localCodesPath(home);
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  let pending = 0;
  for (const name of names) {
    const path = codePath(home, name.replace(/\.json$/u, ''));
    if (path === null) {
      continue;
    }
    const entry = parseCode(await readOptional(path));
    if (entry === null || entry.expiresAt <= now) {
      await rm(path, { force: true });
    } else {
      pending += 1;
    }
  }
  if (pending >= pendingLimit) {
    return null;
  }
  const id = randomUUID();
  const code: LocalCode = { purpose, nonce, endpoint, code: randomBytes(32).toString('base64url'), expiresAt: now + lifetime };
  await writeAtomic(join(directory, `${id}.json`), `${JSON.stringify(code)}\n`);
  return id;
}

export async function consumeLocalCode(home: string, proof: unknown, purpose: LocalPurpose, now = Date.now()): Promise<boolean> {
  if (!isRecord(proof) || typeof proof.id !== 'string' || typeof proof.code !== 'string') {
    return false;
  }
  const path = codePath(home, proof.id);
  if (path === null) {
    return false;
  }
  const entry = parseCode(await readOptional(path));
  await rm(path, { force: true });
  return entry !== null && entry.purpose === purpose && entry.expiresAt > now && secretsMatch(entry.code, proof.code);
}

export async function requestLocalProof(url: string, home: string, purpose: LocalPurpose): Promise<LocalProof | null> {
  const nonce = randomBytes(32).toString('base64url');
  const result = await requestService(url, '/v1/local/challenge', undefined, { purpose, nonce });
  if (!isRecord(result) || typeof result.id !== 'string') {
    throw new Error('服务端本机验证响应格式无效。');
  }
  const path = codePath(home, result.id);
  if (path === null) {
    return null;
  }
  let entry: LocalCode | null;
  try {
    entry = parseCode(await readOptional(path));
  } catch {
    return null;
  }
  if (purpose === 'verify') {
    await rm(path, { force: true }).catch(() => {});
  }
  const target = new URL(url);
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const hosts = target.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [target.hostname.replace(/^\[|\]$/gu, '')];
  return entry !== null && entry.purpose === purpose && hosts.some((host) => entry.endpoint === `${host}:${port}`) &&
    entry.expiresAt > Date.now() &&
    secretsMatch(entry.nonce, nonce)
    ? { id: result.id, code: entry.code } : null;
}
