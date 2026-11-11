import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createLocalCode, localCodesPath } from '../src/local-codes.js';
import { localUrl } from '../src/protocol.js';
import { startServer } from '../src/server.js';
import { account, admin, filtered, freePort, makeClient, original, pairCode, standalone, temporaryHome } from './helpers.js';

function never(): Promise<never> {
  return Promise.reject(new Error('不应请求配对码。'));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function fakeServer(context: TestContext, port = 0, id: () => string = randomUUID) {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization) {
      authorizations.push(request.headers.authorization);
    }
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'codexplus', version: 1 }));
    } else if (request.url === '/v1/local/challenge') {
      response.end(JSON.stringify({ id: id() }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return { url: localUrl(address.port), authorizations };
}

async function relay(context: TestContext, port: number, upstream: string): Promise<string[]> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization) {
      authorizations.push(request.headers.authorization);
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void fetch(`${upstream}${request.url ?? ''}`, { method: request.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}) },
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
        .then(async (answer) => { response.statusCode = answer.status; response.end(await answer.text()); });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return authorizations;
}

test('端口空闲时自动带起本地服务端并自动配对，结束后关闭，再次运行复用授权', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, '.codexplus');
  const url = localUrl(await freePort());
  const { client, started } = makeClient(context, userHome);
  const logs: string[] = [];
  const session = await client.connect({ target: url, log: (message) => logs.push(message), askPairing: never });
  assert.deepEqual(started, [url]);
  assert.match(logs.join('\n'), /已启动本地服务端.*自动完成配对/u);
  assert.deepEqual(await session.list(), []);
  await writeFile(join(userHome, 'auth with spaces.json'), JSON.stringify(original));
  const credential = await session.add('~/auth with spaces.json');
  assert.deepEqual(credential, { type: 'codex', email: 'person@example.com' });
  assert.deepEqual(await readJson(join(home, 'credentials', 'codex-person@example.com.json')), filtered);
  await session.switch(credential);
  assert.deepEqual(await readJson(join(userHome, '.codex', 'auth.json')), filtered);
  await session.close();
  await assert.rejects(fetch(`${url}/v1/health`));

  const config = await client.config();
  assert.equal(config.current, url);
  assert.equal(config.servers[url]?.pairing, 'local');
  logs.length = 0;
  const again = await client.connect({ log: (message) => logs.push(message), askPairing: never });
  assert.deepEqual(await again.list(), [credential]);
  await again.close();
  assert.deepEqual(logs, []);
  assert.equal((await readJson(join(home, 'server-access.json')) as { clients: unknown[] }).clients.length, 1);
  assert.deepEqual(await readdir(localCodesPath(home)), []);
});

test('端口被同目录的 codexplus 服务端占用时直接连接，通过本机文件自动配对并提醒用户', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, '.codexplus');
  const server = await standalone(context, home);
  const { client, started } = makeClient(context, userHome);
  const logs: string[] = [];
  const session = await client.connect({ target: server.url, log: (message) => logs.push(message), askPairing: never });
  assert.deepEqual(started, []);
  assert.match(logs.join('\n'), new RegExp(`检测到本机已运行的 codexplus 服务端（${server.url}，目录 .+）`, 'u'));
  await session.close();
  assert.deepEqual(await (await fetch(`${server.url}/v1/health`)).json(), { service: 'codexplus', version: 1 });
  const again = await client.connect({ log: (message) => logs.push(message), askPairing: never });
  await again.close();
  assert.equal(logs.length, 1);
  assert.deepEqual(await readdir(localCodesPath(home)), []);
});

