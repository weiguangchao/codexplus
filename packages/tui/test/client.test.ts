import { isRecord, parseServiceHealth, parseAuth, parseEmail, requestService, ServiceError } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { UploadCancelled } from '../src/client.js';
import { filtered, loginState, makeClient, original, temporaryHome } from './helpers.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('两个本机客户端使用独立端口，退出一个不影响另一个', async (context) => {
  const userHome = await temporaryHome(context);
  const { client, started } = makeClient({ context, userHome });
  const first = await client.connect();
  const second = await client.connect();
  context.after(() => second.close());
  assert.equal(started.length, 2);
  assert.notEqual(first.url, second.url);
  assert.equal((parseServiceHealth(await requestService({ url: first.url, method: 'health' }))).service, 'codexplus');
  await assert.rejects(requestService({ url: first.url, method: 'credentials.list' }), (error) => error instanceof ServiceError && error.status === 401);
  await assert.rejects(requestService({ url: second.url, method: 'credentials.list', params: undefined, sessionToken: 'invalid-session' }), (error) => error instanceof ServiceError && error.status === 401);
  await first.close();
  assert.deepEqual(await second.list(), []);
  assert.deepEqual(await loginState(client.home), { baseline: null });
  await assert.rejects(stat(join(client.home, 'server-access.json')), { code: 'ENOENT' });
});

test('自定义 HOME 时本地服务端写入客户端指定目录，~/ 输入与切换目标仍使用用户主目录', async (context) => {
  const userHome = await temporaryHome(context);
  const home = join(userHome, 'custom home');
  const { client } = makeClient({ context, userHome, home });
  const session = await client.connect({ log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const { credential } = await session.add({ path: '~/input.json' });
  await session.switch(credential);
  await session.close();
  assert.deepEqual(await readJson(join(home, 'config.json')), { version: 1, credentials: [credential] });
  await assert.rejects(stat(join(home, 'client.json')), { code: 'ENOENT' });
  assert.deepEqual(await readJson(session.codexAuthPath), filtered);
  await assert.rejects(stat(join(userHome, '.codexplus')), { code: 'ENOENT' });
});

test('服务端迁移旧客户端配置时拒绝损坏文件并保留原内容', async (context) => {
  const userHome = await temporaryHome(context);
  const { client, started } = makeClient({ context, userHome });
  await mkdir(client.home, { recursive: true });
  await writeFile(join(client.home, 'client.json'), '{broken');
  await assert.rejects(client.connect({ log: () => {} }), /格式无效.*未被覆盖/u);
  assert.equal(await readFile(join(client.home, 'client.json'), 'utf8'), '{broken');
  assert.equal(started.length, 1);
});

test('服务端凭证损坏、选项不存在或本地输入无效时，不覆盖客户端当前登录', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ context, userHome });
  const session = await client.connect({ log: () => {} });
  context.after(() => session.close());
  await assert.rejects(session.add({ path: '' }), /文件路径/u);
  await assert.rejects(session.add({ path: join(userHome, 'missing.json') }), /找不到文件/u);
  await writeFile(join(userHome, 'invalid.json'), '{"OPENAI_API_KEY":"fake-secret"}');
  await assert.rejects(session.add({ path: join(userHome, 'invalid.json') }), /access_token/u);
  assert.deepEqual(await session.list(), []);
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  const { credential } = await session.add({ path: join(userHome, 'input.json') });
  await session.switch(credential);
  const before = await readFile(session.codexAuthPath, 'utf8');
  await assert.rejects(session.switch({ type: 'codex', email: parseEmail('missing@example.com') }), /未找到/u);
  await writeFile(join(client.home, 'credentials', 'codex-person@example.com', 'auth.json'), '{"tokens":{}}');
  await assert.rejects(session.switch(credential), /access_token/u);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), before);
});

