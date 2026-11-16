import { parseAuth, writeAtomic } from '@weiguangchao/codexplus-shared';
import { parseRpcCall, expectValue } from '../../shared/test/helpers.js';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStore, readAudit, startServer } from '@weiguangchao/codexplus-server';
import { Session } from '../src/client.js';
import { temporaryHome } from './helpers.js';

const auth = (email: string) => JSON.stringify({ tokens: { access_token: `fake-${email}`, account_id: `account-${email}`,
  id_token: `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`, refresh_token: 'never-send-refresh' } });

test('真实 C/S 查询当前登录而非已保存账号，刷新重新读凭证且不传递 token、不修改文件', async (context) => {
  const root = await temporaryHome(context);
  const home = join(root, 'vault');
  const codexHome = join(root, 'codex');
  const authPath = join(codexHome, 'auth.json');
  const queried: string[] = [];
  let used = 32;
  let expiryAvailable = true;
  const request: typeof fetch = async (url, options) => {
    const email = expectValue(new Headers(options?.headers).get('Authorization')).replace('Bearer fake-', '');
    assert.equal(new Headers(options?.headers).get('ChatGPT-Account-Id'), `account-${email}`);
    assert.doesNotMatch(JSON.stringify(options), /never-send-refresh/u);
    if (String(url).endsWith('/me')) return Response.json({ email });
    queried.push(email);
    if (String(url).includes('/subscriptions')) return expiryAvailable ? Response.json({ active_until: '2030-12-15T15:59:00Z' }) : new Response('private', { status: 403 });
    return Response.json({ plan_type: 'plus', account_id: `account-${email}`, rate_limit: {
      primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: 1_800_000_000 }, secondary_window: null } });
  };
  const vault = new CredentialStore({ home, request });
  await vault.add({ auth: parseAuth(auth('saved@example.com')) });
  const savedPath = join(vault.credentialsPath, 'codex-saved@example.com', 'auth.json');
  const savedBefore = await readFile(savedPath, 'utf8');
  await writeAtomic({ path: authPath, content: auth('current@example.com') });
  const server = await startServer({ home, userHome: root, codexHome, port: 0, sessionToken: 'local-session', accountRequest: request });
  context.after(() => server.close());
  const localFetch = globalThis.fetch;
  const wire: string[] = [];
  context.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    assert.equal(new URL(String(args[0])).hostname, '127.0.0.1');
    const response = await localFetch(...args);
    wire.push(await response.clone().text());
    return response;
  });
  const session = new Session({ url: server.url, userHome: root, codexAuthPath: authPath, stop: async () => {}, home, log: () => {}, sessionToken: 'local-session' });
  const first = await session.accountInfo();
  assert.equal(first.email, 'current@example.com');
  assert.equal(first.fiveHour?.remainingPercent, 68);
  assert.equal(first.expiresAt, '2030-12-15T15:59:00.000Z');
  assert.equal(await readFile(authPath, 'utf8'), auth('current@example.com'));
  await writeAtomic({ path: authPath, content: auth('other@example.com') });
  used = 58;
  expiryAvailable = false;
  const refreshed = await session.accountInfo();
  assert.equal(refreshed.email, 'other@example.com');
  assert.equal(refreshed.fiveHour?.remainingPercent, 42);
  assert.equal(refreshed.expiresAt, null);
  assert.deepEqual(queried, ['current@example.com', 'current@example.com', 'other@example.com', 'other@example.com']);
  assert.equal(await readFile(authPath, 'utf8'), auth('other@example.com'));
  assert.equal(await readFile(savedPath, 'utf8'), savedBefore);
  assert.deepEqual(await readAudit({ home }), []);
  assert.doesNotMatch(wire.join(''), /fake-|access_token|id_token|refresh_token|never-send-refresh/u);
  const unauthorized = new Session({ url: server.url, userHome: root, codexAuthPath: authPath, stop: async () => {} });
  await assert.rejects(unauthorized.accountInfo(), /本机会话无效/u);
  await unlink(authPath);
  await assert.rejects(session.accountInfo(), /找不到文件/u);
  await writeAtomic({ path: authPath, content: '{}' });
  await assert.rejects(session.accountInfo(), /access_token/u);
  assert.equal(queried.length, 4);
});

test('客户端验证详情字段，不接受无效日期、额度或异常响应', async (context) => {
  let result: unknown;
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) =>
    Response.json({ jsonrpc: '2.0', id: parseRpcCall(String(options.body)).id, result }));
  const session = new Session({ url: 'http://127.0.0.1:12345', userHome: '/demo', codexAuthPath: '/demo/auth.json', stop: async () => {} });
  const valid = { email: null, planType: 'plus', expiresAt: null, fiveHour: null, weekly: null };
  for (const value of [null, {}, { ...valid, expiresAt: 'bad' }, { ...valid, fiveHour: { remainingPercent: 101, resetsAt: null } },
    { ...valid, weekly: { remainingPercent: 42, resetsAt: 'bad' } }]) {
    result = value;
    await assert.rejects(session.accountInfo(), /格式无效/u);
  }
  result = { ...valid, access_token: 'do-not-forward' };
  assert.deepEqual(await session.accountInfo(), valid);
  result = { ...valid, email: 'who?@example.com' };
  assert.equal((await session.accountInfo()).email, 'who?@example.com');
});
