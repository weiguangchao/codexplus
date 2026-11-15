import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestService, ServiceError } from '../src/protocol.js';

test('请求在发出网络访问前拒绝远程地址、TLS 和带凭据的地址', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  for (const url of [
    'https://remote.example', 'http://192.168.1.5:47831', 'http://0.0.0.0:47831',
    'https://127.0.0.1:47831', 'http://localhost:47831', 'http://user:secret@127.0.0.1:47831',
    'http://127.0.0.1:47831/path', 'http://127.0.0.1:47831?token=secret', 'http://127.0.0.1:47831#fragment',
  ]) {
    await assert.rejects(requestService(url, 'health'), /仅支持连接 127\.0\.0\.1/u);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('客户端通过固定入口发送 JSON-RPC，使用不同请求 ID 并解析 result', async (context) => {
  const ids = new Set<string>();
  const request = context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'http://127.0.0.1:47831/rpc');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('Authorization'), 'Bearer session');
    const body = JSON.parse(String(options.body));
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'login.switch');
    assert.deepEqual(body.params, { type: 'codex', email: 'a@example.com' });
    assert.equal(typeof body.id, 'string');
    assert.equal(ids.has(body.id), false);
    ids.add(body.id);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { ok: true } });
  });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await requestService('http://127.0.0.1:47831', 'login.switch', { type: 'codex', email: 'a@example.com' }, 'session'), { ok: true });
  }
  assert.equal(request.mock.callCount(), 2);
});

test('客户端拒绝错误 ID、版本、缺失或互斥字段和无效错误对象', async (context) => {
  let respond: (id: string) => unknown;
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) =>
    Response.json(respond(JSON.parse(String(options.body)).id)));
  for (const invalid of [
    (id: string) => ({ jsonrpc: '1.0', id, result: {} }),
    () => ({ jsonrpc: '2.0', id: 'wrong', result: {} }),
    () => ({ jsonrpc: '2.0', id: null, result: {} }),
    (id: string) => ({ jsonrpc: '2.0', id }),
    (id: string) => ({ jsonrpc: '2.0', id, result: {}, error: { code: -32603, message: 'error' } }),
    (id: string) => ({ jsonrpc: '2.0', id, error: { code: 'conflict', message: 'error' } }),
    (id: string) => ({ jsonrpc: '2.0', id, error: { code: -32603 } }),
    (id: string) => [{ jsonrpc: '2.0', id, result: {} }],
  ]) {
    respond = invalid;
    await assert.rejects(requestService('http://127.0.0.1:47831', 'health'),
      (error) => error instanceof ServiceError && error.status === 502);
  }
});

test('客户端保留业务错误详情与 RPC 错误码，区分 HTTP 拒绝', async (context) => {
  let httpStatus = 200;
  let code = -32000;
  let data: unknown = { status: 409, code: 'conflict', digest: 'latest' };
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) =>
    Response.json({ jsonrpc: '2.0', id: httpStatus === 200 ? JSON.parse(String(options.body)).id : null,
      error: { code, message: 'error', data } }, { status: httpStatus }));
  await assert.rejects(requestService('http://127.0.0.1:47831', 'login.save'), (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 409);
    assert.equal(error.rpcCode, -32000);
    assert.deepEqual(error.details, data);
    return true;
  });
  code = -32602;
  data = undefined;
  await assert.rejects(requestService('http://127.0.0.1:47831', 'login.switch'),
    (error) => error instanceof ServiceError && error.status === 400 && error.rpcCode === -32602);
  httpStatus = 401;
  await assert.rejects(requestService('http://127.0.0.1:47831', 'login.switch'),
    (error) => error instanceof ServiceError && error.status === 401);
});
