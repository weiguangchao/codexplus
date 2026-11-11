import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AccessStore, localKeyPath } from '../src/access.js';
import { CredentialClient } from '../src/client.js';
import { parseHome } from '../src/options.js';
import { requestService, serverUrl } from '../src/protocol.js';
import { startServer } from '../src/server.js';

const original = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', extra: 'discard' }, extra: 'discard' };
const filtered = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh' } };

async function temporaryHome(context: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-cs-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function fixture(context: TestContext) {
  const serverHome = await temporaryHome(context);
  const clientHome = await temporaryHome(context);
  const server = await startServer({ home: join(serverHome, '.codexplus'), port: 0,
    accountRequest: async () => Response.json({ email: 'person@example.com' }) });
  context.after(() => server.close());
  const key = await readFile(localKeyPath(join(serverHome, '.codexplus')), 'utf8');
  const admin = (path: string, body?: unknown) => requestService(server.url, `/v1/admin/${path}`, key, body);
  const local = new CredentialClient({ userHome: serverHome });
  await local.useLocal(server.url);
  const remote = new CredentialClient({ userHome: clientHome });
  async function pair() {
    const result = await admin('pair', {}) as { code: string };
    await remote.pair(server.url, result.code, '测试客户端');
  }
  return { serverHome, clientHome, server, key, admin, local, remote, pair };
}

test('同机自动认证免配对，凭证只保存到服务端，切换只写入客户端', async (context) => {
  const { serverHome, clientHome, server, local, remote, pair } = await fixture(context);
  assert.deepEqual(await local.list(), []);
  const source = join(serverHome, 'auth with spaces.json');
  await writeFile(source, JSON.stringify(original));
  const credential = await local.add('~/auth with spaces.json');
  assert.deepEqual(credential, { type: 'codex', email: 'person@example.com' });
  await assert.rejects(stat(join(serverHome, '.codex')), { code: 'ENOENT' });
  await pair();
  const restartedClient = new CredentialClient({ userHome: clientHome });
  assert.deepEqual(await restartedClient.list(), [credential]);
  await restartedClient.switch(credential);
  assert.deepEqual(JSON.parse(await readFile(restartedClient.codexAuthPath, 'utf8')), filtered);
  await assert.rejects(stat(join(clientHome, '.codexplus', 'credentials')), { code: 'ENOENT' });
  await assert.rejects(stat(join(clientHome, '.codexplus', 'config.json')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), original);
  const upload = join(clientHome, 'upload.json');
  await writeFile(upload, JSON.stringify(original));
  await remote.add(upload);
  assert.equal((await local.list()).length, 1);
  assert.equal((await remote.connection()).url, server.url);
});

test('自定义 HOME 分开保存服务端和客户端数据，~/ 输入与切换目标仍使用各自用户主目录', async (context) => {
  const serverHome = await temporaryHome(context);
  const clientHome = await temporaryHome(context);
  const home = parseHome(['--home', join(serverHome, 'custom vault')]);
  const server = await startServer({ home, port: 0,
    accountRequest: async () => Response.json({ email: 'person@example.com' }) });
  context.after(() => server.close());
  const local = new CredentialClient({ home, userHome: serverHome });
  await local.useLocal(server.url);
  await writeFile(join(serverHome, 'input.json'), JSON.stringify(original));
  const credential = await local.add('~/input.json');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { version: 1, credentials: [credential] });
  const key = await readFile(localKeyPath(home), 'utf8');
  const pair = await requestService(server.url, '/v1/admin/pair', key, {}) as { code: string };
  const clientConfig = join(clientHome, 'custom client');
  const remote = new CredentialClient({ home: clientConfig, userHome: clientHome });
  await remote.pair(server.url, pair.code, '自定义 HOME');
  const reopened = new CredentialClient({ home: clientConfig, userHome: clientHome });
  assert.deepEqual(await reopened.list(), [credential]);
  await reopened.switch(credential);
  assert.equal(reopened.codexAuthPath, join(clientHome, '.codex', 'auth.json'));
  assert.deepEqual(JSON.parse(await readFile(reopened.codexAuthPath, 'utf8')), filtered);
  await assert.rejects(stat(join(clientHome, '.codexplus')), { code: 'ENOENT' });
  await assert.rejects(stat(join(serverHome, '.codex')), { code: 'ENOENT' });
  await writeFile(join(home, 'config.json'), '{broken');
  await assert.rejects(reopened.list(), /服务端操作失败/u);
});

