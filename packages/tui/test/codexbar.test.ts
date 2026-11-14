import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { credentialDirectory, readOptional, writeAtomic } from '@codexplus/shared';
import { loginState, makeClient, standalone, temporaryHome } from './helpers.js';

async function fixture(context: TestContext, customHome = false) {
  const userHome = await temporaryHome(context);
  const previousEnv = { CODEXBAR_CONFIG: process.env.CODEXBAR_CONFIG, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  delete process.env.CODEXBAR_CONFIG;
  delete process.env.XDG_CONFIG_HOME;
  context.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { client } = makeClient(context, userHome, join(userHome, customHome ? 'saved accounts' : '.codexplus'));
  const credentials = ['a@example.com', 'b@example.com', 'c@example.com'].map((email) => ({ type: 'codex' as const, email }));
  const paths = credentials.map(({ email }) => join(client.home, 'credentials', credentialDirectory(email)));
  await writeAtomic(join(client.home, 'config.json'), JSON.stringify({ version: 1, credentials }));
  for (const [index, path] of paths.entries()) {
    await writeAtomic(join(path, 'auth.json'), JSON.stringify({ tokens: { access_token: `test-${index}` } }));
  }
  return { userHome, client, credentials, paths };
}

test('本地切换动态更新 CodexBar 目录，排除当前账户并保留手动配置', async (context) => {
  const { userHome, client, credentials, paths } = await fixture(context);
  const configPath = join(userHome, '.config', 'codexbar', 'config.json');
  const provider = {
    id: 'codex', enabled: true, codexActiveSource: 'system',
    codexProfileHomePaths: ['~/manual-account', '~/.codexplus/credentials/codex-a@example.com/', paths[1], join(client.home, 'credentials', 'codex-removed@example.com')],
  };
  const config = { version: 1, customSetting: true, providers: [{ id: 'claude', enabled: false }, provider] };
  await writeAtomic(configPath, JSON.stringify(config));
  const session = await client.connect({ log: () => {} });
  context.after(() => session.close());

  const original = await readFile(configPath, 'utf8');
  await assert.rejects(session.switch({ type: 'codex', email: 'missing@example.com' }), /未找到/u);
  assert.equal(await readFile(configPath, 'utf8'), original);
  await session.switch(credentials[0]!);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    ...config, providers: [config.providers[0], { ...provider, codexProfileHomePaths: ['~/manual-account', paths[1], paths[2]] }],
  });
  await session.switch(credentials[1]!);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    ...config, providers: [config.providers[0], { ...provider, codexProfileHomePaths: ['~/manual-account', paths[0], paths[2]] }],
  });
  assert.equal(JSON.parse(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'test-1');
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  const unchanged = await stat(configPath, { bigint: true });
  await session.switch(credentials[1]!);
  assert.equal((await stat(configPath, { bigint: true })).mtimeNs, unchanged.mtimeNs);

  await rm(join(paths[2]!, 'auth.json'));
  await writeAtomic(join(paths[1]!, 'auth.json'), '{broken');
  await session.switch(credentials[0]!);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).providers[1].codexProfileHomePaths, ['~/manual-account']);
});

test('独立本机服务端使用自己的 CodexBar 配置完成同步', async (context) => {
  const { client, credentials, paths } = await fixture(context);
  const configPath = join(client.home, '.config', 'codexbar', 'config.json');
  await writeAtomic(configPath, '{"version":1,"providers":[{"id":"codex","codexProfileHomePaths":["~/manual"]}]}');
  const server = await standalone(context, client.home);
  const session = await client.connect({ port: Number(new URL(server.url).port) });
  context.after(() => session.close());
  await session.switch(credentials[0]!);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).providers[0].codexProfileHomePaths, ['~/manual', paths[1], paths[2]]);
  assert.equal(JSON.parse(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'test-0');
});

test('CodexBar 配置损坏时保留原文件、提示失败，仍完成账户切换', async (context) => {
  const { userHome, client, credentials } = await fixture(context);
  const configPath = join(userHome, '.config', 'codexbar', 'config.json');
  const logs: string[] = [];
  const session = await client.connect({ log: (message) => logs.push(message) });
  context.after(() => session.close());
  for (const content of [
    '{broken',
    '{"version":2,"providers":[]}',
    '{"version":1,"providers":[{"id":"codex","codexProfileHomePaths":[42]}]}',
    '{"version":1,"providers":[{"id":"codex","enabled":"yes"}]}',
    '{"version":1,"providers":[{"id":"codex"},{"id":"claude","enabled":"yes"}]}',
    '{"version":1,"providers":[{"id":"codex"},42]}',
    '{"version":1,"providers":[{"id":"codex"},{}]}',
  ]) {
    await writeAtomic(configPath, content);
    await session.switch(credentials[0]!);
    assert.equal(await readFile(configPath, 'utf8'), content);
    assert.match(logs.pop()!, /账号已切换，但 CodexBar 同步失败.*未被覆盖/u);
    assert.equal(JSON.parse(await readFile(session.codexAuthPath, 'utf8')).tokens.access_token, 'test-0');
    assert.equal((await loginState(client.home)).baseline?.email, credentials[0]!.email);
  }
});

test('自定义数据目录只管理自己的账户目录，缺少列表时也能同步', async (context) => {
  const { userHome, client, credentials, paths } = await fixture(context, true);
  const configPath = join(userHome, '.config', 'codexbar', 'config.json');
  const external = ['~/.codexplus/credentials/codex-other@example.com', join(client.home, 'credentials', 'manual')];
  await writeAtomic(configPath, JSON.stringify({ version: 1, providers: [{ id: 'codex', codexProfileHomePaths: [...external, paths[0]] }] }));
  const session = await client.connect();
  context.after(() => session.close());
  await session.switch(credentials[0]!);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).providers[0].codexProfileHomePaths, [...external, paths[1], paths[2]]);
  await writeAtomic(configPath, '{"version":1,"providers":[{"id":"codex"}]}');
  await session.switch(credentials[0]!);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).providers[0].codexProfileHomePaths, [paths[1], paths[2]]);
});

test('未安装或未配置 CodexBar 时跳过同步，不创建或改写配置', async (context) => {
  const { userHome, client, credentials } = await fixture(context);
  const configPath = join(userHome, '.config', 'codexbar', 'config.json');
  const session = await client.connect();
  context.after(() => session.close());
  await session.switch(credentials[0]!);
  assert.equal(await readOptional(configPath), null);
  assert.equal(await readOptional(join(userHome, '.codexbar', 'config.json')), null);
  for (const content of ['', ' \n\t', '{"version":1,"providers":[{"id":"claude"}]}']) {
    await writeAtomic(configPath, content);
    await session.switch(credentials[1]!);
    assert.equal(await readFile(configPath, 'utf8'), content);
  }
});
