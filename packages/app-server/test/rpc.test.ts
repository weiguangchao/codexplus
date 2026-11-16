import { parseRpcFailure } from '../../shared/test/helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protocolVersion } from '@weiguangchao/codexplus-shared';
import { startServer } from '../src/server.js';
import { standalone, temporaryHome } from './helpers.js';

async function send({ url, body, token }: { url: string; body: unknown; token?: string | undefined }): Promise<Response> {
  return await fetch(`${url}/rpc`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
}

test('JSON-RPC 回显字符串、数字和 null ID，省略 params 时仍可查询', async (context) => {
  const server = await standalone({ context, home: await temporaryHome(context) });
  for (const id of ['health-1', 0, 12, null]) {
    const response = await send({ url: server.url, body: { jsonrpc: '2.0', id, method: 'health' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id,
      result: { service: 'codexplus', version: protocolVersion } });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('JSON-RPC 解析、信封、未知方法和参数错误使用标准错误码', async (context) => {
  const server = await standalone({ context, home: await temporaryHome(context) });
  const parse = await fetch(`${server.url}/rpc`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(parse.status, 200);
  assert.deepEqual(await parse.json(), { jsonrpc: '2.0', id: null,
    error: { code: -32700, message: '请求 JSON 格式无效。' } });
  for (const body of [null, 1, true, 'text', {}, [],
    { jsonrpc: '1.0', id: 1, method: 'health' },
    { jsonrpc: '2.0', id: true, method: 'health' },
    { jsonrpc: '2.0', id: {}, method: 'health' },
    { jsonrpc: '2.0', id: 1, method: 123 },
    { jsonrpc: '2.0', id: 1, method: 'health', params: null },
    { jsonrpc: '2.0', id: 1, method: 'health', params: 'invalid' },
  ]) {
    const response = await send({ url: server.url, body });
    assert.equal(response.status, 200);
    const result = parseRpcFailure(await response.json());
    assert.equal(result.jsonrpc, '2.0');
    assert.equal(result.id, null);
    assert.equal(result.error.code, -32600);
    assert.equal(Object.hasOwn(result, 'result'), false);
  }
  for (const [method, params, code] of [
    ['unknown', {}, -32601], ['rpc.unknown', {}, -32601],
    ['login.switch', {}, -32602], ['login.switch', ['codex', 'a@example.com'], -32602],
    ['credentials.upload', { base: null, auth: 'fake-secret' }, -32602],
  ] as const) {
    const response = await send({ url: server.url, body: { jsonrpc: '2.0', id: 'request', method, params } });
    const result = parseRpcFailure(await response.json());
    assert.equal(response.status, 200);
    assert.equal(result.id, 'request');
    assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes('fake-secret'), false);
  }
});

test('JSON-RPC 隐藏意外服务端错误的内部信息', async (context) => {
  const home = await temporaryHome(context);
  const server = await startServer({ home, port: 0, findProcesses: async () => { throw new Error('fake-secret'); } });
  context.after(() => server.close());
  const response = await send({ url: server.url, body: { jsonrpc: '2.0', id: 1, method: 'login.processes' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1,
    error: { code: -32603, message: '服务端操作失败，请检查服务端文件权限和配置。' } });
});

test('JSON-RPC 通知执行操作且不返回结果或错误，批量调用仅响应有 ID 的有效请求和无效信封', async (context) => {
  let calls = 0;
  const server = await startServer({ home: await temporaryHome(context), port: 0,
    findProcesses: async () => { calls++; return []; } });
  context.after(() => server.close());
  const notification = { jsonrpc: '2.0', method: 'login.processes' };
  for (const body of [notification, { jsonrpc: '2.0', method: 'unknown' },
    { jsonrpc: '2.0', method: 'login.switch', params: {} }, [notification]]) {
    const response = await send({ url: server.url, body });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  }
  assert.equal(calls, 2);
  const response = await send({ url: server.url, body: [
    notification,
    { jsonrpc: '2.0', id: 'list', method: 'credentials.list' },
    { jsonrpc: '2.0', method: 'unknown' },
    { jsonrpc: '2.0', id: 0, method: 'unknown' },
    42,
    { jsonrpc: '2.0', id: null, method: 'health' },
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { jsonrpc: '2.0', id: 'list', result: { credentials: [] } },
    { jsonrpc: '2.0', id: 0, error: { code: -32601, message: '未找到服务端方法。' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC 请求格式无效。' } },
    { jsonrpc: '2.0', id: null, result: { service: 'codexplus', version: protocolVersion } },
  ]);
  assert.equal(calls, 3);
});

test('批量请求和通知不能绕过本机会话鉴权，拒绝时不执行任何操作', async (context) => {
  let calls = 0;
  const server = await startServer({ home: await temporaryHome(context), port: 0, sessionToken: 'session',
    findProcesses: async () => { calls++; return []; } });
  context.after(() => server.close());
  const health = { jsonrpc: '2.0', id: 1, method: 'health' };
  const processes = { jsonrpc: '2.0', method: 'login.processes' };
  for (const body of [health, [health]]) assert.equal((await send({ url: server.url, body })).status, 200);
  for (const body of [processes, [health, processes], [processes, health]]) {
    const response = await send({ url: server.url, body });
    assert.equal(response.status, 401);
    assert.deepEqual(parseRpcFailure(await response.json()).error.data, { status: 401 });
  }
  assert.equal((await send({ url: server.url, body: [processes, health], token: 'wrong' })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await send({ url: server.url, body: [processes, health], token: 'session' })).status, 200);
  assert.equal(calls, 1);
});

test('仅提供 POST /rpc，旧 REST 路由不再执行操作', async (context) => {
  const server = await standalone({ context, home: await temporaryHome(context) });
  const get = await fetch(`${server.url}/rpc`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  for (const path of ['/v1/health', '/v1/credentials', '/v1/login/switch']) {
    assert.equal((await fetch(`${server.url}${path}`)).status, 404);
    const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404);
  }
});
