import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '@codexplus/app-server';
import { writeAtomic } from '@codexplus/shared';
import { CredentialClient } from '../src/client.js';
import { confirmRunningCodex } from '../src/switch.js';
import { account, temporaryHome } from './helpers.js';

const email = 'person@example.com';
const auth = (token: string, last_refresh = '2026-11-01T00:00:00Z') => JSON.stringify({
  tokens: { access_token: token, id_token: `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s` }, last_refresh,
});

test('TUI 只传操作参数，登录路径、文件导入、状态、进程和切换均由独立服务端管理', async (context) => {
  const root = await temporaryHome(context);
  const userHome = join(root, 'server-user');
  const home = join(root, 'server-data');
  const codexHome = join(root, 'server-codex');
  const clientHome = join(root, 'client-data');
  const clientAuth = join(root, 'client-codex', 'auth.json');
  await writeAtomic(join(codexHome, 'auth.json'), auth('server-secret'));
  await writeAtomic(clientAuth, auth('client-must-stay'));
  await writeAtomic(join(userHome, 'import.json'), auth('import-secret', '2026-11-10T00:00:00Z'));
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
  const client = new CredentialClient({ home: clientHome, userHome: join(root, 'client-user'), codexHome: join(root, 'client-codex') });
  const session = await client.connect({ port: Number(new URL(server.url).port) });
  assert.equal(session.codexAuthPath, join(codexHome, 'auth.json'));
  assert.equal(session.userHome, userHome);
  assert.equal(session.home, home);
  assert.deepEqual(await session.current(), { status: 'unsaved', email });
  const { credential } = await session.saveCurrent();
  await session.validateSource('~/import.json');
  session.confirmUpload = async () => true;
  await session.add('~/import.json');
  assert.deepEqual(await session.current(), { status: 'behind', email });
  assert.deepEqual(await session.refreshTimes(email), { local: '2026-11-01T00:00:00Z', server: '2026-11-10T00:00:00Z' });
  assert.equal(await confirmRunningCodex({ findProcesses: () => session.processes(), ask: async () => false, log: () => {} }), false);
  assert.equal(JSON.parse(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'server-secret');
  await session.switch(credential);
  assert.equal(JSON.parse(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'import-secret');
  assert.equal(JSON.parse(await readFile(clientAuth, 'utf8')).tokens.access_token, 'client-must-stay');
  await assert.rejects(stat(clientHome), { code: 'ENOENT' });
  assert.ok(requests.some((request) => request.url.endsWith('/v1/login/save')));
  assert.ok(requests.some((request) => request.url.endsWith('/v1/login/switch')));
  assert.ok(requests.every((request) => !request.url.endsWith('/v1/credentials/download')));
  for (const request of requests) assert.doesNotMatch(request.body + request.response, /server-secret|import-secret|client-must-stay|access_token|id_token/u);
});

test('同步基线和删除记录在客户端换目录及服务端重启后仍生效', async (context) => {
  const root = await temporaryHome(context);
  const options = { home: join(root, 'vault'), userHome: root, codexHome: join(root, 'codex'), port: 0, accountRequest: account };
  let server = await startServer(options);
  context.after(() => server.close());
  const client = new CredentialClient({ home: join(root, 'first-client') });
  const first = await client.connect({ port: Number(new URL(server.url).port) });
  await writeAtomic(first.codexAuthPath, auth('first'));
  const { credential } = await first.saveCurrent();
  await writeAtomic(first.codexAuthPath, auth('refreshed', '2026-11-10T00:00:00Z'));
  await first.close();
  await server.close();
  server = await startServer(options);
  const second = await new CredentialClient({ home: join(root, 'second-client') }).connect({ port: Number(new URL(server.url).port) });
  assert.deepEqual(await second.current(), { status: 'ahead', email });
  await second.list();
  await second.delete(credential);
  await server.close();
  server = await startServer(options);
  const third = await client.connect({ port: Number(new URL(server.url).port) });
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
  const session = await new CredentialClient().connect({ port: Number(new URL(server.url).port) });
  await writeAtomic(session.codexAuthPath, auth('original'));
  const { credential } = await session.saveCurrent();
  const before = await readFile(session.codexAuthPath, 'utf8');
  await writeAtomic(join(root, 'login.json'), '{broken');
  await assert.rejects(session.switch(credential), /格式无效/u);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), before);
});
