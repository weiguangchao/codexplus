import { authDigest, parseAuth, credentialFilename, isRecord } from './auth.js';

export const defaultPort = 47831;
export const defaultServerUrl = localUrl(defaultPort);

export interface Credential {
  type: 'codex';
  email: string;
}

export type CurrentLogin =
  | { status: 'none' }
  | { status: 'saved'; email: string }
  | { status: 'ahead'; email: string }
  | { status: 'behind'; email: string }
  | { status: 'diverged'; email: string }
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
  credentialFilename(value.email);
  return { type: 'codex', email: value.email };
}

export function localUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function isLoopbackHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

export function isLoopbackUrl(url: string): boolean {
  return isLoopbackHost(new URL(url).hostname);
}

export function serverUrl(value: string, local = false): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的服务端地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务端地址必须是 HTTP(S) 根地址，不能包含密码、路径或查询参数。');
  }
  if (local && !isLoopbackHost(url.hostname)) {
    throw new Error('服务端管理命令仅限本机回环地址。');
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('远程服务端必须使用 HTTPS，以保护配对码和账户凭证。');
  }
  return url.origin;
}

export async function requestService(url: string, path: string, token?: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch {
    throw new Error(`无法连接 codexplus 服务端 ${url}，请确认服务已启动、地址和证书配置正确。`);
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

export function conflict(email: string, content: string): ServiceError {
  const auth = parseAuth(content);
  return new ServiceError(409, '服务端版本已更新，请确认是否覆盖。', { code: 'conflict', email, digest: authDigest(content), lastRefresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : null });
}
