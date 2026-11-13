import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { connect, Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { protocolVersion, requestService } from '@codexplus/shared';
import { startServer } from '../src/server.js';
import { freePort, standalone, temporaryHome } from './helpers.js';

test('废弃本机和管理接口不创建任何文件', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const before = await readdir(home);
  for (const [method, path] of [['POST', '/v1/local/challenge'], ['POST', '/v1/admin/pair'], ['POST', '/v1/pair'], ['GET', '/v1/session']] as const) {
    const response = await fetch(`${server.url}${path}`, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(await readdir(home), before);
});

test('未完成的上传请求不会阻塞其他客户端操作', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const url = new URL(server.url);
  const socket = connect(Number(url.port), url.hostname);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', resolve);
    });
    socket.write(`POST /v1/credentials HTTP/1.1\r\nHost: localhost:${url.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{`);
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    const response = await fetch(`${server.url}/v1/credentials`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { credentials: [] });
  } finally {
    socket.destroy();
  }
});

test('并发上传不同账户不会丢失服务端索引', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home, 0, async (_url, options) => {
    const token = new Headers(options?.headers).get('Authorization')?.slice(7);
    return Response.json({ email: `${token}@example.com` });
  });
  await Promise.all(['one', 'two', 'three'].map((value) => requestService(server.url, '/v1/credentials',
    { base: null, auth: { tokens: { access_token: value } } })));
  const result = await requestService(server.url, '/v1/credentials') as { credentials: unknown[] };
  assert.equal(result.credentials.length, 3);
});

test('拒绝跨站请求、无效请求、过大内容和路径穿越，错误不包含凭证', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const origin = await fetch(`${server.url}/v1/credentials`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  for (const [body, status] of [['{', 400], [JSON.stringify({ auth: 'fake-secret' }), 400], ['x'.repeat(129 * 1024), 413]] as const) {
    const response = await fetch(`${server.url}/v1/credentials`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes('fake-secret'), false);
  }
  const wrongType = await fetch(`${server.url}/v1/credentials`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  await assert.rejects(requestService(server.url, '/v1/credentials/download', { type: 'codex', email: '../a@example.com' }), /邮箱无效/u);
});

test('服务端固定监听 127.0.0.1，不创建或读取旧授权文件', async (context) => {
  const home = await temporaryHome(context);
  const legacy = join(home, 'server-access.json');
  await writeFile(legacy, '{broken-legacy-access');
  const listen = context.mock.method(Server.prototype, 'listen');
  const server = await startServer({ home, port: 0, ...{ host: '0.0.0.0', tls: {} } });
  context.after(() => server.close());
  assert.equal(listen.mock.calls[0]?.arguments[1], '127.0.0.1');
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.deepEqual(await requestService(server.url, '/v1/health'), { service: 'codexplus', version: protocolVersion });
  assert.deepEqual(await requestService(server.url, '/v1/credentials'), { credentials: [] });
  assert.equal(await readFile(legacy, 'utf8'), '{broken-legacy-access');
});

test('独立服务端重启后仍可直接读取凭证，不需要配对', async (context) => {
  const home = await temporaryHome(context);
  const port = await freePort();
  let server = await standalone(context, home, port);
  await requestService(server.url, '/v1/credentials', { auth: { tokens: { access_token: 'saved' } }, base: null });
  await server.close();
  server = await standalone(context, home, port);
  const result = await requestService(server.url, '/v1/credentials') as { credentials: unknown[] };
  assert.equal(result.credentials.length, 1);
  assert.equal((await readdir(home)).includes('server-access.json'), false);
});

test('拒绝非本机 Host、跨站浏览器和伪造代理头，允许 localhost', async (context) => {
  const server = await standalone(context, await temporaryHome(context));
  const port = new URL(server.url).port;
  const { request } = await import('node:http');
  const status = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = request(`${server.url}/v1/credentials`, { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  for (const host of ['evil.example', `evil.example:${port}`, `192.168.1.5:${port}`]) {
    assert.equal(await status({ Host: host, 'X-Forwarded-For': '127.0.0.1' }), 403);
  }
  assert.equal(await status({ Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await status({ Host: `localhost:${port}` }), 200);
});
