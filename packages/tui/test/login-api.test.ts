import { parseRpcCall } from '../../shared/test/helpers.js';
import { parseAuth, parseEmail, writeAtomic } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '@weiguangchao/codexplus-server';
import { confirmRunningCodex, switchCredential } from '../src/switch.js';
import { account, serverSession, temporaryHome } from './helpers.js';

const email = 'person@example.com';
const auth = (token: string, last_refresh = '2026-11-01T00:00:00Z') => JSON.stringify({
  tokens: { access_token: token, id_token: `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s` }, last_refresh,
});

test('TUI 只传操作参数，登录路径、文件导入、状态、进程和切换均由服务端管理', async (context) => {
  const root = await temporaryHome(context);
  const userHome = join(root, 'server-user');
  const home = join(root, 'server-data');
  const codexHome = join(root, 'server-codex');
  const clientAuth = join(root, 'client-codex', 'auth.json');
  await writeAtomic({ path: join(codexHome, 'auth.json'), content: auth('server-secret') });
  await writeAtomic({ path: clientAuth, content: auth('client-must-stay') });
  await writeAtomic({ path: join(userHome, 'import.json'), content: auth('import-secret', '2026-11-10T00:00:00Z') });
  const server = await startServer({ home, userHome, codexHome, port: 0, accountRequest: account,
    findProcesses: async () => [{ pid: 7654, command: 'codex' }] });
  context.after(() => server.close());
  const requests: { url: string; body: string; response: string }[] = [];
  const fetchService = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await fetchService(...args);
    requests.push({ url: String(args[0]), body: String(args[1]?.body ?? ''), response: await response.clone().text() });
    return response;
  });
  const session = await serverSession(server.url);
  assert.equal(session.codexAuthPath, join(codexHome, 'auth.json'));
  assert.equal(session.userHome, userHome);
  assert.equal(session.home, home);
  assert.deepEqual(await session.current(), { status: 'unsaved', email });
  const { credential } = await session.saveCurrent();
  await session.validateSource('~/import.json');
  session.confirmUpload = async () => true;
  await session.add({ path: '~/import.json' });
  assert.deepEqual(await session.current(), { status: 'behind', email });
  assert.deepEqual(await session.refreshTimes(parseEmail(email)), { local: '2026-11-01T00:00:00Z', server: '2026-11-10T00:00:00Z' });
  assert.equal(await confirmRunningCodex({ findProcesses: () => session.processes(), ask: async () => false, log: () => {} }), false);
  assert.equal(parseAuth(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'server-secret');
  await session.switch(credential);
  assert.equal(parseAuth(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'import-secret');
  assert.equal(parseAuth(await readFile(clientAuth, 'utf8')).tokens.access_token, 'client-must-stay');
  assert.ok(requests.every((request) => request.url.endsWith('/rpc')));
  const methods = requests.map((request) => parseRpcCall(request.body).method);
  assert.ok(methods.includes('login.save'));
  assert.ok(methods.includes('login.switch'));
  assert.ok(!methods.includes('credentials.download'));
  for (const request of requests) assert.doesNotMatch(request.body + request.response, /server-secret|import-secret|client-must-stay|access_token|id_token/u);
});

test('同步基线和删除记录在会话重连及服务端重启后仍生效', async (context) => {
  const root = await temporaryHome(context);
  const options = { home: join(root, 'vault'), userHome: root, codexHome: join(root, 'codex'), port: 0, accountRequest: account };
  let server = await startServer(options);
  context.after(() => server.close());
  const first = await serverSession(server.url);
  await writeAtomic({ path: first.codexAuthPath, content: auth('first') });
  const { credential } = await first.saveCurrent();
  await writeAtomic({ path: first.codexAuthPath, content: auth('refreshed', '2026-11-10T00:00:00Z') });
  await first.close();
  await server.close();
  server = await startServer(options);
  const second = await serverSession(server.url);
  assert.deepEqual(await second.current(), { status: 'ahead', email });
  await second.list();
  await second.delete(credential);
  await server.close();
  server = await startServer(options);
  const third = await serverSession(server.url);
  assert.deepEqual(await third.current(), { status: 'deleted', email });
  await assert.rejects(third.saveCurrent(), /已取消/u);
  third.confirmRestore = async () => true;
  await third.saveCurrent();
  assert.deepEqual(await third.current(), { status: 'saved', email });
});

test('损坏的服务端同步状态会阻止切换，当前登录保持原样', async (context) => {
  const root = await temporaryHome(context);
  const server = await startServer({ home: root, userHome: root, codexHome: join(root, 'codex'), port: 0, accountRequest: account });
  context.after(() => server.close());
  const session = await serverSession(server.url);
  await writeAtomic({ path: session.codexAuthPath, content: auth('original') });
  const { credential } = await session.saveCurrent();
  const before = await readFile(session.codexAuthPath, 'utf8');
  await writeAtomic({ path: join(root, 'login.json'), content: '{broken' });
  await assert.rejects(session.switch(credential), /格式无效/u);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), before);
});

test('选择切换并重启时由服务端重启对应 CODEX_HOME，普通切换和取消不重启', async (context) => {
  const root = await temporaryHome(context);
  const codexHome = join(root, 'server-codex');
  let restarted = 0;
  let failRestart = false;
  const server = await startServer({ home: join(root, 'vault'), userHome: root, codexHome, port: 0, accountRequest: account,
    restartServer: async (directory) => {
      assert.equal(directory, codexHome);
      assert.equal(parseAuth(await readFile(join(directory, 'auth.json'), 'utf8')).tokens.access_token, 'target');
      restarted++;
      if (failRestart) throw new Error('重启失败');
    } });
  context.after(() => server.close());
  const session = await serverSession(server.url);
  await writeAtomic({ path: session.codexAuthPath, content: auth('target') });
  const { credential } = await session.saveCurrent();
  const findProcesses = async () => [{ pid: 7654, command: 'codex' }];
  for (const decision of [false, true, 'restart'] as const) {
    await writeAtomic({ path: session.codexAuthPath, content: auth('original') });
    await switchCredential({ store: session, credential, options: { findProcesses, ask: async () => decision, log: () => {} } });
    assert.equal(parseAuth(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, decision ? 'target' : 'original');
    assert.equal(restarted, decision === 'restart' ? 1 : 0);
  }
  failRestart = true;
  await assert.rejects(switchCredential({ store: session, credential, options: { findProcesses, ask: async () => 'restart', log: () => {} } }), /重启失败/u);
  assert.equal(restarted, 2);
  assert.deepEqual(await session.current(), { status: 'saved', email });
  const before = restarted;
  await assert.rejects(switchCredential({ store: session, credential: { type: 'codex', email: parseEmail('missing@example.com') }, options: { findProcesses, ask: async () => 'restart', log: () => {} } }));
  assert.equal(restarted, before);
});
