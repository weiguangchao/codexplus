import { authDigest, parseAuth, credentialDirectory, isRecord } from './auth.js';
import { randomUUID } from 'node:crypto';

export const defaultPort = 47831;
export const protocolVersion = 5;
export const rpcPath = '/rpc';

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: object;
  id?: RpcId;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: unknown } };

export interface Credential {
  type: 'codex';
  email: string;
}

export interface UploadResult {
  credential: Credential;
  changed: boolean;
}

export type CurrentLogin =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'saved'; email: string }
  | { status: 'ahead'; email: string }
  | { status: 'behind'; email: string }
  | { status: 'diverged'; email: string }
  | { status: 'deleted'; email: string }
  | { status: 'unsaved'; email: string | null };

export class ServiceError extends Error {
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}, readonly rpcCode?: number) {
    super(message);
  }
}

export function parseCredential(value: unknown): Credential {
  if (!isRecord(value) || value.type !== 'codex' || typeof value.email !== 'string') {
    throw new Error('凭证信息格式无效。');
  }
  credentialDirectory(value.email);
  return { type: 'codex', email: value.email };
}

export async function requestService(url: string, method: string, params?: object, sessionToken?: string, timeoutMs = 20_000): Promise<unknown> {
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
    throw new ServiceError(response.status, '服务端未返回有效的 JSON 数据。');
  }
  if (!isRecord(result) || result.jsonrpc !== '2.0' || (result.id !== id && (response.ok || result.id !== null)) ||
    Object.hasOwn(result, 'result') === Object.hasOwn(result, 'error')) {
    throw new ServiceError(response.ok ? 502 : response.status, '服务端未返回有效的 JSON-RPC 响应。');
  }
  if (Object.hasOwn(result, 'error')) {
    const error = result.error;
    if (!isRecord(error) || !Number.isInteger(error.code) || typeof error.message !== 'string') {
      throw new ServiceError(response.ok ? 502 : response.status, '服务端未返回有效的 JSON-RPC 错误。');
    }
    const data = isRecord(error.data) ? error.data : {};
    const status = typeof data.status === 'number' && Number.isInteger(data.status) && data.status >= 400 && data.status <= 599 ?
      data.status : error.code === -32601 ? 404 : [-32700, -32600, -32602].includes(Number(error.code)) ? 400 : 500;
    throw new ServiceError(response.ok ? status : response.status, error.message, data, Number(error.code));
  }
  if (!response.ok) throw new ServiceError(response.status, `服务端请求失败（HTTP ${response.status}）。`);
  return result.result;
}

export function conflict(email: string, content: string | null): ServiceError {
  const auth = content === null ? null : parseAuth(content);
  return new ServiceError(409, '服务端凭证与本次上传不同，请确认是否覆盖。', { code: 'conflict', email, digest: content === null ? null : authDigest(content), lastRefresh: typeof auth?.last_refresh === 'string' ? auth.last_refresh : null });
}
