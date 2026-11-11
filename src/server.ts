import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerOptions as SecureOptions } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AccessStore } from './access.js';
import { isRecord, parseAuth } from './auth.js';
import { consumeLocalCode, createLocalCode, isLocalPurpose, isNonce, localEndpoint } from './local-codes.js';
import { ServiceError, parseCredential } from './protocol.js';
import { CredentialStore } from './store.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new HttpError(415, '请求必须使用 application/json。');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > 128 * 1024) {
      throw new HttpError(413, '请求内容过大。');
    }
    chunks.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(body)) {
      throw new Error();
    }
    return body;
  } catch {
    throw new HttpError(400, '请求 JSON 格式无效。');
  }
}

function loopback(address: string | undefined): boolean {
  return address === '::1' || /^127\./u.test(address ?? '') || /^::ffff:127\./u.test(address ?? '');
}

export async function startServer({
  home = join(homedir(), '.codexplus'), host = '127.0.0.1', port = 47831, tls, accountRequest = fetch,
}: { home?: string; host?: string; port?: number; tls?: SecureOptions; accountRequest?: typeof fetch } = {}): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const access = new AccessStore(home);
  const store = new CredentialStore({ home, request: accountRequest });
  let queue: Promise<unknown> = Promise.resolve();

  function clientName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 100) {
      throw new HttpError(400, '请输入客户端名称（最多 100 字符）。');
    }
    return value.trim();
  }

  async function localRoute(request: IncomingMessage, path: string, body: Record<string, unknown>): Promise<unknown> {
    if (path === '/v1/local/challenge') {
      if (!isLocalPurpose(body.purpose) || !isNonce(body.nonce)) {
        throw new HttpError(400, '本机验证用途或随机数无效。');
      }
      const id = await createLocalCode(home, body.purpose, body.nonce, localEndpoint(request.socket.localAddress, request.socket.localPort));
      if (id === null) {
        throw new HttpError(429, '本机验证请求过多，请稍后重试。');
      }
      return { id };
    }
    const pairing = path === '/v1/local/pair';
    if (!await consumeLocalCode(home, body.proof, pairing ? 'pair' : 'admin')) {
      throw new HttpError(403, '本机验证失败：客户端或管理命令需要与服务端使用同一系统用户和同一 --home 目录。');
    }
    if (pairing) {
      return await access.addClient(clientName(body.name));
    }
    if (path === '/v1/admin/pair') {
      return await access.createPair();
    }
    if (path === '/v1/admin/clients') {
      return { clients: await access.list() };
    }
    if (path === '/v1/admin/revoke') {
      if (typeof body.id !== 'string') {
        throw new HttpError(400, '请输入客户端 ID。');
      }
      try {
        await access.revoke(body.id);
      } catch {
        throw new HttpError(400, '撤销失败：客户端不存在，或服务端无法保存授权。');
      }
      return { ok: true };
    }
    throw new HttpError(404, '未找到服务端接口。');
  }

  async function route(request: IncomingMessage, body: Record<string, unknown>): Promise<unknown> {
    if (request.headers.origin) {
      throw new HttpError(403, '不接受浏览器跨站请求。');
    }
    const path = request.url ?? '';
    if (request.method === 'GET' && path === '/v1/health') {
      return { service: 'codexplus', version: 2 };
    }
    if (request.method === 'POST' && path === '/v1/pair') {
      if (typeof body.code !== 'string' || body.code.length > 128) {
        throw new HttpError(400, '请输入配对码。');
      }
      const name = clientName(body.name);
      try {
        return await access.redeem(body.code.trim(), name);
      } catch {
        throw new HttpError(400, '配对失败：配对码无效、已过期、已使用，或服务端无法保存授权。');
      }
    }
    if (request.method === 'POST' && (path.startsWith('/v1/local/') || path.startsWith('/v1/admin/'))) {
      if (!loopback(request.socket.remoteAddress)) {
        throw new HttpError(403, '本机验证和管理操作只接受回环连接。');
      }
      return await localRoute(request, path, body);
    }
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const client = token ? await access.authorize(token) : null;
    if (!client) {
      throw new HttpError(401, '客户端未获授权或授权已被撤销，需要重新配对。');
    }
    if (request.method === 'GET' && path === '/v1/session') {
      return { client };
    }
    if (request.method === 'GET' && path === '/v1/credentials') {
      const credentials = await store.list();
      return { credentials: await Promise.all(credentials.map(async (credential) => ({ ...credential, digest: await store.digest(credential), lastRefresh: await store.get(credential).then((content) => { const value = parseAuth(content).last_refresh; return typeof value === 'string' ? value : null; }).catch(() => null) }))) };
    }
    if (request.method === 'POST' && (path === '/v1/credentials' || path === '/v1/credentials/download')) {
      try {
        if (path === '/v1/credentials') {
          if (body.base !== null && typeof body.base !== 'string') throw new HttpError(400, '上传必须提供 base 摘要或 null。');
          return { credential: await store.add(JSON.stringify(body.auth), body.base) };
        }
        return { auth: parseAuth(await store.get(parseCredential(body))) };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error instanceof Error && !('code' in error)) {
          throw new HttpError(400, error.message);
        }
        throw error;
      }
    }
    throw new HttpError(404, '未找到服务端接口。');
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const handle = async (): Promise<void> => {
      const body = request.method === 'POST' ? await readBody(request) : {};
      const operation = queue.then(async () => {
        await ready;
        return await route(request, body);
      });
      queue = operation.catch(() => {});
      response.end(JSON.stringify(await operation));
    };
    void handle().catch((error: unknown) => {
      request.resume();
      response.statusCode = error instanceof HttpError || error instanceof ServiceError ? error.status : 500;
      response.end(JSON.stringify({ error: error instanceof HttpError || error instanceof ServiceError ? error.message : '服务端操作失败，请检查服务端文件权限和配置。', ...(error instanceof ServiceError ? error.details : {}) }));
    });
  };
  const server = tls ? createSecureServer(tls, handler) : createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  }).then(() => access.check());
  const close = (): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
  try {
    await ready;
  } catch (error) {
    if (server.listening) {
      await close();
    }
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close();
    throw new Error('无法读取服务端监听地址。');
  }
  const hostname = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  return { url: `${tls ? 'https' : 'http'}://${hostname}:${address.port}`, close };
}
