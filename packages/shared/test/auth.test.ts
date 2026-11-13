import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialDirectory, parseAuth } from '../src/auth.js';

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

test('凭证目录名保留邮箱，拒绝路径字符和超长目录名', () => {
  assert.equal(credentialDirectory('person+codex@example.com'), 'codex-person+codex@example.com');
  const longest = `${'a'.repeat(237)}@example.com`;
  assert.equal(Buffer.byteLength(credentialDirectory(longest)), 255);
  assert.throws(() => credentialDirectory(`a${longest}`), /邮箱无效/u);
  for (const email of ['../person@example.com', '..\\person@example.com', 'person@example.com/../config', 'person', 'a@@b', 'a b@example.com', 'a:b@example.com', 'a\u0000b@example.com', `${'a'.repeat(250)}@example.com`]) {
    assert.throws(() => credentialDirectory(email), /邮箱无效/u);
  }
});
