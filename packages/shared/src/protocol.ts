import { authDigest, parseAuth, credentialDirectory, isRecord } from './auth.js';

export const defaultPort = 47831;
export const protocolVersion = 4;

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
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
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

export async function requestService(url: string, path: string, body?: unknown, sessionToken?: string): Promise<unknown> {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.search || address.hash || address.pathname !== '/') {
    throw new Error('仅支持连接 127.0.0.1 上的本机服务端。');
  }
  if (!path.startsWith('/')) throw new Error('服务端接口路径必须以 / 开头。');
  let response: Response;
  try {
    response = await fetch(`${address.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
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
  if (!response.ok) {
    throw new ServiceError(response.status,
      isRecord(result) && typeof result.error === 'string' ? result.error : `服务端请求失败（HTTP ${response.status}）。`, isRecord(result) ? result : {});
  }
  return result;
}

export function conflict(email: string, content: string | null): ServiceError {
  const auth = content === null ? null : parseAuth(content);
  return new ServiceError(409, '服务端凭证与本次上传不同，请确认是否覆盖。', { code: 'conflict', email, digest: content === null ? null : authDigest(content), lastRefresh: typeof auth?.last_refresh === 'string' ? auth.last_refresh : null });
}
