import { z } from 'zod';
import { parseRpcResponse, rpcRequestSchema } from '../src/protocol.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export async function temporaryHome(context: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-cs-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

export function expectValue<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined);
  return value;
}

export function parseRpcCall(content: string) {
  const call = rpcRequestSchema.parse(JSON.parse(content));
  assert.ok(typeof call.id === 'string');
  return { ...call, id: call.id };
}

export function parseRpcFailure(value: unknown) {
  const response = parseRpcResponse(value);
  assert.ok('error' in response);
  return response;
}

export function codexBarPaths({ content, index }: { content: string; index: number }) {
  return z.object({ providers: z.array(z.object({ codexProfileHomePaths: z.array(z.string()).optional() })) })
    .parse(JSON.parse(content)).providers[index]?.codexProfileHomePaths;
}