test('Unix 上客户端和服务端的敏感文件权限为 0600，目录为 0700', { skip: process.platform === 'win32' }, async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ context, userHome });
  const session = await client.connect({ log: () => {} });
  await writeFile(join(userHome, 'input.json'), JSON.stringify(original));
  await session.switch((await session.add({ path: join(userHome, 'input.json') })).credential);
  await session.close();
  for (const path of [join(client.home, 'login.json'), join(client.home, 'config.json'),
    join(client.home, 'credentials', 'codex-person@example.com', 'auth.json'), session.codexAuthPath]) {
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
  const { client } = makeClient({ context, userHome });
  const session = await client.connect({ log: () => {} });
  context.after(() => session.close());
  assert.deepEqual(await session.current(), { status: 'none' });
  const source = join(userHome, 'input.json');
  await writeFile(source, JSON.stringify({ ...original, tokens: { ...original.tokens, id_token: idToken('person@example.com') } }));
  await session.add({ path: source });
  await mkdir(join(userHome, '.codex'), { recursive: true });
  await writeFile(session.codexAuthPath, await readFile(source, 'utf8'));
  assert.deepEqual(await session.current(), { status: 'saved', email: parseEmail('person@example.com') });
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'refreshed', id_token: idToken('person@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'diverged', email: parseEmail('person@example.com') });
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { id_token: idToken('person@example.com') } }));
  assert.equal((await session.current()).status, 'invalid');
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'other', id_token: idToken('other@example.com') } }));
  assert.deepEqual(await session.current(), { status: 'unsaved', email: parseEmail('other@example.com') });
  await writeFile(session.codexAuthPath, '{"tokens":{"access_token":"x","id_token":"not-a-jwt"}}');
  assert.deepEqual(await session.current(), { status: 'unsaved', email: null });
  const snapshot = join(client.home, 'credentials', 'codex-person@example.com', 'auth.json');
  await writeFile(session.codexAuthPath, JSON.stringify({ tokens: { access_token: 'b', id_token: idToken('person@example.com') } }));
  await rm(snapshot);
  assert.deepEqual(await session.current(), { status: 'unsaved', email: parseEmail('person@example.com') });
  await mkdir(snapshot);
  assert.deepEqual(await session.current(), { status: 'unsaved', email: parseEmail('person@example.com') });
});

test('其他客户端更新同一账号后，当前登录状态立即变为服务端有更新版本', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ context, userHome });
  const first = await client.connect({ log: () => {} });
  const second = await client.connect({ log: () => {} });
  context.after(async () => { await first.close(); await second.close(); });
  const login = JSON.stringify({ tokens: { access_token: 'v1', id_token: idToken('person@example.com') }, last_refresh: '2026-11-01T00:00:00Z' });
  await writeFile(join(userHome, 'v1.json'), login);
  await first.add({ path: join(userHome, 'v1.json') });
  await mkdir(join(first.userHome, '.codex'), { recursive: true });
  await writeFile(first.codexAuthPath, login);
  await first.list();
  assert.deepEqual(await first.current(), { status: 'saved', email: parseEmail('person@example.com') });
  await writeFile(join(userHome, 'v2.json'), JSON.stringify({ tokens: { access_token: 'v2', id_token: idToken('person@example.com') }, last_refresh: '2026-11-10T00:00:00Z' }));
  await first.switch({ type: 'codex', email: parseEmail('person@example.com') });
  second.confirmUpload = async () => true;
  await second.add({ path: join(userHome, 'v2.json') });
  assert.deepEqual(await first.current(), { status: 'behind', email: parseEmail('person@example.com') });
});

test('基线区分本机领先、服务端领先和分歧，旧快照必须确认才能覆盖', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ context, userHome });
  const session = await client.connect();
  context.after(() => session.close());
  const email = 'person@example.com';
  const auth = (access: string) => JSON.stringify({ tokens: { access_token: access, id_token: idToken(email) }, last_refresh: `2026-11-0${access.slice(1)}T00:00:00Z` });
  const source = join(userHome, 'source.json');
  await writeFile(source, auth('v1'));
  const { credential } = await session.add({ path: source });
  await session.switch(credential);
  await writeFile(session.codexAuthPath, auth('v2'));
  assert.equal((await session.current()).status, 'ahead');
  await session.add({ path: session.codexAuthPath });
  await writeFile(source, auth('v3'));
  let confirmations = 0;
  session.confirmUpload = async (details) => { confirmations++; assert.equal(details.code, 'conflict'); return true; };
  await session.add({ path: source });
  assert.equal(confirmations, 1);
  assert.equal((await session.current()).status, 'behind');
  session.confirmUpload = async () => false;
  await assert.rejects(session.add({ path: session.codexAuthPath }), UploadCancelled);
  await session.switch(credential);
  assert.equal(parseAuth(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'v3');
  const statePath = join(client.home, 'login.json');
  const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(isRecord(state));
  await writeFile(statePath, JSON.stringify({ ...state, baseline: null }));
  await writeFile(session.codexAuthPath, auth('v4'));
  assert.equal((await session.current()).status, 'diverged');
});

test('确认期间再次上传产生新冲突时再次询问，不使用强制覆盖', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ context, userHome });
  const session = await client.connect();
  context.after(() => session.close());
  const source = join(userHome, 'upload.json');
  const rival = join(userHome, 'rival.json');
  await writeFile(source, '{"tokens":{"access_token":"v1"}}');
  await session.add({ path: source });
  await writeFile(source, '{"tokens":{"access_token":"v2"}}');
  let asked = 0;
  session.confirmUpload = async () => {
    asked++;
    if (asked === 1) {
      const other = await client.connect();
      try {
        await writeFile(rival, '{"tokens":{"access_token":"v3"}}');
        other.confirmUpload = async () => true;
        await other.add({ path: rival });
      } finally { await other.close(); }
    }
    return true;
  };
  await session.add({ path: source });
  assert.equal(asked, 2);
});
