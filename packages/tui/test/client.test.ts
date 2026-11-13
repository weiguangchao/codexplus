import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { authDigest } from '@codexplus/shared';
import { UploadCancelled } from '../src/client.js';
import { filtered, makeClient, original, standalone, temporaryHome } from './helpers.js';

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
  assert.equal((await fetch(`${first.url}/v1/health`)).status, 200);
  assert.equal((await fetch(`${first.url}/v1/credentials`)).status, 401);
  assert.equal((await fetch(`${second.url}/v1/credentials`, { headers: { Authorization: 'Bearer invalid-session' } })).status, 401);
  await first.close();
  assert.deepEqual(await second.list(), []);
  assert.deepEqual(await client.config(), { version: 3, baseline: null });
  await assert.rejects(stat(join(client.home, 'server-access.json')), { code: 'ENOENT' });
});

test('自定义 HOME 时本地服务端写入客户端指定目录，~/ 输入与切换目标仍使用用户主目录', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, 'custom home');
  const { client } = makeClient(context, userHome, home);
  const session = await client.connect({ log: () => {} });
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
  await assert.rejects(client.connect({ log: () => {} }), /格式无效.*未被覆盖/u);
  assert.equal(await readFile(client.configPath, 'utf8'), '{broken');
  assert.deepEqual(started, []);
});

test('服务端凭证损坏、选项不存在或本地输入无效时，不覆盖客户端当前登录', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ log: () => {} });
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
  await writeFile(join(client.home, 'credentials', 'codex-person@example.com', 'auth.json'), '{"tokens":{}}');
  await assert.rejects(session.switch(credential), /access_token/u);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), before);
});

test('Unix 上客户端和服务端的敏感文件权限为 0600，目录为 0700', { skip: process.platform === 'win32' }, async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect({ log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  await session.switch((await session.add(join(userHome, 'input.json'))).credential);
  await session.close();
  for (const path of [client.configPath, join(client.home, 'config.json'),
    join(client.home, 'credentials', 'codex-person@example.com', 'auth.json'), client.codexAuthPath]) {
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
  const session = await client.connect({ log: () => {} });
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
  assert.equal((await session.current()).status, 'invalid');
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'other', id_token: idToken('other@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'unsaved', email: 'other@example.com' });
  await writeFile(session.codexAuthPath, '{"tokens":{"access_token":"x","id_token":"not-a-jwt"}}');
  assert.deepEqual(await session.current(), { status: 'unsaved', email: null });
  const snapshot = join(client.home, 'credentials', 'codex-person@example.com', 'auth.json');
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
  const first = await client.connect({ port: Number(new URL(server.url).port), log: () => {} });
  const second = await client.connect({ port: Number(new URL(server.url).port), log: () => {} });
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

test('通过本机端口连接独立服务端，关闭客户端不停止服务端，也不记住连接', async (context) => {
  const userHome = await temporaryHome(context);
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const { client, started } = makeClient(context, userHome);
  const session = await client.connect({ port: Number(new URL(server.url).port) });
  assert.equal(session.url, server.url);
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const { credential } = await session.add(join(userHome, 'input.json'));
  await session.switch(credential);
  await session.close();
  assert.deepEqual(started, []);
  assert.equal((await fetch(`${server.url}/v1/health`)).status, 200);
  assert.deepEqual(await readJson(join(userHome, '.codex', 'auth.json')), filtered);
  assert.deepEqual(await client.config(), { version: 3, baseline: { server: server.url, email: credential.email, digest: authDigest(JSON.stringify(filtered)) } });
  const local = await client.connect();
  assert.notEqual(local.url, server.url);
  assert.deepEqual(await local.list(), []);
  assert.equal(started.length, 1);
  await local.close();
});

test('显式本机端口离线时报错，不启动空库或改写配置，重启后可重连', async (context) => {
  const userHome = await temporaryHome(context);
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const port = Number(new URL(server.url).port);
  const { client, started } = makeClient(context, userHome);
  await (await client.connect({ port })).close();
  const before = await readFile(client.configPath, 'utf8');
  await server.close();
  await assert.rejects(client.connect({ port }), /无法连接/u);
  assert.equal(await readFile(client.configPath, 'utf8'), before);
  assert.deepEqual(started, []);
  await standalone(context, home, port);
  await (await client.connect({ port })).close();
});

test('旧客户端配置迁移删除所有连接和令牌，只保留本机基线', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  await mkdir(client.home);
  const remote = 'https://example.com';
  for (const version of [1, 2]) {
    for (const server of ['local', 'http://127.0.0.1:47831', remote]) {
      const baseline = { server, email: 'person@example.com', digest: 'baseline' };
      await writeFile(client.configPath, JSON.stringify({ version, current: remote, servers: { [remote]: { token: 'old-secret', clientId: 'old' } }, baseline }));
      const expected = { version: 3, baseline: server === 'local' ? baseline : null };
      assert.deepEqual(await client.config(), expected);
      const session = await client.connect();
      await session.close();
      assert.deepEqual(await readJson(client.configPath), expected);
      assert.doesNotMatch(await readFile(client.configPath, 'utf8'), /old-secret|https:\/\/example.com|servers|current/u);
    }
  }
});
