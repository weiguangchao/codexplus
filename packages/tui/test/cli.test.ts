import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CredentialStore } from '@codexplus/app-server';
import { authDigest } from '@codexplus/shared';
import { standalone, temporaryHome } from './helpers.js';

const first = 'a@example.com';
const second = 'b@example.com';
const auth = (email: string, token = email) => JSON.stringify({ tokens: {
  access_token: `fake-access-${token}`,
  id_token: `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`,
}, last_refresh: '2026-11-12T02:00:00Z' });

async function save(home: string, email: string): Promise<void> {
  await new CredentialStore({ home, request: async () => Response.json({ email }) }).add(auth(email));
}

async function login(root: string, content: string): Promise<void> {
  await mkdir(join(root, 'codex'), { recursive: true });
  await writeFile(join(root, 'codex', 'auth.json'), content);
}

async function run(root: string, args: string[], running = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: join(root, 'codex'), CODEXBAR_CONFIG: join(root, 'codexbar.json'), NO_COLOR: '1', CODEXPLUS_TEST_RUNNING: running ? '1' : '0' };
  delete env.FORCE_COLOR;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--import', new URL('./fixtures/cli-processes.mjs', import.meta.url).href,
    '--conditions=source', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--home', join(root, 'vault'), ...args,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('status 和 list 在无 TTY 的真实 CLI 中输出状态和排序列表，不改写登录或输出凭证', async (context) => {
  const root = await temporaryHome(context);
  const home = join(root, 'vault');
  const empty = await run(root, ['list']);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /暂无已保存的账号/u);
  await save(home, second);
  await save(home, first);
  const content = auth(first);
  await login(root, content);
  const status = await run(root, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /运行模式 {2}本地模式/u);
  assert.ok(status.stdout.includes(`数据目录  ${home}`));
  assert.ok(status.stdout.includes(`登录文件  ${join(root, 'codex', 'auth.json')}`));
  assert.match(status.stdout, /当前账号.*a@example.com[\s\S]*已保存.*2 个/u);
  const list = await run(root, ['list']);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout, `${first}  ← 当前\n${second}\n`);
  for (const result of [status, list]) {
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /fake-access|id_token|要做什么/u);
    assert.ok(!result.stdout.includes(String.fromCharCode(27)));
  }
  assert.equal(await readFile(join(root, 'codex', 'auth.json'), 'utf8'), content);
});

test('status 区分未登录、无效文件和未保存，list 仍显示损坏的凭证', async (context) => {
  const root = await temporaryHome(context);
  assert.match((await run(root, ['status'])).stdout, /未登录/u);
  await login(root, '{broken');
  const invalid = await run(root, ['status']);
  assert.equal(invalid.code, 0, invalid.stderr);
  assert.match(invalid.stdout, /登录文件无效/u);
  await login(root, auth(first));
  assert.match((await run(root, ['status'])).stdout, /未保存/u);
  const home = join(root, 'vault');
  await save(home, second);
  await writeFile(join(home, 'credentials', `codex-${second}`, 'auth.json'), '{broken');
  const list = await run(root, ['list']);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout, `${second}  凭证文件缺失或损坏\n`);
});

test('独立本机服务端的 status 和 list 支持无 TTY，服务中断时返回连接错误', async (context) => {
  const root = await temporaryHome(context);
  const serverHome = await temporaryHome(context);
  await save(serverHome, first);
  const server = await standalone(context, serverHome);
  const port = new URL(server.url).port;
  await login(root, auth(first));
  const status = await run(root, ['status', '--port', port]);
  assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.includes(`运行模式  本地模式\n服务地址  ${server.url}`));
  const list = await run(root, ['list', '--port', port]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout, `${first}  ← 当前\n`);
  await server.close();
  for (const command of ['status', 'list']) {
    const failed = await run(root, [command, '--port', port]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /无法连接 codexplus 本机服务端/u);
  }
});

test('旧远程入口在真实 CLI 中直接报错，不写入客户端配置', async (context) => {
  const root = await temporaryHome(context);
  const server = await standalone(context, await temporaryHome(context));
  const result = await run(root, ['list', '--server', server.url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--server 不能用于此命令/u);
  await assert.rejects(readFile(join(root, 'vault', 'client.json')), { code: 'ENOENT' });
});

test('指定账号切换复用实际下载写入和同步基线，不进入菜单', async (context) => {
  const root = await temporaryHome(context);
  const home = join(root, 'vault');
  await save(home, first);
  await save(home, second);
  await login(root, auth(first));
  const result = await run(root, ['switch', second]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已切换到 b@example.com/u);
  assert.doesNotMatch(result.stdout, /要做什么|fake-access/u);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'codex', 'auth.json'), 'utf8')), JSON.parse(auth(second)));
  const config = JSON.parse(await readFile(join(home, 'client.json'), 'utf8'));
  assert.deepEqual(config.baseline, { server: 'local', email: second, digest: authDigest(auth(second)) });
});

test('邮箱精确匹配，未知账号报错，同一已保存账号无需确认或写入', async (context) => {
  const root = await temporaryHome(context);
  await save(join(root, 'vault'), first);
  const content = auth(first);
  await login(root, content);
  const unknown = await run(root, ['switch', 'a']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /未找到已保存的账号/u);
  const same = await run(root, ['switch', first], true);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /无需切换/u);
  assert.equal(await readFile(join(root, 'codex', 'auth.json'), 'utf8'), content);
});

test('未保存、本机更新和版本分歧在无 TTY 时禁止覆盖', async (context) => {
  const root = await temporaryHome(context);
  const home = join(root, 'vault');
  await save(home, first);
  await save(home, second);
  const saved = auth(first);
  const updated = JSON.stringify({ ...JSON.parse(auth(first, 'new')), last_refresh: '2026-11-13T02:00:00Z' });
  for (const { content, baseline } of [
    { content: auth('unsaved@example.com'), baseline: null },
    { content: updated, baseline: null },
    { content: updated, baseline: { server: 'local', email: first, digest: authDigest(saved) } },
  ]) {
    await login(root, content);
    await writeFile(join(home, 'client.json'), JSON.stringify({ version: 2, current: 'local', servers: {}, baseline }));
    const result = await run(root, ['switch', second]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /需要选择或确认.*交互式终端/u);
    assert.equal(await readFile(join(root, 'codex', 'auth.json'), 'utf8'), content);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'credentials', `codex-${first}`, 'auth.json'), 'utf8')), JSON.parse(saved));
  }
});

test('运行中 Codex 在无 TTY 时要求确认并保留当前登录，省略邮箱要求交互选择', async (context) => {
  const root = await temporaryHome(context);
  await save(join(root, 'vault'), first);
  await save(join(root, 'vault'), second);
  const content = auth(first);
  await login(root, content);
  const running = await run(root, ['switch', second], true);
  assert.equal(running.code, 1);
  assert.match(running.stdout, /PID 9876/u);
  assert.match(running.stderr, /需要选择或确认/u);
  assert.equal(await readFile(join(root, 'codex', 'auth.json'), 'utf8'), content);
  for (const args of [[], ['switch']]) {
    const result = await run(root, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /交互式终端/u);
  }
});