test('连接过的服务端全部保存并记住当前连接，不同目录的服务端需要手动配对', async (context) => {
  const userHome = await temporaryHome(context);
  const homeA = await temporaryHome(context);
  const homeB = await temporaryHome(context);
  const serverA = await standalone(context, homeA);
  const serverB = await standalone(context, homeB);
  const { client } = makeClient(context, userHome);
  const logs: string[] = [];
  const ask = (home: string) => async (url: string) => ({ code: await pairCode(url, home), name: '笔记本' });
  await (await client.connect({ target: serverA.url, askPairing: ask(homeA), log: (message) => logs.push(message) })).close();
  assert.match(logs.join('\n'), /无法读取.*本机配对文件/u);
  await (await client.connect({ target: serverB.url, askPairing: ask(homeB), log: () => {} })).close();
  const config = await client.config();
  assert.equal(config.current, serverB.url);
  assert.deepEqual(Object.keys(config.servers).toSorted(), [serverA.url, serverB.url].toSorted());
  assert.equal(config.servers[serverA.url]?.pairing, 'code');
  const remembered = await client.connect({ askPairing: never, log: () => {} });
  assert.equal(remembered.url, serverB.url);
  await remembered.close();
  await (await client.connect({ target: serverA.url, askPairing: never, log: () => {} })).close();
  assert.equal((await client.config()).current, serverA.url);
  const clients = await admin(serverA.url, homeA, 'clients') as { clients: { name: string }[] };
  assert.deepEqual(clients.clients.map((entry) => entry.name), ['笔记本']);
});

test('授权被撤销后提示重新配对并替换令牌，配对失败不改变客户端配置', async (context) => {
  const userHome = await temporaryHome(context);
  const serverHome = await temporaryHome(context);
  const server = await standalone(context, serverHome);
  const { client } = makeClient(context, userHome);
  await (await client.connect({ target: server.url, log: () => {},
    askPairing: async (url) => ({ code: await pairCode(url, serverHome), name: '旧' }) })).close();
  const before = await readFile(client.configPath, 'utf8');
  const old = (await client.config()).servers[server.url];
  assert.ok(old);
  await admin(server.url, serverHome, 'revoke', { id: old.clientId });
  await assert.rejects(client.connect({ target: server.url, log: () => {},
    askPairing: async () => ({ code: 'bad-code', name: '失败' }) }), /配对失败/u);
  assert.equal(await readFile(client.configPath, 'utf8'), before);
  const logs: string[] = [];
  await (await client.connect({ target: server.url, log: (message) => logs.push(message),
    askPairing: async (url) => ({ code: await pairCode(url, serverHome), name: '新' }) })).close();
  assert.match(logs.join('\n'), /已失效或已被撤销/u);
  assert.notEqual((await client.config()).servers[server.url]?.clientId, old.clientId);
});

test('本机自动配对的授权被撤销后，重新通过本机文件自动配对', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, '.codexplus');
  const server = await standalone(context, home);
  const { client } = makeClient(context, userHome);
  await (await client.connect({ target: server.url, askPairing: never, log: () => {} })).close();
  const old = (await client.config()).servers[server.url];
  assert.ok(old);
  await admin(server.url, home, 'revoke', { id: old.clientId });
  await (await client.connect({ askPairing: never, log: () => {} })).close();
  const current = (await client.config()).servers[server.url];
  assert.equal(current?.pairing, 'local');
  assert.notEqual(current.clientId, old.clientId);
});

test('端口被其他程序占用时报错，不发送令牌', async (context) => {
  const userHome = await temporaryHome(context);
  const other = createServer((request, response) => { request.resume(); response.end('<html></html>'); });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
  const address = other.address();
  assert.ok(address !== null && typeof address !== 'string');
  const { client } = makeClient(context, userHome);
  await assert.rejects(client.connect({ target: localUrl(address.port), askPairing: never, log: () => {} }), /被其他程序占用.*--port/u);
  await assert.rejects(stat(client.configPath), { code: 'ENOENT' });
});

test('冒充的本机服务端无法证明同一目录，客户端不发送已保存的令牌，也不能自动配对', async (context) => {
  const userHome = await temporaryHome(context);
  const fake = await fakeServer(context);
  const { client } = makeClient(context, userHome);
  await assert.rejects(client.connect({ target: fake.url, log: () => {} }), /需要配对码/u);
  const token = randomBytes(32).toString('base64url');
  await mkdir(client.home, { recursive: true });
  await writeFile(client.configPath, JSON.stringify({ version: 1, current: fake.url,
    servers: { [fake.url]: { token, clientId: 'id', pairing: 'local' } } }));
  await assert.rejects(client.connect({ askPairing: never, log: () => {} }), /无法证明.*未发送令牌/u);
  assert.deepEqual(fake.authorizations, []);
});

