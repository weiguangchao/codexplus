import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { UploadCancelled } from '../src/client.js';
import { admin, filtered, makeClient, original, pairCode, standalone, temporaryHome } from './helpers.js';

function never(): Promise<never> { return Promise.reject(new Error('不应请求配对码。')); }

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('两个本机客户端使用独立端口，退出一个不影响另一个', async (context) => {
  const userHome = await temporaryHome(context);
  const { client, started } = makeClient(context, userHome);
  const first = await client.connect();
  const second = await client.connect();
  context.after(() => second.close());
  assert.equal(started.length, 2);
  assert.notEqual(first.url, second.url);
  await first.close();
  assert.deepEqual(await second.list(), []);
  assert.equal((await client.config()).current, 'local');
  assert.deepEqual((await client.config()).servers, {});
  const access = JSON.parse(await readFile(join(client.home, 'server-access.json'), 'utf8')) as { clients: unknown[] };
  assert.equal(access.clients.length, 0);
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

  await (await client.connect({ target: serverB.url, askPairing: ask(homeB), log: () => {} })).close();
  const config = await client.config();
  assert.equal(config.current, serverB.url);
  assert.deepEqual(Object.keys(config.servers).toSorted(), [serverA.url, serverB.url].toSorted());
  assert.ok(config.servers[serverA.url]?.token);
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

test('自定义 HOME 时本地服务端写入客户端指定目录，~/ 输入与切换目标仍使用用户主目录', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, 'custom home');
  const { client } = makeClient(context, userHome, home);
  const session = await client.connect({ target: 'local', askPairing: never, log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const { credential } = await session.add('~/input.json');
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
  await assert.rejects(client.connect({ target: 'local', askPairing: never, log: () => {} }), /格式无效.*未被覆盖/u);
  assert.equal(await readFile(client.configPath, 'utf8'), '{broken');
  assert.deepEqual(started, []);
});

test('服务端凭证损坏、选项不存在或本地输入无效时，不覆盖客户端当前登录', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ target: 'local', askPairing: never, log: () => {} });
  context.after(() => session.close());
  await assert.rejects(session.add(''), /文件路径/u);
  await assert.rejects(session.add(join(userHome, 'missing.json')), { code: 'ENOENT' });
  await writeFile(join(userHome, 'invalid.json'), '{"OPENAI_API_KEY":"fake-secret"}');
  await assert.rejects(session.add(join(userHome, 'invalid.json')), /access_token/u);
  assert.deepEqual(await session.list(), []);
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const { credential } = await session.add(join(userHome, 'input.json'));
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
  const session = await client.connect({ target: 'local', askPairing: never, log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  await session.switch((await session.add(join(userHome, 'input.json'))).credential);
  await session.close();
  for (const path of [client.configPath, join(client.home, 'config.json'),
    join(client.home, 'credentials', 'codex-person@example.com.json'), client.codexAuthPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  for (const path of [client.home, join(userHome, '.codex')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
});

function idToken(email: string): string {
  return `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`;
}

test('识别当前登录：与服务端快照一致、仅邮箱一致且没有基线（不一致）、未保存和未登录，不下载凭证', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ target: 'local', askPairing: never, log: () => {} });
  context.after(() => session.close());
  assert.deepEqual(await session.current(), { status: 'none' });
  const source = join(userHome, 'input.json');
  await writeFile(source, JSON.stringify({ ...original, tokens: { ...original.tokens, id_token: idToken('person@example.com') } }));
  await session.add(source);
  await mkdir(join(userHome, '.codex'), { recursive: true });
  await writeFile(session.codexAuthPath, await readFile(source, 'utf8'));
  assert.deepEqual(await session.current(), { status: 'saved', email: 'person@example.com' });
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'refreshed', id_token: idToken('person@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'diverged', email: 'person@example.com' });
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { id_token: idToken('person@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'diverged', email: 'person@example.com' });
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

test('其他客户端更新同一账号后，当前登录状态立即变为服务端有更新版本', async (context) => {
  const userHome = await temporaryHome(context);
  const server = await standalone(context, join(userHome, '.codexplus'));
  const { client } = makeClient(context, userHome);
  const first = await client.connect({ target: server.url, askPairing: async () => ({ code: await pairCode(server.url, join(userHome, '.codexplus')), name: '测试' }), log: () => {} });
  const second = await client.connect({ askPairing: never, log: () => {} });
  context.after(async () => { await first.close(); await second.close(); });
  const login = JSON.stringify({ tokens: { access_token: 'v1', id_token: idToken('person@example.com') }, last_refresh: '2026-11-01T00:00:00Z' });
  await writeFile(join(userHome, 'v1.json'), login);
  await first.add(join(userHome, 'v1.json'));
  await mkdir(join(userHome, '.codex'), { recursive: true });
  await writeFile(first.codexAuthPath, login);
  await first.list();
  assert.deepEqual(await first.current(), { status: 'saved', email: 'person@example.com' });
  await writeFile(join(userHome, 'v2.json'), JSON.stringify({ tokens: { access_token: 'v2', id_token: idToken('person@example.com') }, last_refresh: '2026-11-10T00:00:00Z' }));
  await first.switch({ type: 'codex', email: 'person@example.com' });
  second.confirmUpload = async () => true;
  await second.add(join(userHome, 'v2.json'));
  assert.deepEqual(await first.current(), { status: 'behind', email: 'person@example.com' });
});

test('手动配对的回环服务端离线不启动空库，恢复后保留授权', async (context) => {
  const userHome = await temporaryHome(context);
  const serverHome = await temporaryHome(context);
  const server = await standalone(context, serverHome);
  const url = server.url;
  const { client, started } = makeClient(context, userHome);
  await (await client.connect({ target: url, askPairing: async () => ({ code: await pairCode(url, serverHome), name: '测试' }) })).close();
  const before = await readFile(client.configPath, 'utf8');
  await server.close();
  await assert.rejects(client.connect(), /无法连接/u);
  assert.equal(await readFile(client.configPath, 'utf8'), before);
  assert.deepEqual(started, []);
  await standalone(context, serverHome, Number(new URL(url).port));
  await (await client.connect({ askPairing: never })).close();
});

test('版本一迁移丢弃自动配对，保留手动配对和相应基线', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  await mkdir(client.home);
  const token = 'a'.repeat(43);
  const local = 'http://127.0.0.1:47831';
  const remote = 'https://example.com';
  for (const current of [local, 'http://localhost:1234', remote]) {
    await writeFile(client.configPath, JSON.stringify({ version: 1, current, servers: {
      [local]: { token, clientId: 'old', pairing: 'local' }, [remote]: { token, clientId: 'keep', pairing: 'code' },
    }, baseline: { server: local, email: 'person@example.com', digest: 'old' } }));
    const config = await client.config();
    assert.equal(config.version, 2);
    assert.equal(config.current, current === remote ? remote : 'local');
    assert.deepEqual(Object.keys(config.servers), [remote]);
    assert.equal(config.baseline, null);
  }
});

test('同地址换库先确认实例，不发送旧令牌，确认后重新配对', async (context) => {
  const userHome = await temporaryHome(context);
  const firstHome = await temporaryHome(context);
  const nextHome = await temporaryHome(context);
  const first = await standalone(context, firstHome);
  const { client } = makeClient(context, userHome);
  await (await client.connect({ target: first.url, askPairing: async () => ({ code: await pairCode(first.url, firstHome), name: '旧' }) })).close();
  const before = await readFile(client.configPath, 'utf8');
  await first.close();
  const next = await standalone(context, nextHome, Number(new URL(first.url).port));
  await assert.rejects(client.connect(), /不是之前配对/u);
  assert.equal(await readFile(client.configPath, 'utf8'), before);
  await assert.rejects(client.connect({ askRepair: async () => false }), /不是之前配对/u);
  assert.equal(await readFile(client.configPath, 'utf8'), before);
  await (await client.connect({ askRepair: async () => true, askPairing: async () => ({ code: await pairCode(next.url, nextHome), name: '新' }) })).close();
  assert.notEqual((await client.config()).servers[next.url]?.serverId, JSON.parse(before).servers[next.url].serverId);
  assert.equal((await client.config()).baseline, null);
});

test('基线区分本机领先、服务端领先和分歧，旧快照必须确认才能覆盖', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect();
  context.after(() => session.close());
  const email = 'person@example.com';
  const auth = (access: string) => JSON.stringify({ tokens: { access_token: access, id_token: idToken(email) }, last_refresh: `2026-11-0${access.slice(1)}T00:00:00Z` });
  const source = join(userHome, 'source.json');
  await writeFile(source, auth('v1'));
  const { credential } = await session.add(source);
  await session.switch(credential);
  await writeFile(session.codexAuthPath, auth('v2'));
  assert.equal((await session.current()).status, 'ahead');
  await session.add(session.codexAuthPath);
  await writeFile(source, auth('v3'));
  let confirmations = 0;
  session.confirmUpload = async (details) => { confirmations++; assert.equal(details.code, 'conflict'); return true; };
  await session.add(source);
  assert.equal(confirmations, 1);
  assert.equal((await session.current()).status, 'behind');
  session.confirmUpload = async () => false;
  await assert.rejects(session.add(session.codexAuthPath), UploadCancelled);
  await session.switch(credential);
  assert.equal(JSON.parse(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'v3');
  await client.setBaseline(null);
  await writeFile(session.codexAuthPath, auth('v4'));
  assert.equal((await session.current()).status, 'diverged');
});

test('确认期间再次上传产生新冲突时再次询问，不使用强制覆盖', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect();
  context.after(() => session.close());
  const source = join(userHome, 'upload.json');
  const rival = join(userHome, 'rival.json');
  await writeFile(source, '{"tokens":{"access_token":"v1"}}');
  await session.add(source);
  await writeFile(source, '{"tokens":{"access_token":"v2"}}');
  let asked = 0;
  session.confirmUpload = async () => {
    asked++;
    if (asked === 1) {
      const other = await client.connect();
      try {
        await writeFile(rival, '{"tokens":{"access_token":"v3"}}');
        other.confirmUpload = async () => true;
        await other.add(rival);
      } finally { await other.close(); }
    }
    return true;
  };
  await session.add(source);
  assert.equal(asked, 2);
});
