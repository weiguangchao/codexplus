import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccessStore } from '../src/access.js';
import { requestService, serverUrl } from '../src/protocol.js';
import { runAdmin } from '../src/serve.js';
import { admin, freePort, pairCode, standalone, temporaryHome } from './helpers.js';

test('废弃本机和管理接口不创建任何文件', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const before = await readdir(home);
  for (const path of ['/v1/local/challenge', '/v1/admin/pair']) {
    const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok([401, 404].includes(response.status));
  }
  assert.deepEqual(await readdir(home), before);
});

test('管理命令输出配对码、客户端列表和撤销结果，服务端未运行时报错', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  await runAdmin({ kind: 'admin', home, action: 'clients' }, log);
  await runAdmin({ kind: 'admin', home, action: 'pair' }, log);
  assert.match(logs.join('\n'), /暂无已配对客户端[\s\S]*配对码：[A-Za-z0-9_-]{22}/u);
  const { client } = await new AccessStore(home).addClient('笔记本');
  await runAdmin({ kind: 'admin', home, action: 'revoke', id: client.id }, log);
  assert.match(logs.at(-1) ?? '', /已撤销/u);
  await assert.rejects(runAdmin({ kind: 'admin', home, action: 'revoke', id: client.id }, log), /未找到/u);
  await server.close();
  await runAdmin({ kind: 'admin', home, action: 'pair' }, log);
});

test('服务端每次都从磁盘读取授权，其他进程或手工修改立即生效', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const { token } = await new AccessStore(home).addClient('外部写入');
  assert.deepEqual(await requestService(server.url, '/v1/credentials', token), { credentials: [] });
  const path = join(home, 'server-access.json');
  const state = JSON.parse(await readFile(path, 'utf8')) as { clients: unknown[] };
  await writeFile(path, JSON.stringify({ ...state, clients: [] }));
  await assert.rejects(requestService(server.url, '/v1/credentials', token), /未获授权或授权已被撤销/u);
  const first = new AccessStore(home);
  const second = new AccessStore(home);
  const paired = await first.addClient('一');
  await second.addClient('二');
  assert.equal((await first.list()).length, 2);
  assert.ok(await second.authorize(paired.token));
  await writeFile(path, '{broken');
  await assert.rejects(requestService(server.url, '/v1/credentials', token), /服务端操作失败/u);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('配对码只能使用一次，生成新码废弃旧码，并发兑换只有一次成功', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const pair = (code: string, name: string) => requestService(server.url, '/v1/pair', undefined, { code, name });
  const old = await pairCode(server.url, home);
  const current = await pairCode(server.url, home);
  await assert.rejects(pair(old, '旧码'), /配对失败/u);
  const results = await Promise.allSettled([pair(current, '客户端一'), pair(current, '客户端二')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  await assert.rejects(pair(current, '重放'), /配对失败/u);
});

test('过期配对码无效，服务端不保存明文配对码和客户端令牌', async (context) => {
  const home = await temporaryHome(context);
  let now = Date.now();
  const access = new AccessStore(home, () => now);
  const expired = await access.createPair();
  now += 5 * 60_000;
  await assert.rejects(access.redeem(expired.code, '过期'), /已过期/u);
  const pair = await access.createPair();
  const paired = await access.redeem(pair.code, '有效');
  const content = await readFile(access.path, 'utf8');
  assert.equal(content.includes(pair.code), false);
  assert.equal(content.includes(paired.token), false);
  assert.deepEqual(await access.authorize(paired.token), { ...paired.client, lastSeenAt: new Date(now).toISOString() });
  assert.equal(await access.authorize('fake-token'), null);
});

test('服务端重启后配对授权仍有效，撤销结果也会持久保存', async (context) => {
  const home = await temporaryHome(context);
  const port = await freePort();
  let server = await standalone(context, home, port);
  const { token, client } = await requestService(server.url, '/v1/pair', undefined,
    { code: await pairCode(server.url, home), name: '重启测试' }) as { token: string; client: { id: string } };
  await server.close();
  server = await standalone(context, home, port);
  const session = await requestService(server.url, '/v1/session', token) as { client: { id: string; lastSeenAt: string } };
  assert.equal(session.client.id, client.id);
  assert.ok(session.client.lastSeenAt);
  await admin(server.url, home, 'revoke', { id: client.id });
  await server.close();
  server = await standalone(context, home, port);
  await assert.rejects(requestService(server.url, '/v1/credentials', token), /已被撤销/u);
});

test('未完成的匿名配对请求不会阻塞其他客户端操作', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const { token } = await new AccessStore(home).addClient('客户端');
  const url = new URL(server.url);
  const socket = connect(Number(url.port), url.hostname);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', resolve);
    });
    socket.write('POST /v1/pair HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{');
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    const response = await fetch(`${server.url}/v1/credentials`, {
      headers: { Authorization: `Bearer ${token}` },
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
  const { token } = await new AccessStore(home).addClient('客户端');
  await Promise.all(['one', 'two', 'three'].map((value) => requestService(server.url, '/v1/credentials', token,
    { base: null, auth: { tokens: { access_token: value } } })));
  const result = await requestService(server.url, '/v1/credentials', token) as { credentials: unknown[] };
  assert.equal(result.credentials.length, 3);
});

test('拒绝跨站请求、无效请求、过大内容和路径穿越，错误不包含凭证', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const { token } = await new AccessStore(home).addClient('客户端');
  const origin = await fetch(`${server.url}/v1/credentials`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  for (const [body, status] of [['{', 400], [JSON.stringify({ auth: 'fake-secret' }), 400], ['x'.repeat(129 * 1024), 413]] as const) {
    const response = await fetch(`${server.url}/v1/credentials`, { method: 'POST', body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes('fake-secret'), false);
  }
  const wrongType = await fetch(`${server.url}/v1/pair`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  await assert.rejects(requestService(server.url, '/v1/credentials/download', token, { type: 'codex', email: '../a@example.com' }), /邮箱无效/u);
});

test('远程明文连接和带密码或路径的地址被拒绝，管理命令只能连本机地址', () => {
  assert.equal(serverUrl('https://server.example/'), 'https://server.example');
  assert.equal(serverUrl('http://127.0.0.1:47831', true), 'http://127.0.0.1:47831');
  for (const url of ['http://192.168.1.5:47831', 'https://user:secret@server.example', 'https://server.example/path', 'file:///tmp/file', 'https://server.example/?token=secret']) {
    assert.throws(() => serverUrl(url), /地址|HTTPS/u);
  }
  assert.throws(() => serverUrl('https://192.168.1.5', true), /仅限本机/u);
});