test('冒充服务端重放预先申请的验证文件也无法拿到令牌', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const stale = await createLocalCode(client.home, 'verify', randomBytes(32).toString('base64url'), '127.0.0.1:1');
  assert.ok(stale);
  const fake = await fakeServer(context, 0, () => stale);
  await writeFile(client.configPath, JSON.stringify({ version: 1, current: fake.url,
    servers: { [fake.url]: { token: randomBytes(32).toString('base64url'), clientId: 'id', pairing: 'local' } } }));
  await assert.rejects(client.connect({ askPairing: never, log: () => {} }), /无法证明.*未发送令牌/u);
  assert.deepEqual(fake.authorizations, []);
});

test('冒充者把验证请求转发给同目录、不同端口的服务端时，端口不匹配，令牌不会发出', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, '.codexplus');
  const port = await freePort();
  const first = await standalone(context, home, port);
  const { client } = makeClient(context, userHome);
  await (await client.connect({ target: first.url, askPairing: never, log: () => {} })).close();
  await first.close();
  const other = await standalone(context, home);
  const authorizations = await relay(context, port, other.url);
  await assert.rejects(client.connect({ askPairing: never, log: () => {} }), /无法证明.*未发送令牌/u);
  assert.deepEqual(authorizations, []);
});

test('冒充者把验证请求转发给同目录、同端口但不同回环地址的服务端时，地址不匹配，令牌不会发出', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, '.codexplus');
  const port = await freePort();
  const first = await standalone(context, home, port);
  const { client } = makeClient(context, userHome);
  await (await client.connect({ target: first.url, askPairing: never, log: () => {} })).close();
  await first.close();
  let ipv6: Awaited<ReturnType<typeof startServer>>;
  try {
    ipv6 = await startServer({ home, host: '::1', port, accountRequest: account });
  } catch {
    context.skip('本机不支持 IPv6 回环地址。');
    return;
  }
  context.after(() => ipv6.close());
  const authorizations = await relay(context, port, ipv6.url);
  await assert.rejects(client.connect({ askPairing: never, log: () => {} }), /无法证明.*未发送令牌/u);
  assert.deepEqual(authorizations, []);
});

test('会话期间服务端被替换时，下一次请求前重新验证，不把令牌发给冒充者', async (context) => {
  const userHome = await temporaryHome(context);
  const port = await freePort();
  const server = await standalone(context, join(userHome, '.codexplus'), port);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ target: server.url, askPairing: never, log: () => {} });
  assert.deepEqual(await session.list(), []);
  await server.close();
  const fake = await fakeServer(context, port);
  await session.list().catch(() => {});
  await assert.rejects(session.list(), /无法证明.*未发送令牌/u);
  assert.deepEqual(fake.authorizations, []);
});

test('自定义 HOME 时本地服务端写入客户端指定目录，~/ 输入与切换目标仍使用用户主目录', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, 'custom home');
  const { client } = makeClient(context, userHome, home);
  const session = await client.connect({ target: localUrl(await freePort()), askPairing: never, log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const credential = await session.add('~/input.json');
  await session.switch(credential);
  await session.close();
  assert.deepEqual(await readJson(join(home, 'config.json')), { version: 1, credentials: [credential] });
  assert.equal(client.configPath, join(home, 'client.json'));
  assert.deepEqual(await readJson(join(userHome, '.codex', 'auth.json')), filtered);
  await assert.rejects(stat(join(userHome, '.codexplus')), { code: 'ENOENT' });
});

test('损坏的客户端配置不会被覆盖，也不会连接服务端', async (context) => {
  const userHome = await temporaryHome(context);
  const { client, started } = makeClient(context, userHome);
  await mkdir(client.home, { recursive: true });
  await writeFile(client.configPath, '{broken');
  await assert.rejects(client.connect({ target: localUrl(await freePort()), askPairing: never, log: () => {} }), /格式无效.*未被覆盖/u);
  assert.equal(await readFile(client.configPath, 'utf8'), '{broken');
  assert.deepEqual(started, []);
});

