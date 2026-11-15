import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordAudit, recordCommitted } from './audit.js';
import { defaultPort, isRecord, parseAuth, ServiceError, parseCredential, protocolVersion, rpcPath } from '@weiguangchao/codexplus-shared';
import { CredentialStore } from './store.js';
import { CurrentLoginStore } from './current-login.js';
import type { SaveOptions } from './current-login.js';
import { BrowserSessions } from './browser-sessions.js';
import { browserLogin } from './browser-login.js';
import { findCodexProcesses } from './processes.js';
import { restartCodexServer } from './restart-codex.js';
import { listResetCards, useResetCard } from './reset-cards.js';
import { lookupAccountInfo } from './account-info.js';
import { idTokenEmail } from './login.js';
import { dispatchRpc, rpcError, RpcError } from './rpc.js';

class HttpError extends ServiceError {}

async function readBody(request: IncomingMessage): Promise<unknown> {
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RpcError(-32700, '请求 JSON 格式无效。');
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
  const current = new CurrentLoginStore(store, home, userHome, codexHome);
  const browsers = new BrowserSessions(login);
  const client = { id: 'local', name: '本机' };

  async function invoke(method: string, params: unknown): Promise<unknown> {
    if (!isRecord(params)) throw new RpcError(-32602, 'params 必须为命名参数对象。');
    const body = params;
    if (method === 'health') return { service: 'codexplus', version: protocolVersion };
    if (method === 'credentials.list') {
      return { credentials: await store.snapshots() };
    }
    if (method === 'login.info') return await current.info();
    if (method === 'login.current') return { current: await current.current() };
    if (method === 'login.processes') return { processes: await findProcesses() };
    if (method === 'login.accountInfo') {
      try {
        const { content } = await current.readSource(current.authPath);
        const info = await lookupAccountInfo(parseAuth(content).tokens, accountRequest);
        return { ...info, email: info.email ?? idTokenEmail(content) };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error instanceof Error && !('code' in error)) throw new ServiceError(400, error.message);
        throw error;
      }
    }
    if (['resetCards.list', 'resetCards.use'].includes(method)) {
      try {
        const credential = parseCredential(body);
        if (method === 'resetCards.list') {
          return { cards: await listResetCards(parseAuth(await store.get(credential)).tokens, accountRequest) };
        }
        if (typeof body.cardId !== 'string' || !body.cardId.trim() ||
          typeof body.requestId !== 'string' || !body.requestId.trim()) {
          throw new ServiceError(400, '使用重置卡必须提供 cardId 和 requestId。');
        }
        const { tokens } = parseAuth(await store.get(credential));
        const outcome = await useResetCard(tokens, body.cardId, body.requestId, accountRequest);
        if (outcome === 'reset') await recordCommitted(home, '重置', client, { email: credential.email });
        return { outcome };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error instanceof Error && !('code' in error)) throw new ServiceError(400, error.message);
        throw error;
      }
    }
    if (['login.save', 'login.switch', 'login.refreshTimes', 'login.restartServer',
      'credentials.import', 'credentials.validate', 'login.browser.start', 'login.browser.status',
      'login.browser.save', 'login.browser.cancel'].includes(method)) {
      try {
        const options: SaveOptions = {};
        if (Object.hasOwn(body, 'base')) {
          if (body.base !== null && typeof body.base !== 'string') throw new ServiceError(400, 'base 必须为摘要或 null。');
          options.base = body.base;
        }
        if (Object.hasOwn(body, 'restore')) {
          if (typeof body.restore !== 'boolean') throw new ServiceError(400, 'restore 必须为布尔值。');
          options.restore = body.restore;
        }
        if (method === 'login.save') return await current.saveCurrent(options);
        if (method === 'login.switch') return await current.switch(parseCredential(body));
        if (method === 'login.restartServer') {
          await restartServer(dirname(current.authPath));
          return { ok: true };
        }
        if (method === 'login.refreshTimes') return await current.refreshTimes(parseCredential(body).email);
        if (method === 'credentials.import' || method === 'credentials.validate') {
          if (typeof body.path !== 'string') throw new ServiceError(400, '请输入 auth.json 文件路径。');
          if (method === 'credentials.import') return await current.import(body.path, options);
          await current.readSource(body.path);
          return { ok: true };
        }
        if (method === 'login.browser.start') return browsers.start();
        if (typeof body.id !== 'string') throw new ServiceError(400, '缺少浏览器登录标识。');
        if (method === 'login.browser.status') return browsers.status(body.id);
        if (method === 'login.browser.save') return await current.save(browsers.auth(body.id), false, options);
        await browsers.cancel(body.id);
        return { ok: true };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error instanceof Error && !('code' in error)) throw new ServiceError(400, error.message);
        throw error;
      }
    }
    if (['credentials.upload', 'credentials.download', 'credentials.delete'].includes(method)) {
      try {
        if (method === 'credentials.upload') {
          if (body.base !== null && typeof body.base !== 'string') throw new ServiceError(400, '上传必须提供 base 摘要或 null。');
          const result = await store.add(JSON.stringify(body.auth), body.base);
          if (result.changed) await recordCommitted(home, '上传', client, { email: result.credential.email });
          return result;
        }
        const credential = parseCredential(body);
        if (method === 'credentials.delete') {
          if (body.base !== null && typeof body.base !== 'string') throw new ServiceError(400, '删除必须提供 base 摘要或 null。');
          await current.delete(credential, body.base);
          return { ok: true };
        }
        const auth = parseAuth(await store.get(credential));
        await recordAudit(home, '下载', client, { email: credential.email });
        return { auth };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error instanceof Error && !('code' in error)) {
          throw new ServiceError(400, error.message);
        }
        throw error;
      }
    }
    throw new RpcError(-32601, '未找到服务端方法。');
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
      if (request.url !== rpcPath) throw new HttpError(404, '未找到服务端接口。');
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        throw new HttpError(405, 'JSON-RPC 接口仅接受 POST 请求。');
      }
      const body = await readBody(request);
      if (sessionToken !== undefined) {
        const provided = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${sessionToken}`);
        const calls = Array.isArray(body) ? body : [body];
        const healthOnly = calls.length > 0 && calls.every((call) => isRecord(call) && call.method === 'health');
        if (!healthOnly && (provided.length !== expected.length || !timingSafeEqual(provided, expected))) {
          throw new HttpError(401, '本机会话无效，请重新启动客户端。');
        }
      }
      await ready;
      const result = await dispatchRpc(body, invoke);
      if (result === undefined) response.statusCode = 204;
      response.end(result === undefined ? undefined : JSON.stringify(result));
    };
    void handle().catch((error: unknown) => {
      request.resume();
      response.statusCode = error instanceof HttpError ? error.status : error instanceof RpcError ? 200 : 500;
      response.end(JSON.stringify(rpcError(null, error)));
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
