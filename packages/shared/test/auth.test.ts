import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialFilename, parseAuth } from '../src/auth.js';

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

test('凭证文件名保留邮箱，拒绝路径字符和超长文件名', () => {
  assert.equal(credentialFilename('person+codex@example.com'), 'codex-person+codex@example.com.json');
  for (const email of ['../person@example.com', '..\\person@example.com', 'person@example.com/../config', 'person', 'a@@b', 'a b@example.com', 'a:b@example.com', 'a\u0000b@example.com', `${'a'.repeat(250)}@example.com`]) {
    assert.throws(() => credentialFilename(email), /邮箱无效/u);
  }
});
