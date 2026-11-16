import { z } from 'zod';
import { authDigest, isRecord } from './auth.js';
import type { Auth } from './auth.js';
import type { Email } from './identity.js';
import type { UploadConflict } from './session.js';
import { randomUUID } from 'node:crypto';

export const defaultPort = 47831;
export const protocolVersion = 5;
export const rpcPath = '/rpc';

const rpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);
export const rpcRequestSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.string(),
  params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(), id: rpcIdSchema.optional() });
const rpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: rpcIdSchema, result: z.unknown() }).refine((value) => Object.hasOwn(value, 'result')),
  z.object({ jsonrpc: z.literal('2.0'), id: rpcIdSchema,
    error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) }),
]);

export type RpcId = z.infer<typeof rpcIdSchema>;
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export function parseRpcResponse(value: unknown): RpcResponse {
  if (!isRecord(value) || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) {
    throw new Error('服务端未返回有效的 JSON-RPC 响应。');
  }
  const result = rpcResponseSchema.safeParse(value);
  if (!result.success) throw new Error('服务端未返回有效的 JSON-RPC 响应。');
  return result.data;
}

export class ServiceError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly rpcCode: number | undefined;
  constructor({ status, message, details = {}, rpcCode }: { status: number; message: string; details?: unknown | undefined; rpcCode?: number | undefined }) {
    super(message);
    this.status = status;
    this.details = details;
    this.rpcCode = rpcCode;
  }
}

export class UploadConflictError extends ServiceError {
  readonly details: UploadConflict;
  constructor(details: UploadConflict) {
    super({ status: 409, message: '服务端凭证与本次上传不同，请确认是否覆盖。', details });
    this.details = details;
  }
}

export async function requestService({ url, method, params, sessionToken, timeoutMs = 20_000 }: { url: string; method: string; params?: RpcRequest['params']; sessionToken?: string | undefined; timeoutMs?: number | undefined }): Promise<unknown> {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.search || address.hash || address.pathname !== '/') {
    throw new Error('仅支持连接 127.0.0.1 上的本机服务端。');
  }
  const id = randomUUID();
  const body: RpcRequest = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  let response: Response;
  try {
    response = await fetch(`${address.origin}${rpcPath}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new Error(`无法连接 codexplus 本机服务端 ${url}，请确认服务已启动、端口配置正确。`);
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ServiceError({ status: response.status, message: '服务端未返回有效的 JSON 数据。' });
  }
  let parsed: RpcResponse;
  try { parsed = parseRpcResponse(result); } catch {
    throw new ServiceError({ status: response.ok ? 502 : response.status, message: '服务端未返回有效的 JSON-RPC 响应。' });
  }
  if (parsed.id !== id && (response.ok || parsed.id !== null)) {
    throw new ServiceError({ status: response.ok ? 502 : response.status, message: '服务端未返回有效的 JSON-RPC 响应。' });
  }
  if ('error' in parsed) {
    const { error } = parsed;
    const data = isRecord(error.data) ? error.data : {};
    const status = typeof data.status === 'number' && Number.isInteger(data.status) && data.status >= 400 && data.status <= 599 ?
      data.status : error.code === -32601 ? 404 : [-32700, -32600, -32602].includes(error.code) ? 400 : 500;
    throw new ServiceError({ status: response.ok ? status : response.status, message: error.message, details: data, rpcCode: error.code });
  }
  if (!response.ok) throw new ServiceError({ status: response.status, message: `服务端请求失败（HTTP ${response.status}）。` });
  return parsed.result;
}

export function conflict({ email, auth }: { email: Email; auth: Auth | null }): UploadConflictError {
  return new UploadConflictError({ code: 'conflict', email, digest: auth === null ? null : authDigest(auth),
    lastRefresh: typeof auth?.last_refresh === 'string' ? auth.last_refresh : null, localRefresh: null });
}
