import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultPort, isRecord, ServiceError, rpcPath } from '@weiguangchao/codexplus-shared';
import { CredentialStore } from './store.js';
import { CurrentLoginStore } from './current-login.js';
import { BrowserSessions } from './browser-sessions.js';
import { browserLogin } from './browser-login.js';
import { findCodexProcesses } from './processes.js';
import { restartCodexServer } from './restart-codex.js';
import { createOperations } from './operations.js';
import { dispatchRpc, rpcError, RpcError } from './rpc.js';
import { AntigravityLogins } from './antigravity.js';

class HttpError extends ServiceError {}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new HttpError({ status: 415, message: '请求必须使用 application/json。' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError({ status: 400, message: '请求内容格式无效。' });
    const buffer = chunk;
    size += buffer.length;
    if (size > 128 * 1024) {
      throw new HttpError({ status: 413, message: '请求内容过大。' });
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value;
  } catch {
    throw new RpcError({ code: -32700, message: '请求 JSON 格式无效。' });
  }
}

export async function startServer({
  userHome = homedir(), home = join(userHome, '.codexplus'), codexHome = process.env.CODEX_HOME?.trim() || join(userHome, '.codex'),
  port = defaultPort, sessionToken, accountRequest = fetch, login = browserLogin, findProcesses = findCodexProcesses, restartServer = restartCodexServer,
}: { home?: string; userHome?: string; codexHome?: string; port?: number; sessionToken?: string; accountRequest?: typeof fetch;
  login?: typeof browserLogin; findProcesses?: typeof findCodexProcesses; restartServer?: typeof restartCodexServer } = {}): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const store = new CredentialStore({ home, request: accountRequest });
  const current = new CurrentLoginStore({ store, home, userHome, codexHome });
  const browsers = new BrowserSessions(login);
  const antigravity = new AntigravityLogins({ home, userHome });
  const invoke = createOperations({ store, current, browsers, antigravity, home, accountRequest, findProcesses, restartServer });

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const handle = async (): Promise<void> => {
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError({ status: 403, message: '不接受浏览器跨站请求。' });
      }
      const hosts = port === 80 ? ['127.0.0.1', 'localhost', '127.0.0.1:80', 'localhost:80'] : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host ?? '')) {
        throw new HttpError({ status: 403, message: '仅接受本机地址的请求。' });
      }
      if (request.url !== rpcPath) throw new HttpError({ status: 404, message: '未找到服务端接口。' });
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        throw new HttpError({ status: 405, message: 'JSON-RPC 接口仅接受 POST 请求。' });
      }
      const body = await readBody(request);
      if (sessionToken !== undefined) {
        const provided = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${sessionToken}`);
        const calls = Array.isArray(body) ? body : [body];
        const healthOnly = calls.length > 0 && calls.every((call) => isRecord(call) && call.method === 'health');
        if (!healthOnly && (provided.length !== expected.length || !timingSafeEqual(provided, expected))) {
          throw new HttpError({ status: 401, message: '本机会话无效，请重新启动客户端。' });
        }
      }
      await ready;
      const result = await dispatchRpc({ value: body, invoke });
      if (result === undefined) response.statusCode = 204;
      response.end(result === undefined ? undefined : JSON.stringify(result));
    };
    void handle().catch((error: unknown) => {
      request.resume();
      response.statusCode = error instanceof HttpError ? error.status : error instanceof RpcError ? 200 : 500;
      response.end(JSON.stringify(rpcError({ id: null, error })));
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
  const close = async (): Promise<void> => {
    await browsers.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  };
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