test('服务端凭证损坏、选项不存在或本地输入无效时，不覆盖客户端当前登录', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ target: localUrl(await freePort()), askPairing: never, log: () => {} });
  context.after(() => session.close());
  await assert.rejects(session.add(''), /文件路径/u);
  await assert.rejects(session.add(join(userHome, 'missing.json')), { code: 'ENOENT' });
  await writeFile(join(userHome, 'invalid.json'), '{"OPENAI_API_KEY":"fake-secret"}');
  await assert.rejects(session.add(join(userHome, 'invalid.json')), /access_token/u);
  assert.deepEqual(await session.list(), []);
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const credential = await session.add(join(userHome, 'input.json'));
  await session.switch(credential);
  const before = await readFile(session.codexAuthPath, 'utf8');
  await assert.rejects(session.switch({ type: 'codex', email: 'missing@example.com' }), /未找到/u);
  await writeFile(join(client.home, 'credentials', 'codex-person@example.com.json'), '{"tokens":{}}');
  await assert.rejects(session.switch(credential), /access_token/u);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), before);
});

test('Unix 上客户端和服务端的敏感文件权限为 0600，目录为 0700', { skip: process.platform === 'win32' }, async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ target: localUrl(await freePort()), askPairing: never, log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  await session.switch(await session.add(join(userHome, 'input.json')));
  await session.close();
  for (const path of [client.configPath, join(client.home, 'server-access.json'), join(client.home, 'config.json'),
    join(client.home, 'credentials', 'codex-person@example.com.json'), client.codexAuthPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  for (const path of [client.home, localCodesPath(client.home), join(userHome, '.codex')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
});

function idToken(email: string): string {
  return `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`;
}

test('识别当前登录：与服务端快照一致、仅邮箱一致（有更新）、未保存和未登录，不下载凭证', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ target: localUrl(await freePort()), askPairing: never, log: () => {} });
  context.after(() => session.close());
  assert.deepEqual(await session.current(), { status: 'none' });
  const source = join(userHome, 'input.json');
  await writeFile(source, JSON.stringify({ ...original, tokens: { ...original.tokens, id_token: idToken('person@example.com') } }));
  await session.add(source);
  await mkdir(join(userHome, '.codex'), { recursive: true });
  await writeFile(session.codexAuthPath, await readFile(source, 'utf8'));
  assert.deepEqual(await session.current(), { status: 'saved', email: 'person@example.com' });
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'refreshed', id_token: idToken('person@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'stale', email: 'person@example.com' });
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'other', id_token: idToken('other@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'unsaved', email: 'other@example.com' });
  await writeFile(session.codexAuthPath, '{"tokens":{"access_token":"x","id_token":"not-a-jwt"}}');
  assert.deepEqual(await session.current(), { status: 'unsaved', email: null });
  const snapshot = join(client.home, 'credentials', 'codex-person@example.com.json');
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'b', id_token: idToken('person@example.com') } }));
  await rm(snapshot);
  assert.deepEqual(await session.current(), { status: 'unsaved', email: 'person@example.com' });
  await mkdir(snapshot);
  assert.deepEqual(await session.current(), { status: 'unsaved', email: 'person@example.com' });
});

test('其他客户端更新同一账号后，当前登录状态立即变为有更新未保存', async (context) => {
  const userHome = await temporaryHome(context);
  const server = await standalone(context, join(userHome, '.codexplus'));
  const { client } = makeClient(context, userHome);
  const first = await client.connect({ target: server.url, askPairing: never, log: () => {} });
  const second = await client.connect({ askPairing: never, log: () => {} });
  context.after(async () => { await first.close(); await second.close(); });
  const login = JSON.stringify({ tokens: { access_token: 'v1', id_token: idToken('person@example.com') } });
  await writeFile(join(userHome, 'v1.json'), login);
  await first.add(join(userHome, 'v1.json'));
  await mkdir(join(userHome, '.codex'), { recursive: true });
  await writeFile(first.codexAuthPath, login);
  await first.list();
  assert.deepEqual(await first.current(), { status: 'saved', email: 'person@example.com' });
  await writeFile(join(userHome, 'v2.json'), JSON.stringify({ tokens: { access_token: 'v2', id_token: idToken('person@example.com') } }));
  await second.add(join(userHome, 'v2.json'));
  assert.deepEqual(await first.current(), { status: 'stale', email: 'person@example.com' });
});
