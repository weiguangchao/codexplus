import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerOptions as SecureOptions } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AccessStore } from './access.js';
import { isRecord, parseAuth } from './auth.js';
import { parseCredential } from './protocol.js';
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

  async function route(request: IncomingMessage, body: Record<string, unknown>): Promise<unknown> {
    if (request.headers.origin) {
      throw new HttpError(403, '不接受浏览器跨站请求。');
    }
    const path = request.url;
    if (request.method === 'POST' && path === '/v1/pair') {
      if (typeof body.code !== 'string' || body.code.length > 128 || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) {
        throw new HttpError(400, '请输入配对码和客户端名称（最多 100 字符）。');
      }
      try {
        return await access.redeem(body.code.trim(), body.name.trim());
      } catch {
        throw new HttpError(400, '配对失败：配对码无效、已过期、已使用，或服务端无法保存授权。');
      }
    }
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const role = token ? access.authorize(token, loopback(request.socket.remoteAddress)) : null;
    if (!role) {
      throw new HttpError(401, '客户端未获授权，请先配对。');
    }
    if (path?.startsWith('/v1/admin/') && role !== 'local') {
      throw new HttpError(403, '客户端授权不能管理服务端配对。');
    }
    if (request.method === 'GET' && path === '/v1/credentials') {
      return { credentials: await store.list() };
    }
    if (request.method === 'GET' && path === '/v1/admin/clients') {
      return { clients: access.list() };
    }
    if (request.method === 'POST') {
      if (path === '/v1/admin/pair') {
        return await access.createPair();
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
      if (path === '/v1/credentials' || path === '/v1/credentials/download') {
        try {
          if (path === '/v1/credentials') {
            return { credential: await store.add(JSON.stringify(body.auth)) };
          }
          return { auth: parseAuth(await store.get(parseCredential(body))) };
        } catch (error) {
          if (error instanceof Error && !('code' in error)) {
            throw new HttpError(400, error.message);
          }
          throw error;
        }
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
      response.statusCode = error instanceof HttpError ? error.status : 500;
      response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : '服务端操作失败，请检查服务端文件权限和配置。' }));
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
  }).then(() => access.initialize());
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
