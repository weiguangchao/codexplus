import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CredentialStore } from '../src/store.js';

const original = '{\n  "tokens": {"access_token": "fake-access", "refresh_token": "fake-refresh", "id_token": "fake-id", "extra": true},\n  "last_refresh": "2026-11-11T00:00:00Z",\n  "extra": true\n}\n';
const filtered = `${JSON.stringify({
  tokens: { access_token: 'fake-access', id_token: 'fake-id', refresh_token: 'fake-refresh' },
  last_refresh: '2026-11-11T00:00:00Z',
}, null, 2)}\n`;
const account: typeof fetch = async () => Response.json({ email: 'person@example.com' });

async function temporaryHome(context: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-test-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('添加凭证时过滤顶层和 tokens 的额外字段，缺失字段不补齐，源文件不变', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);

  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.add(source), { type: 'codex', email: 'person@example.com' });
  assert.equal(await readFile(join(store.credentialsPath, 'codex-person@example.com.json'), 'utf8'), filtered);
  assert.equal(await readFile(source, 'utf8'), original);
  assert.deepEqual(JSON.parse(await readFile(store.configPath, 'utf8')), {
    version: 1,
    credentials: [{ type: 'codex', email: 'person@example.com' }],
  });
  await assert.rejects(stat(store.codexAuthPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(store.credentialsPath), ['codex-person@example.com.json']);
});

for (const fields of [
  {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: 'fake-id', access_token: 'fake-access', refresh_token: 'fake-refresh', account_id: 'fake-account' },
    last_refresh: '2026-11-11T00:00:00Z',
  },
  {
    auth_mode: null,
    OPENAI_API_KEY: null,
    tokens: { id_token: null, access_token: 'fake-access', refresh_token: null, account_id: null },
    last_refresh: null,
  },
]) {
  test(`白名单字段保留原值，包括 null（auth_mode=${String(fields.auth_mode)}）`, async (context) => {
    const home = await temporaryHome(context);
    const source = join(home, 'input.json');
    await writeFile(source, JSON.stringify({
      ...fields,
      extra: { nested: true },
      tokens: { ...fields.tokens, extra: 'discarded' },
    }));
    const request: typeof fetch = async (_url, options) => {
      assert.deepEqual(options?.headers, {
        Authorization: 'Bearer fake-access',
        Accept: 'application/json',
        ...(fields.tokens.account_id === null ? {} : { 'ChatGPT-Account-Id': fields.tokens.account_id }),
      });
      return Response.json({ email: 'person@example.com' });
    };
    const store = new CredentialStore(home, request);
    await store.add(source);
    assert.deepEqual(JSON.parse(await readFile(join(store.credentialsPath, 'codex-person@example.com.json'), 'utf8')), fields);
  });
}

test('重复添加同一邮箱时更新文件，配置中不重复注册', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  const store = new CredentialStore(home, account);
  await writeFile(source, original);
  await store.add(source);
  const replacement = '{"tokens":{"access_token":"fake-new-access","custom":"discarded"},"custom":"discarded"}\n';
  await writeFile(source, replacement);
  await store.add(source);

  assert.deepEqual(JSON.parse(await readFile(join(store.credentialsPath, 'codex-person@example.com.json'), 'utf8')), {
    tokens: { access_token: 'fake-new-access' },
  });
  assert.deepEqual(await store.list(), [{ type: 'codex', email: 'person@example.com' }]);
});

test('支持空格路径和 ~/ 路径，列出多个邮箱供切换', async (context) => {
  const home = await temporaryHome(context);
  await writeFile(join(home, 'auth with spaces.json'), original);
  let email = 'z@example.com';
  const request: typeof fetch = async () => Response.json({ email });
  const store = new CredentialStore(home, request);
  await store.add('~/auth with spaces.json');
  email = 'a@example.com';
  await store.add(join(home, 'auth with spaces.json'));
  assert.deepEqual(await store.list(), [
    { type: 'codex', email: 'a@example.com' },
    { type: 'codex', email: 'z@example.com' },
  ]);
});

test('缺失文件或无效 auth 不会发起请求，也不会创建配置', async (context) => {
  const home = await temporaryHome(context);
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return Response.json({ email: 'person@example.com' }); };
  const store = new CredentialStore(home, request);
  await assert.rejects(store.add(''), /文件路径/u);
  await assert.rejects(store.add(join(home, 'missing.json')), { code: 'ENOENT' });
  const source = join(home, 'invalid.json');
  await writeFile(source, '{"OPENAI_API_KEY":"fake-key"}');
  await assert.rejects(store.add(source), /access_token/u);
  assert.equal(calls, 0);
  await assert.rejects(stat(store.configPath), { code: 'ENOENT' });
});

