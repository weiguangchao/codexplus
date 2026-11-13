import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordAudit, recordCommitted } from './audit.js';
import { defaultPort, isRecord, parseAuth, ServiceError, parseCredential, protocolVersion } from '@codexplus/shared';
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

export async function startServer({
  home = join(homedir(), '.codexplus'), port = defaultPort, sessionToken, accountRequest = fetch,
}: { home?: string; port?: number; sessionToken?: string; accountRequest?: typeof fetch } = {}): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const store = new CredentialStore({ home, request: accountRequest });
  const client = { id: 'local', name: '本机' };

  async function route(request: IncomingMessage, body: Record<string, unknown>): Promise<unknown> {
    const path = request.url ?? '';
    if (request.method === 'GET' && path === '/v1/health') {
      return { service: 'codexplus', version: protocolVersion };
    }
    if (sessionToken !== undefined) {
      const provided = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${sessionToken}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new HttpError(401, '本机会话无效，请重新启动客户端。');
      }
    }
    if (request.method === 'GET' && path === '/v1/credentials') {
      return { credentials: await store.snapshots() };
    }
    if (request.method === 'POST' && (path === '/v1/credentials' || path === '/v1/credentials/download' || path === '/v1/credentials/delete')) {
      try {
        if (path === '/v1/credentials') {
          if (body.base !== null && typeof body.base !== 'string') throw new HttpError(400, '上传必须提供 base 摘要或 null。');
          const result = await store.add(JSON.stringify(body.auth), body.base);
          if (result.changed) await recordCommitted(home, '上传', client, { email: result.credential.email });
          return result;
        }
        const credential = parseCredential(body);
        if (path === '/v1/credentials/delete') {
          if (body.base !== null && typeof body.base !== 'string') throw new HttpError(400, '删除必须提供 base 摘要或 null。');
          await store.delete(credential, body.base);
          await recordCommitted(home, '删除', client, { email: credential.email });
          return { ok: true };
        }
        const auth = parseAuth(await store.get(credential));
        await recordAudit(home, '下载', client, { email: credential.email });
        return { auth };
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
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, '不接受浏览器跨站请求。');
      }
      const hosts = port === 80 ? ['127.0.0.1', 'localhost', '127.0.0.1:80', 'localhost:80'] : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host ?? '')) {
        throw new HttpError(403, '仅接受本机地址的请求。');
      }
      const body = request.method === 'POST' ? await readBody(request) : {};
      await ready;
      response.end(JSON.stringify(await route(request, body)));
    };
    void handle().catch((error: unknown) => {
      request.resume();
      response.statusCode = error instanceof HttpError || error instanceof ServiceError ? error.status : 500;
      response.end(JSON.stringify({ error: error instanceof HttpError || error instanceof ServiceError ? error.message : '服务端操作失败，请检查服务端文件权限和配置。', ...(error instanceof ServiceError ? error.details : {}) }));
    });
  };
  const server = createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
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
  port = address.port;
  return { url: `http://127.0.0.1:${port}`, close };
}