test('回环连接也不能匿名访问，客户端令牌不能生成配对码或撤销授权', async (context) => {
  const { server, admin, remote, pair } = await fixture(context);
  await assert.rejects(requestService(server.url, '/v1/credentials'), /未获授权/u);
  await assert.rejects(requestService(server.url, '/v1/credentials', 'fake-token'), /未获授权/u);
  await assert.rejects(remote.list(), /先以同一用户运行|先配对/u);
  await pair();
  const connection = await remote.connection();
  assert.equal(connection.mode, 'remote');
  if (connection.mode !== 'remote') {
    assert.fail();
  }
  for (const path of ['pair', 'revoke']) {
    await assert.rejects(requestService(server.url, `/v1/admin/${path}`, connection.token, {}), /不能管理/u);
  }
  const result = await admin('clients') as { clients: { id: string; name: string }[] };
  assert.equal(result.clients[0]?.name, '测试客户端');
  assert.equal('digest' in (result.clients[0] ?? {}), false);
});

test('未完成的匿名配对请求不会阻塞其他客户端操作', async (context) => {
  const { server, key } = await fixture(context);
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
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { credentials: [] });
  } finally {
    socket.destroy();
  }
});

test('配对码只能使用一次，生成新码废弃旧码，并发兑换只有一次成功', async (context) => {
  const { admin, server, remote } = await fixture(context);
  const old = await admin('pair', {}) as { code: string };
  const current = await admin('pair', {}) as { code: string };
  await assert.rejects(remote.pair(server.url, old.code, '旧码'), /配对失败/u);
  const results = await Promise.allSettled([
    remote.pair(server.url, current.code, '客户端一'),
    requestService(server.url, '/v1/pair', undefined, { code: current.code, name: '客户端二' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await assert.rejects(remote.pair(server.url, current.code, '重放'), /配对失败/u);
});

test('撤销后已配对客户端无法读取、上传或切换，本地当前登录保持不变', async (context) => {
  const { admin, remote, local, clientHome, pair } = await fixture(context);
  await pair();
  const source = join(clientHome, 'input.json');
  await writeFile(source, JSON.stringify(original));
  const credential = await remote.add(source);
  await remote.switch(credential);
  const before = await readFile(remote.codexAuthPath, 'utf8');
  const connection = await remote.connection();
  assert.ok(connection.mode === 'remote');
  await admin('revoke', { id: connection.clientId });
  await assert.rejects(remote.list(), /已被撤销/u);
  await assert.rejects(remote.add(source), /已被撤销/u);
  await assert.rejects(remote.switch(credential), /已被撤销/u);
  assert.equal(await readFile(remote.codexAuthPath, 'utf8'), before);
  assert.deepEqual(await local.list(), [credential]);
});

test('服务端凭证损坏或选项不存在时，不覆盖客户端当前登录', async (context) => {
  const { serverHome, clientHome, remote, pair } = await fixture(context);
  await pair();
  const source = join(clientHome, 'input.json');
  await writeFile(source, JSON.stringify(original));
  const credential = await remote.add(source);
  await remote.switch(credential);
  const before = await readFile(remote.codexAuthPath, 'utf8');
  await assert.rejects(remote.switch({ type: 'codex', email: 'missing@example.com' }), /未找到/u);
  await writeFile(join(serverHome, '.codexplus', 'credentials', 'codex-person@example.com.json'), '{"tokens":{}}');
  await assert.rejects(remote.switch(credential), /access_token/u);
  assert.equal(await readFile(remote.codexAuthPath, 'utf8'), before);
});

test('配对失败保留原连接，损坏的客户端配置可以通过本地免配对修复', async (context) => {
  const { local, remote, server, pair } = await fixture(context);
  await pair();
  const before = await readFile(remote.configPath, 'utf8');
  await assert.rejects(remote.pair(server.url, 'bad-code', '失败'), /配对失败/u);
  assert.equal(await readFile(remote.configPath, 'utf8'), before);
  await writeFile(local.configPath, '{broken');
  await assert.rejects(local.list(), /配置格式无效/u);
  await local.useLocal(server.url);
  assert.deepEqual(await local.list(), []);
  const connection = await local.connection();
  assert.equal(connection.mode, 'local');
  assert.equal('token' in connection, false);
});

test('服务端重启后配对授权仍有效，撤销结果也会持久保存', async (context) => {
  const home = await temporaryHome(context);
  const clientHome = await temporaryHome(context);
  let server = await startServer({ home: join(home, '.codexplus'), port: 0 });
  context.after(() => server.close());
  const url = server.url;
  const port = Number(new URL(url).port);
  const key = await readFile(localKeyPath(join(home, '.codexplus')), 'utf8');
  const pair = await requestService(url, '/v1/admin/pair', key, {}) as { code: string };
  const remote = new CredentialClient({ userHome: clientHome });
  await remote.pair(url, pair.code, '重启测试');
  await server.close();
  server = await startServer({ home: join(home, '.codexplus'), port });
  assert.deepEqual(await remote.list(), []);
  const connection = await remote.connection();
  assert.ok(connection.mode === 'remote');
  await requestService(url, '/v1/admin/revoke', key, { id: connection.clientId });
  await server.close();
  server = await startServer({ home: join(home, '.codexplus'), port });
  await assert.rejects(remote.list(), /已被撤销/u);
});

test('过期配对码无效，服务端不保存明文配对码和客户端令牌', async (context) => {
  const home = await temporaryHome(context);
  let now = Date.now();
  const access = new AccessStore(join(home, '.codexplus'), () => now);
  await access.initialize();
  const expired = await access.createPair();
  now += 5 * 60_000;
  await assert.rejects(access.redeem(expired.code, '过期'), /已过期/u);
  const pair = await access.createPair();
  const paired = await access.redeem(pair.code, '有效');
  const content = await readFile(access.path, 'utf8');
  assert.equal(content.includes(pair.code), false);
  assert.equal(content.includes(paired.token), false);
  const key = await readFile(localKeyPath(join(home, '.codexplus')), 'utf8');
  assert.equal(access.authorize(key, true), 'local');
  assert.equal(access.authorize(key, false), null);
  assert.equal(access.authorize(paired.token, false), 'client');
});

test('并发上传不同账户不会丢失服务端索引', async (context) => {
  const home = await temporaryHome(context);
  const server = await startServer({ home: join(home, '.codexplus'), port: 0, accountRequest: async (_url, options) => {
    const token = new Headers(options?.headers).get('Authorization')?.slice(7);
    return Response.json({ email: `${token}@example.com` });
  } });
  context.after(() => server.close());
  const key = await readFile(localKeyPath(join(home, '.codexplus')), 'utf8');
  await Promise.all(['one', 'two', 'three'].map((token) => requestService(server.url, '/v1/credentials', key,
    { auth: { tokens: { access_token: token } } })));
  const result = await requestService(server.url, '/v1/credentials', key) as { credentials: unknown[] };
  assert.equal(result.credentials.length, 3);
});

test('拒绝跨站请求、无效请求、过大内容和路径穿越，错误不包含凭证', async (context) => {
  const { server, key } = await fixture(context);
  const origin = await fetch(`${server.url}/v1/credentials`, { headers: { Authorization: `Bearer ${key}`, Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  for (const [body, status] of [['{', 400], [JSON.stringify({ auth: 'fake-secret' }), 400], ['x'.repeat(129 * 1024), 413]] as const) {
    const response = await fetch(`${server.url}/v1/credentials`, { method: 'POST', body,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes('fake-secret'), false);
  }
  const wrongType = await fetch(`${server.url}/v1/pair`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  await assert.rejects(requestService(server.url, '/v1/credentials/download', key, { type: 'codex', email: '../a@example.com' }), /邮箱无效/u);
});

test('远程明文连接和带密码或路径的地址被拒绝，本地模式不能连局域网地址', () => {
  assert.equal(serverUrl('https://server.example/'), 'https://server.example');
  assert.equal(serverUrl('http://127.0.0.1:47831', true), 'http://127.0.0.1:47831');
  for (const url of ['http://192.168.1.5:47831', 'https://user:secret@server.example', 'https://server.example/path', 'file:///tmp/file', 'https://server.example/?token=secret']) {
    assert.throws(() => serverUrl(url), /地址|HTTPS/u);
  }
  assert.throws(() => serverUrl('https://192.168.1.5', true), /跨机器/u);
});

test('缺失或损坏的本地输入不触网、不改变连接配置或当前登录', async (context) => {
  const home = await temporaryHome(context);
  const client = new CredentialClient({ userHome: home });
  await assert.rejects(client.add(''), /文件路径/u);
  await assert.rejects(client.add(join(home, 'missing.json')), { code: 'ENOENT' });
  const source = join(home, 'invalid.json');
  await writeFile(source, '{"OPENAI_API_KEY":"fake-secret"}');
  await assert.rejects(client.add(source), /access_token/u);
  await assert.rejects(stat(client.configPath), { code: 'ENOENT' });
  await assert.rejects(stat(client.codexAuthPath), { code: 'ENOENT' });
});

test('Unix 上客户端和服务端的敏感文件权限为 0600', { skip: process.platform === 'win32' }, async (context) => {
  const { serverHome, clientHome, local, remote, pair } = await fixture(context);
  await pair();
  const source = join(clientHome, 'input.json');
  await writeFile(source, JSON.stringify(original));
  const credential = await remote.add(source);
  await remote.switch(credential);
  for (const path of [localKeyPath(join(serverHome, '.codexplus')), join(serverHome, '.codexplus', 'server-access.json'),
    local.configPath, remote.configPath, remote.codexAuthPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  for (const path of [join(serverHome, '.codexplus'), join(clientHome, '.codexplus'), join(clientHome, '.codex')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
});
