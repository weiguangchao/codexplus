import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccessStore } from '../src/access.js';
import { readAudit, recordAudit } from '../src/audit.js';
import { parseCommand } from '../src/options.js';
import { requestService, ServiceError } from '../src/protocol.js';
import { runAdmin } from '../src/serve.js';
import { CredentialStore } from '../src/store.js';
import { account, standalone, temporaryHome } from './helpers.js';

test('条件删除拒绝不存在和过期快照，成功后索引与文件一致', async (context) => {
  const home = await temporaryHome(context);
  const store = new CredentialStore({ home, request: account });
  const credential = await store.add('{"tokens":{"access_token":"old"}}', null);
  const base = (await store.digest(credential))!;
  await assert.rejects(store.delete({ type: 'codex', email: 'missing@example.com' }, base), /未找到/u);
  await store.add('{"tokens":{"access_token":"new"}}', base);
  await assert.rejects(store.delete(credential, base), (error) => error instanceof ServiceError && error.status === 409);
  assert.equal((await store.list()).length, 1);
  await store.delete(credential, (await store.digest(credential))!);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(store.credentialsPath), []);
});

test('最近使用时间每分钟更新一次', async (context) => {
  const home = await temporaryHome(context);
  let now = Date.now();
  const access = new AccessStore(home, () => now);
  const { token } = await access.addClient('测试');
  assert.equal((await access.list())[0]?.lastSeenAt, undefined);
  const first = await access.authorize(token);
  const before = await readFile(access.path, 'utf8');
  now += 59_999;
  assert.deepEqual(await access.authorize(token), first);
  assert.equal(await readFile(access.path, 'utf8'), before);
  now++;
  assert.notEqual((await access.authorize(token))?.lastSeenAt, first?.lastSeenAt);
});

test('五类成功操作写记录，失败不记，记录不含令牌或凭证', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const access = new AccessStore(home);
  const pair = await access.createPair();
  const result = await requestService(server.url, '/v1/pair', undefined, { code: pair.code, name: '笔记本' }) as { token: string; client: { id: string } };
  const credential = { type: 'codex', email: 'person@example.com' };
  await requestService(server.url, '/v1/credentials', result.token, { auth: { tokens: { access_token: 'fake-secret' } }, base: null });
  await requestService(server.url, '/v1/credentials/download', result.token, credential);
  await assert.rejects(requestService(server.url, '/v1/credentials/delete', result.token, { ...credential, base: 'old' }));
  const store = new CredentialStore({ home });
  await requestService(server.url, '/v1/credentials/delete', result.token, { ...credential, base: await store.digest({ type: 'codex', email: credential.email }) });
  await runAdmin({ kind: 'admin', home, action: 'revoke', id: result.client.id }, () => {});
  const entries = await readAudit(home);
  assert.deepEqual(entries.map((entry) => entry.event), ['配对', '上传', '下载', '删除', '撤销']);
  assert.equal(entries.at(-1)?.clientName, '管理命令');
  assert.deepEqual(entries.at(-1)?.target, { id: result.client.id, name: '笔记本' });
  const lines: string[] = [];
  await runAdmin({ kind: 'admin', home, action: 'log', limit: 1 }, (message) => lines.push(message));
  assert.match(lines[0]!, new RegExp(`撤销.*管理命令.*笔记本（${result.client.id}）`, 'u'));
  const content = await readFile(join(home, 'audit.log'), 'utf8');
  for (const secret of [pair.code, result.token, 'fake-secret']) assert.equal(content.includes(secret), false);
});

test('记录保留最近一千条，log 默认和 limit 按时间顺序输出', async (context) => {
  const home = await temporaryHome(context);
  const messages: string[] = [];
  const log = (message: string) => messages.push(message);
  await runAdmin({ kind: 'admin', home, action: 'log' }, log);
  assert.match(messages[0]!, /暂无操作记录/u);
  for (let index = 0; index < 1002; index++) await recordAudit(home, '上传', { id: 'local', name: '本机' }, { email: `${index}@example.com` });
  const entries = await readAudit(home, 2000);
  assert.equal(entries.length, 1000);
  assert.equal(entries[0]?.email, '2@example.com');
  messages.length = 0;
  await runAdmin({ kind: 'admin', home, action: 'log' }, log);
  assert.equal(messages.length, 50);
  messages.length = 0;
  await runAdmin({ kind: 'admin', home, action: 'log', limit: 2 }, log);
  assert.match(messages[0]!, /1000@example.com/u);
  assert.match(messages[1]!, /1001@example.com/u);
  assert.equal(parseCommand(['serve', 'log', '--limit', '2']).kind, 'admin');
  for (const value of ['0', '-1', '1.5', 'abc']) assert.throws(() => parseCommand(['serve', 'log', '--limit', value]));
  assert.throws(() => parseCommand(['serve', 'pair', '--limit', '2']));
});

test('记录写不进去时，已完成的配对、上传、删除和撤销照常返回，下载不交出凭证', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const access = new AccessStore(home);
  await mkdir(join(home, 'audit.log'));
  const warnings = context.mock.method(console, 'error', () => {});
  const pair = await access.createPair();
  const result = await requestService(server.url, '/v1/pair', undefined, { code: pair.code, name: '笔记本' }) as { token: string; client: { id: string } };
  assert.equal((await access.list()).length, 1);
  const credential = { type: 'codex', email: 'person@example.com' };
  await requestService(server.url, '/v1/credentials', result.token, { auth: { tokens: { access_token: 'fake-secret' } }, base: null });
  await assert.rejects(requestService(server.url, '/v1/credentials/download', result.token, credential), (error) => error instanceof ServiceError && error.status === 500);
  const store = new CredentialStore({ home });
  await requestService(server.url, '/v1/credentials/delete', result.token, { ...credential, base: await store.digest({ type: 'codex', email: credential.email }) });
  assert.deepEqual(await store.list(), []);
  await runAdmin({ kind: 'admin', home, action: 'revoke', id: result.client.id }, () => {});
  assert.deepEqual(await access.list(), []);
  assert.equal(warnings.mock.callCount(), 4);
  for (const call of warnings.mock.calls) assert.equal(String(call.arguments[0]).includes('fake-secret'), false);
  await rm(join(home, 'audit.log'), { recursive: true });
});
