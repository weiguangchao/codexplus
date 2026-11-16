import { parseAuth, parseResetCardId, parseEmail, requestService, writeAtomic } from '@weiguangchao/codexplus-shared';
import { z } from 'zod';
import { parseRpcCall, expectValue } from '../../shared/test/helpers.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStore, readAudit, startServer } from '@weiguangchao/codexplus-server';
import { CredentialClient, Session } from '../src/client.js';
import { temporaryHome } from './helpers.js';

const alice = { type: 'codex' as const, email: parseEmail('alice@example.com') };
const bob = { type: 'codex' as const, email: parseEmail('bobby@example.com') };
const card = (id: string) => ({ id, reset_type: 'codex_rate_limits', status: 'available', granted_at: '2026-01-01T00:00:00Z' });
const auth = (email: string) => JSON.stringify({ tokens: { access_token: `fake-${email}`, account_id: `account-${email}`, refresh_token: 'never-send-refresh' } });

test('真实 C/S 流程按所选账号查询并使用指定卡片，不切换登录也不向 TUI 发送凭证', async (context) => {
  const root = await temporaryHome(context);
  const home = join(root, 'vault');
  const codexHome = join(root, 'codex');
  const upstream: { url: string; email: string; body: unknown }[] = [];
  const request: typeof fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    const email = headers.get('Authorization')?.replace('Bearer fake-', '') ?? '';
    assert.ok([alice.email, bob.email].includes(parseEmail(email)));
    assert.equal(headers.get('ChatGPT-Account-Id'), `account-${email}`);
    assert.doesNotMatch(JSON.stringify(options), /never-send-refresh/u);
    if (url === 'https://chatgpt.com/backend-api/me') return Response.json({ email });
    const body: unknown = options?.body === undefined ? null : JSON.parse(String(options.body));
    upstream.push({ url: String(url), email, body });
    if (options?.method === 'GET') return Response.json({ credits: [card(`${email}-card`)] });
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
    assert.ok(typeof body === 'object' && body !== null && 'credit_id' in body);
    assert.equal(body.credit_id, `${bob.email}-card`);
    return Response.json({ code: 'reset', windows_reset: 2 });
  };
  const store = new CredentialStore({ home, request });
  await store.add({ auth: parseAuth(auth(alice.email)) });
  await store.add({ auth: parseAuth(auth(bob.email)) });
  await writeAtomic({ path: join(codexHome, 'auth.json'), content: auth(alice.email) });
  const before = await Promise.all([join(codexHome, 'auth.json'), join(store.credentialsPath, `codex-${bob.email}`, 'auth.json')].map((path) => readFile(path, 'utf8')));
  const server = await startServer({ home, userHome: root, codexHome, port: 0, accountRequest: request });
  context.after(() => server.close());
  const wire: string[] = [];
  const localFetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    assert.equal(new URL(String(args[0])).hostname, '127.0.0.1');
    const response = await localFetch(...args);
    wire.push(String(args[1]?.body ?? '') + await response.clone().text());
    return response;
  });
  const client = new CredentialClient({ home: join(root, 'unused-client'), userHome: root, codexHome });
  const session = await client.connect({ port: Number(new URL(server.url).port) });
  assert.equal((await session.resetCards(alice))[0]?.id, `${alice.email}-card`);
  const cards = await session.resetCards(bob);
  assert.equal(upstream.length, 2);
  assert.equal(await session.useResetCard({ credential: bob, cardId: expectValue(cards[0]).id }), 'reset');
  assert.deepEqual(upstream.map(({ email }) => email), [alice.email, bob.email, bob.email]);
  assert.deepEqual(await Promise.all([join(codexHome, 'auth.json'), join(store.credentialsPath, `codex-${bob.email}`, 'auth.json')].map((path) => readFile(path, 'utf8'))), before);
  assert.deepEqual((await readAudit({ home })).map(({ event, email }) => ({ event, email })), [{ event: '重置', email: bob.email }]);
  assert.doesNotMatch(wire.join(''), /fake-|access_token|refresh_token|never-send-refresh/u);
  const count = upstream.length;
  await assert.rejects(requestService({ url: server.url, method: 'resetCards.list', params: { ...bob, email: parseEmail('missing@example.com') } }), /未找到/u);
  for (const body of [{ ...bob }, { ...bob, cardId: 'card' }, { ...bob, cardId: '', requestId: 'id' }, { ...bob, cardId: 'card', requestId: 42 }]) {
    await assert.rejects(requestService({ url: server.url, method: 'resetCards.use', params: body }), /cardId 和 requestId/u);
  }
  assert.equal(upstream.length, count);
});

test('结果未知时不自动重试，同一账号和卡片重试沿用请求 ID，明确未重置后创建新 ID', async (context) => {
  const root = await temporaryHome(context);
  const requestIds: string[] = [];
  let outcome = 'nothing_to_reset';
  const request: typeof fetch = async (url, options) => {
    if (url === 'https://chatgpt.com/backend-api/me') return Response.json({ email: bob.email });
    const body = z.object({ credit_id: z.string(), redeem_request_id: z.string() }).parse(JSON.parse(String(options?.body)));
    assert.equal(body.credit_id, 'chosen');
    requestIds.push(body.redeem_request_id);
    if (requestIds.length === 1) throw new Error('fake-secret');
    return Response.json({ code: outcome });
  };
  const home = join(root, 'vault');
  await new CredentialStore({ home, request }).add({ auth: parseAuth(auth(bob.email)) });
  const server = await startServer({ home, userHome: root, codexHome: join(root, 'codex'), port: 0, accountRequest: request });
  context.after(() => server.close());
  const session = new Session({ url: server.url, userHome: root, codexAuthPath: join(root, 'codex', 'auth.json'), stop: async () => {} });
  await assert.rejects(session.useResetCard({ credential: bob, cardId: parseResetCardId('chosen') }), /结果未能确认/u);
  assert.equal(requestIds.length, 1);
  assert.equal(await session.useResetCard({ credential: bob, cardId: parseResetCardId('chosen') }), 'nothing_to_reset');
  assert.equal(requestIds[0], requestIds[1]);
  outcome = 'already_redeemed';
  assert.equal(await session.useResetCard({ credential: bob, cardId: parseResetCardId('chosen') }), 'already_redeemed');
  assert.notEqual(requestIds[1], requestIds[2]);
  assert.deepEqual(await readAudit({ home }), []);
});

test('客户端拒绝异常列表和使用结果，不伪造成功或自动重复请求', async (context) => {
  let result: unknown = { cards: [{ id: 'broken' }] };
  const fetchMock = context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) =>
    Response.json({ jsonrpc: '2.0', id: parseRpcCall(String(options.body)).id, result }));
  const session = new Session({ url: 'http://127.0.0.1:12345', userHome: '/synthetic-user', codexAuthPath: '/synthetic-user/codex/auth.json', stop: async () => {} });
  await assert.rejects(session.resetCards(bob), /格式无效/u);
  result = { outcome: 'unknown' };
  await assert.rejects(session.useResetCard({ credential: bob, cardId: parseResetCardId('chosen') }), /格式无效/u);
  assert.equal(fetchMock.mock.callCount(), 2);
});
