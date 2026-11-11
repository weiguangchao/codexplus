import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialFilename, lookupAccount, parseAuth } from '../src/auth.js';

test('读取 ChatGPT token，同时保留可选的账号 ID', () => {
  assert.deepEqual(parseAuth('{"tokens":{"access_token":"fake-access","account_id":"fake-account"}}'), {
    tokens: { access_token: 'fake-access', account_id: 'fake-account' },
  });
  assert.deepEqual(parseAuth('{"tokens":{"access_token":"fake-access"}}'), { tokens: { access_token: 'fake-access' } });
});

test('拒绝无效 JSON、API key 登录和缺失的 access token', () => {
  for (const content of ['{', 'null', '[]', '{"OPENAI_API_KEY":"fake-key"}', '{"tokens":{}}', '{"tokens":{"access_token":" "}}']) {
    assert.throws(() => parseAuth(content), /JSON|tokens.access_token/u);
  }
});

test('使用已有 token 查询账号，不发送 refresh token 或修改 token', async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/me');
    assert.deepEqual(options?.headers, {
      Authorization: 'Bearer fake-access',
      Accept: 'application/json',
      'ChatGPT-Account-Id': 'fake-account',
    });
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options?.body, undefined);
    return Response.json({ email: 'person+codex@example.com', name: 'Person' });
  };

  assert.deepEqual(await lookupAccount({ access_token: 'fake-access', account_id: 'fake-account' }, request), {
    email: 'person+codex@example.com',
  });
});

test('无账号 ID 时只发送 bearer token', async () => {
  const request: typeof fetch = async (_url, options) => {
    assert.deepEqual(options?.headers, { Authorization: 'Bearer fake-access', Accept: 'application/json' });
    return Response.json({ email: 'person@example.com' });
  };
  await lookupAccount({ access_token: 'fake-access' }, request);
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} 时提供错误信息且不暴露响应或 token`, async () => {
    const request: typeof fetch = async () => new Response('fake-secret-in-response', { status });
    await assert.rejects(lookupAccount({ access_token: 'fake-secret-token' }, request), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`, 'u'));
      assert.doesNotMatch(error.message, /fake-secret/u);
      return true;
    });
  });
}

test('网络失败时不暴露底层错误中的 token', async () => {
  const request: typeof fetch = async () => { throw new Error('fake-secret-token'); };
  await assert.rejects(lookupAccount({ access_token: 'fake-secret-token' }, request), /无法连接 ChatGPT/u);
});

test('拒绝非 JSON 响应和缺少邮箱的响应', async () => {
  const invalidJson: typeof fetch = async () => new Response('<html>blocked</html>');
  await assert.rejects(lookupAccount({ access_token: 'fake-access' }, invalidJson), /JSON/u);
  for (const value of [null, [], {}, { email: 42 }, { user: { email: 'person@example.com' } }]) {
    const request: typeof fetch = async () => Response.json(value);
    await assert.rejects(lookupAccount({ access_token: 'fake-access' }, request), /未返回邮箱/u);
  }
});

test('凭证文件名保留邮箱，拒绝路径字符和超长文件名', () => {
  assert.equal(credentialFilename('person+codex@example.com'), 'codex-person+codex@example.com.json');
  for (const email of ['../person@example.com', '..\\person@example.com', 'person@example.com/../config', 'person', 'a@@b', 'a b@example.com', 'a:b@example.com', 'a\u0000b@example.com', `${'a'.repeat(250)}@example.com`]) {
    assert.throws(() => credentialFilename(email), /邮箱无效/u);
  }
});
