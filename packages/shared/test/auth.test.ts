import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEmail } from '../src/identity.js';
import { authDigest, credentialDirectory, parseAuth } from '../src/auth.js';

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
  assert.equal(credentialDirectory(parseEmail('person+codex@example.com')), 'codex-person+codex@example.com');
  const longest = `${'a'.repeat(237)}@example.com`;
  assert.equal(Buffer.byteLength(credentialDirectory(parseEmail(longest))), 255);
  assert.throws(() => credentialDirectory(parseEmail(`a${longest}`)), /邮箱无效/u);
  for (const email of ['../person@example.com', '..\\person@example.com', 'person@example.com/../config', 'person', 'a@@b', 'a b@example.com', 'a:b@example.com', 'a\u0000b@example.com', `${'a'.repeat(250)}@example.com`]) {
    assert.throws(() => credentialDirectory(parseEmail(email)), /邮箱无效/u);
  }
});

test('凭证摘要兼容已有基线，字段顺序和无关扩展字段不改变摘要', () => {
  const auth = parseAuth(JSON.stringify({ auth_mode: 'chatgpt', last_refresh: '2026-11-01T00:00:00Z',
    extra: 'ignored', OPENAI_API_KEY: null, tokens: { account_id: 'account', refresh_token: 'refresh',
      id_token: 'id', access_token: 'fixture', extra: 'ignored' } }));
  const expected = 'f4a711cc4d48833e7a6ef1dfa543f0ca688e00e4440b976571904b93030c0b86';
  assert.equal(authDigest(auth), expected);
  assert.equal(authDigest({ last_refresh: auth.last_refresh, OPENAI_API_KEY: auth.OPENAI_API_KEY,
    auth_mode: auth.auth_mode, tokens: { account_id: 'account', refresh_token: 'refresh', id_token: 'id', access_token: 'fixture' } }), expected);
});