test('查询失败时不更改已有凭证和配置', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);
  await store.add(source);
  const configBefore = await readFile(store.configPath, 'utf8');
  await writeFile(source, '{"tokens":{"access_token":"fake-expired"}}');
  const denied: typeof fetch = async () => new Response(null, { status: 401 });
  await assert.rejects(new CredentialStore(home, denied).add(source), /HTTP 401/u);
  assert.equal(await readFile(store.configPath, 'utf8'), configBefore);
  assert.equal(await readFile(join(store.credentialsPath, 'codex-person@example.com.json'), 'utf8'), filtered);
});

test('接口返回危险邮箱时不创建存储目录', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const request: typeof fetch = async () => Response.json({ email: '../person@example.com' });
  const store = new CredentialStore(home, request);
  await assert.rejects(store.add(source), /邮箱无效/u);
  await assert.rejects(stat(store.credentialsPath), { code: 'ENOENT' });
});

test('配置损坏时拒绝覆盖配置和凭证', async (context) => {
  const home = await temporaryHome(context);
  const store = new CredentialStore(home, account);
  await mkdir(join(home, '.codexplus'));
  await writeFile(store.configPath, '{broken-config');
  const source = join(home, 'input.json');
  await writeFile(source, original);
  await assert.rejects(store.list(), /配置/u);
  await assert.rejects(store.add(source), /配置/u);
  assert.equal(await readFile(store.configPath, 'utf8'), '{broken-config');
  await assert.rejects(stat(store.credentialsPath), { code: 'ENOENT' });
});

test('配置中的路径穿越邮箱不会被用于读取文件', async (context) => {
  const home = await temporaryHome(context);
  const store = new CredentialStore(home, account);
  await mkdir(join(home, '.codexplus'));
  await writeFile(store.configPath, JSON.stringify({ version: 1, credentials: [{ type: 'codex', email: '../a@example.com' }] }));
  await assert.rejects(store.list(), /配置/u);
});

test('配置提交失败时撤回新添加的凭证', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const request: typeof fetch = async () => {
    await mkdir(join(home, '.codexplus', 'config.json'), { recursive: true });
    return Response.json({ email: 'person@example.com' });
  };
  const store = new CredentialStore(home, request);
  await assert.rejects(store.add(source));
  assert.deepEqual(await readdir(store.credentialsPath), []);
  assert.deepEqual(await readdir(join(home, '.codexplus')), ['config.json', 'credentials']);
});

test('配置提交失败时恢复同邮箱的原始凭证', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);
  await store.add(source);
  await writeFile(source, '{"tokens":{"access_token":"fake-replacement"}}');
  const request: typeof fetch = async () => {
    await rm(store.configPath);
    await mkdir(store.configPath);
    return Response.json({ email: 'person@example.com' });
  };
  await assert.rejects(new CredentialStore(home, request).add(source));
  assert.equal(await readFile(join(store.credentialsPath, 'codex-person@example.com.json'), 'utf8'), filtered);
});

test('切换账号时离线原样覆盖 ~/.codex/auth.json', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);
  const credential = await store.add(source);
  await mkdir(join(home, '.codex'));
  await writeFile(store.codexAuthPath, '{"previous":true}');
  const noNetwork: typeof fetch = async () => { throw new Error('切换不应请求网络'); };
  await new CredentialStore(home, noNetwork).switch(credential);
  assert.equal(await readFile(store.codexAuthPath, 'utf8'), filtered);
  assert.deepEqual(await readdir(join(home, '.codex')), ['auth.json']);
});

test('首次切换时创建 ~/.codex 目录', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);
  await store.switch(await store.add(source));
  assert.equal(await readFile(store.codexAuthPath, 'utf8'), filtered);
});

test('缺失、损坏或未注册的凭证不会覆盖当前登录', async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);
  const credential = await store.add(source);
  await store.switch(credential);
  await assert.rejects(store.switch({ type: 'codex', email: 'unknown@example.com' }), /未找到/u);
  const savedPath = join(store.credentialsPath, 'codex-person@example.com.json');
  await writeFile(savedPath, '{"broken":true}');
  await assert.rejects(store.switch(credential), /access_token/u);
  assert.equal(await readFile(store.codexAuthPath, 'utf8'), filtered);
  await rm(savedPath);
  await assert.rejects(store.switch(credential), { code: 'ENOENT' });
  assert.equal(await readFile(store.codexAuthPath, 'utf8'), filtered);
});

test('Unix 上的凭证和配置权限为 0600，新增目录为 0700', { skip: process.platform === 'win32' }, async (context) => {
  const home = await temporaryHome(context);
  const source = join(home, 'input.json');
  await writeFile(source, original);
  const store = new CredentialStore(home, account);
  await store.switch(await store.add(source));
  for (const path of [store.configPath, store.codexAuthPath, join(store.credentialsPath, 'codex-person@example.com.json')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  for (const path of [join(home, '.codexplus'), store.credentialsPath, join(home, '.codex')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
});
