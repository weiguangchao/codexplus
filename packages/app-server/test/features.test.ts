import { parseAuth, parseEmail, requestService, ServiceError } from '@weiguangchao/codexplus-shared';
import { expectValue } from '../../shared/test/helpers.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAudit, recordAudit } from '../src/audit.js';
import { runAdmin } from '../src/serve.js';
import { CredentialStore } from '../src/store.js';
import { account, standalone, temporaryHome } from './helpers.js';

test('条件删除拒绝不存在和过期快照，成功后索引与文件一致', async (context) => {
  const home = await temporaryHome(context);
  const store = new CredentialStore({ home, request: account });
  const { credential } = await store.add({ auth: parseAuth('{"tokens":{"access_token":"old"}}'), base: null });
  const base = expectValue((await store.digest(credential)));
  await assert.rejects(store.delete({ credential: { type: 'codex', email: parseEmail('missing@example.com') }, base }), /未找到/u);
  await store.add({ auth: parseAuth('{"tokens":{"access_token":"new"}}'), base });
  await assert.rejects(store.delete({ credential, base }), (error) => error instanceof ServiceError && error.status === 409);
  assert.equal((await store.list()).length, 1);
  await store.delete({ credential, base: expectValue((await store.digest(credential))) });
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(store.credentialsPath), []);
});

test('三类成功操作写记录，失败不记，记录不含令牌或凭证', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone({ context, home });
  const credential = { type: 'codex', email: parseEmail('person@example.com') };
  await requestService({ url: server.url, method: 'credentials.upload', params: { auth: { tokens: { access_token: 'fake-secret' } }, base: null } });
  await requestService({ url: server.url, method: 'credentials.download', params: credential });
  await assert.rejects(requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, base: 'old' } }));
  const store = new CredentialStore({ home });
  await requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, base: await store.digest({ type: 'codex', email: credential.email }) } });
  const entries = await readAudit({ home });
  assert.deepEqual(entries.map((entry) => entry.event), ['上传', '下载', '删除']);
  const lines: string[] = [];
  await runAdmin({ command: { kind: 'admin', home, action: 'log', limit: 1 }, log: (message) => lines.push(message) });
  assert.match(expectValue(lines[0]), /删除.*本机.*person@example.com/u);
  assert.ok(entries.every((entry) => entry.clientId === 'local' && entry.clientName === '本机'));
  const content = await readFile(join(home, 'audit.log'), 'utf8');
  assert.equal(content.includes('fake-secret'), false);
});

test('记录保留最近一千条，log 默认和 limit 按时间顺序输出', async (context) => {
  const home = await temporaryHome(context);
  const messages: string[] = [];
  const log = (message: string) => messages.push(message);
  await runAdmin({ command: { kind: 'admin', home, action: 'log' }, log });
  assert.match(expectValue(messages[0]), /暂无操作记录/u);
  for (let index = 0; index < 1002; index++) await recordAudit({ home, event: '上传', client: { id: 'local', name: '本机' }, subject: { email: parseEmail(`${index}@example.com`) } });
  const entries = await readAudit({ home, limit: 2000 });
  assert.equal(entries.length, 1000);
  assert.equal(entries[0]?.email, '2@example.com');
  messages.length = 0;
  await runAdmin({ command: { kind: 'admin', home, action: 'log' }, log });
  assert.equal(messages.length, 50);
  messages.length = 0;
  await runAdmin({ command: { kind: 'admin', home, action: 'log', limit: 2 }, log });
  assert.match(expectValue(messages[0]), /1000@example.com/u);
  assert.match(expectValue(messages[1]), /1001@example.com/u);
});

test('记录写不进去时，已完成的上传和删除照常返回，下载不交出凭证', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone({ context, home });
  await mkdir(join(home, 'audit.log'));
  const warnings = context.mock.method(process.stderr, 'write', () => true);
  const credential = { type: 'codex', email: parseEmail('person@example.com') };
  await requestService({ url: server.url, method: 'credentials.upload', params: { auth: { tokens: { access_token: 'fake-secret' } }, base: null } });
  await assert.rejects(requestService({ url: server.url, method: 'credentials.download', params: credential }), (error) => error instanceof ServiceError && error.status === 500);
  const store = new CredentialStore({ home });
  await requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, base: await store.digest({ type: 'codex', email: credential.email }) } });
  assert.deepEqual(await store.list(), []);
  assert.equal(warnings.mock.callCount(), 2);
  for (const call of warnings.mock.calls) assert.equal(String(call.arguments[0]).includes('fake-secret'), false);
  await rm(join(home, 'audit.log'), { recursive: true });
});
