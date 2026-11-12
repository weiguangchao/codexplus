import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CredentialClient } from '../src/client.js';
import { readOptional, PairingCancelled } from '@codexplus/shared';
import { usage } from '../src/options.js';
import { startServer } from '@codexplus/app-server';
import { addChoices, mainChoices, renderStatus } from '../src/ui.js';
import { account, makeClient, pairCode, standalone, temporaryHome } from './helpers.js';

const email = 'person@example.com';
const idToken = `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const login = JSON.stringify({ tokens: { access_token: 'fake-access', id_token: idToken } });

test('CP-007 配对码错误后原地重试成功，成功前不保存配置', async (context) => {
  const userHome = await temporaryHome(context);
  const serverHome = await temporaryHome(context);
  const server = await standalone(context, serverHome);
  const { client } = makeClient(context, userHome);
  let attempts = 0;
  let retried = false;
  const session = await client.connect({
    target: server.url,
    askPairing: async () => ({ code: ++attempts === 1 ? 'invalid-test-code' : await pairCode(server.url, serverHome), name: 'test' }),
    retryPairing: async (message) => {
      assert.match(message, /配对失败/u);
      assert.equal(await readOptional(client.configPath), null);
      retried = true;
      return true;
    },
  });
  await session.close();
  assert.equal(attempts, 2);
  assert.equal(retried, true);
  assert.equal((await client.config()).current, server.url);
});

test('CP-007 配对错误后取消，已有客户端配置保持不变', async (context) => {
  const userHome = await temporaryHome(context);
  const server = await standalone(context, await temporaryHome(context));
  const { client } = makeClient(context, userHome);
  await mkdir(client.home);
  const before = JSON.stringify({ version: 2, current: 'local', servers: {}, baseline: null });
  await writeFile(client.configPath, before);
  let attempts = 0;
  await assert.rejects(client.connect({
    target: server.url,
    askPairing: async () => { attempts++; return { code: 'invalid-test-code', name: 'test' }; },
    retryPairing: async () => false,
  }), PairingCancelled);
  assert.equal(attempts, 1);
  assert.equal(await readFile(client.configPath, 'utf8'), before);
});

test('CP-008 CODEX_HOME 中的登录可识别、上传和切换，默认文件不受影响', async (context) => {
  const userHome = await temporaryHome(context);
  const custom = join(userHome, 'custom codex');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = custom;
  context.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const client = new CredentialClient({ userHome, home: join(userHome, 'vault'), startLocal: (options) => startServer({ ...options, accountRequest: account }) });
  await mkdir(custom);
  await writeFile(join(custom, 'auth.json'), login);
  const session = await client.connect();
  context.after(() => session.close());
  assert.equal(client.codexAuthPath, join(custom, 'auth.json'));
  assert.deepEqual(await session.current(), { status: 'unsaved', email });
  assert.equal(await readOptional(join(userHome, '.codex', 'auth.json')), null);
  const { credential } = await session.add(session.codexAuthPath);
  await mkdir(join(userHome, '.codex'));
  const fallback = '{not-json-default-must-stay';
  await writeFile(join(userHome, '.codex', 'auth.json'), fallback);
  await writeFile(session.codexAuthPath, '{broken-custom');
  await session.switch(credential);
  assert.deepEqual(JSON.parse(await readFile(session.codexAuthPath, 'utf8')), JSON.parse(login));
  assert.equal(await readFile(join(userHome, '.codex', 'auth.json'), 'utf8'), fallback);
  assert.equal((await session.current()).status, 'saved');
});

test('CP-008 空环境变量回退默认目录，~/ 路径按用户目录展开', () => {
  const previous = process.env.CODEX_HOME;
  const userHome = resolve('isolated-user');
  try {
    for (const value of ['', '  ', '~/custom codex']) {
      process.env.CODEX_HOME = value;
      const client = new CredentialClient({ userHome });
      assert.equal(client.codexAuthPath, join(userHome, value.trim() ? 'custom codex' : '.codex', 'auth.json'));
    }
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test('CP-009 区分缺失、无效、不可读和有效未保存，不推荐保存无效文件', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect();
  assert.deepEqual(await session.current(), { status: 'none' });
  await mkdir(join(userHome, '.codex'));
  for (const content of ['{not-json', '{"tokens":{}}', '{"OPENAI_API_KEY":"fake-only"}']) {
    await writeFile(session.codexAuthPath, content);
    const current = await session.current();
    assert.equal(current.status, 'invalid');
    assert.equal(mainChoices([], current).default, 'exit');
    assert.match(renderStatus(current, 0), /登录文件无效.*[\s\S]*重新登录/u);
    const source = addChoices(current)[0];
    assert.ok(source && 'disabled' in source && source.disabled);
    await assert.rejects(session.add(session.codexAuthPath));
    assert.equal(await readFile(session.codexAuthPath, 'utf8'), content);
    assert.deepEqual(await session.list(), []);
  }
  await rm(session.codexAuthPath);
  await mkdir(session.codexAuthPath);
  assert.equal((await session.current()).status, 'invalid');
  await rm(session.codexAuthPath, { recursive: true });
  await writeFile(session.codexAuthPath, login);
  assert.deepEqual(await session.current(), { status: 'unsaved', email });
});

test('CP-008 与 CP-014 提示使用实际登录路径，帮助提前说明登录类型', () => {
  const path = '/custom codex/auth.json';
  assert.match(renderStatus({ status: 'none' }, 0, path), /未找到登录文件：[\s\S]*\/custom codex\/auth.json/u);
  const source = addChoices({ status: 'unsaved', email }, path)[0];
  assert.ok(source && 'description' in source);
  assert.equal(source.description, `${path} · ${email}`);
  const choices = mainChoices([{ type: 'codex', email }], { status: 'behind', email }, path).choices;
  assert.ok(choices.some((choice) => 'description' in choice && choice.description?.includes(path)));
  assert.match(usage, /仅支持 ChatGPT 登录凭证.*API key/u);
  assert.match(usage, /CODEX_HOME/u);
});
