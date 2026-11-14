import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { protocolVersion, requestService } from '@codexplus/shared';
import { CredentialClient } from '../src/client.js';
import { temporaryHome } from './helpers.js';

test('服务名或协议版本不匹配时只做健康检查，旧远程令牌不发送或改写', async (context) => {
  const userHome = await temporaryHome(context);
  let health = { service: 'other', version: 2, id: 'new' };
  const tokens: string[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (request.headers.authorization) tokens.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/login/info' ? { home: userHome, userHome, authPath: join(userHome, '.codex', 'auth.json') } : health));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const client = new CredentialClient({ userHome });
  await mkdir(client.home);
  await writeFile(join(client.home, 'client.json'), JSON.stringify({ version: 2, current: url, servers: { [url]: { token: 'a'.repeat(43), clientId: 'old', serverId: 'old' } }, baseline: null }));
  const before = await readFile(join(client.home, 'client.json'), 'utf8');
  const options = { port: address.port };
  await assert.rejects(client.connect(options), /不是 codexplus/u);
  health = { service: 'codexplus', version: 1, id: 'new' };
  await assert.rejects(client.connect(options), /版本不兼容/u);
  health.version = 2;
  await assert.rejects(client.connect(options), /版本不兼容/u);
  assert.equal(await readFile(join(client.home, 'client.json'), 'utf8'), before);
  health.version = protocolVersion;
  const session = await client.connect(options);
  await session.close();
  assert.deepEqual(paths, [...Array(4).fill('/v1/health'), '/v1/login/info']);
  assert.equal(await readFile(join(client.home, 'client.json'), 'utf8'), before);
  assert.deepEqual(tokens, []);
});

test('本机服务端的重定向不会被跟随，也不改写客户端配置', async (context) => {
  const userHome = await temporaryHome(context);
  const client = new CredentialClient({ userHome });
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.writeHead(302, { Location: '/redirected' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(client.connect({ port: address.port }), /无法连接/u);
  assert.deepEqual(paths, ['/v1/health']);
  await assert.rejects(readFile(join(client.home, 'client.json')), { code: 'ENOENT' });
  await assert.rejects(requestService(`http://127.0.0.1:${address.port}`, '/v1/credentials', { auth: { tokens: { access_token: 'secret' } }, base: null }), /无法连接/u);
  assert.deepEqual(paths, ['/v1/health', '/v1/credentials']);
});
