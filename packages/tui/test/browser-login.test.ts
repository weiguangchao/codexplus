import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { browserLogin, codexCommand } from '../src/browser-login.js';
import { makeClient, temporaryHome } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-login.mjs', import.meta.url));
const quiet = async () => {};

test('Windows 支持独立可执行文件和 npm shim，直接启动 Node 避免遗留 cmd 子进程', async (context) => {
  const home = await temporaryHome(context);
  const npm = join(home, 'npm');
  const script = join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  await writeFile(join(npm, 'codex.cmd'), 'fixture');
  await writeFile(join(npm, 'node_modules', '@openai', 'codex', 'package.json'), '{}');
  await writeFile(script, 'fixture');
  const [command, ...args] = await codexCommand({ Path: npm }, 'win32');
  assert.equal(command, process.execPath);
  assert.deepEqual(await Promise.all(args.map((path) => realpath(path))), [await realpath(script)]);
  await writeFile(join(npm, 'codex.exe'), 'fixture');
  assert.deepEqual(await codexCommand({ PATH: npm }, 'win32'), [join(npm, 'codex.exe')]);
  await assert.rejects(codexCommand({ Path: home }, 'win32'), /安装官方 Codex CLI/u);
});

test('官方协议完成浏览器登录，返回前退出子进程并清理临时目录', async (context) => {
  const home = await temporaryHome(context);
  const record = join(home, 'messages.jsonl');
  const urls: string[] = [];
  let directory = '';
  let processExit: number | null = null;
  const auth = await browserLogin({
    onUrl: (url) => urls.push(url),
    open: quiet,
    launch: (env) => {
      directory = env.CODEX_HOME!;
      assert.notEqual(directory, process.env.CODEX_HOME);
      const child = spawn(process.execPath, [fixture], { env: { ...env, LOGIN_FIXTURE_RECORD: record } });
      child.once('close', (code) => { processExit = code; });
      return child;
    },
  });
  assert.deepEqual(JSON.parse(auth), { auth_mode: 'chatgpt', tokens: { access_token: 'browser-access', refresh_token: 'browser-refresh' } });
  assert.deepEqual(urls, ['https://auth.openai.com/oauth/authorize?fixture=1']);
  const messages = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: unknown });
  assert.deepEqual(messages.slice(1), [
    { method: 'initialize', params: { clientInfo: { name: 'codexplus', title: 'codexplus', version: '0.1.0' } } },
    { method: 'initialized', params: {} },
    { method: 'account/login/start', params: { type: 'chatgpt' } },
  ]);
  assert.equal(processExit, 0);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('匹配 loginId，支持完成通知先于启动响应和手动打开浏览器', async () => {
  const early = await browserLogin({ launch: (env) => spawn(process.execPath, [fixture], { env: { ...env, LOGIN_FIXTURE_MODE: 'early' } }), open: quiet });
  assert.equal(JSON.parse(early).tokens.access_token, 'browser-access');
  let manual = false;
  const auth = await browserLogin({
    launch: (env) => spawn(process.execPath, [fixture], { env }),
    open: async () => { throw new Error('no browser'); },
    onBrowserError: () => { manual = true; },
  });
  assert.ok(manual);
  assert.equal(JSON.parse(auth).tokens.access_token, 'browser-access');
});

test('取消发送官方取消接口，忽略其他 loginId，清理临时目录和子进程', async (context) => {
  const home = await temporaryHome(context);
  const record = join(home, 'messages.jsonl');
  const controller = new AbortController();
  let directory = '';
  let closed = false;
  await assert.rejects(browserLogin({
    signal: controller.signal,
    onUrl: () => { controller.abort(new Error('cancelled')); },
    open: async () => { assert.fail('取消后不应打开浏览器'); },
    launch: (env) => {
      directory = env.CODEX_HOME!;
      const child = spawn(process.execPath, [fixture], { env: { ...env, LOGIN_FIXTURE_MODE: 'pending', LOGIN_FIXTURE_RECORD: record } });
      child.once('close', () => { closed = true; });
      return child;
    },
  }), /cancelled/u);
  assert.ok(closed);
  assert.match(await readFile(record, 'utf8'), /"method":"account\/login\/cancel","params":\{"loginId":"this-login"\}/u);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('登录启动和等待期间均有超时，失败不会接受其他账号的完成通知', async () => {
  for (const mode of ['startup-timeout', 'pending']) {
    let directory = '';
    await assert.rejects(browserLogin({
      launch: (env) => { directory = env.CODEX_HOME!; return spawn(process.execPath, [fixture], { env: { ...env, LOGIN_FIXTURE_MODE: mode } }); },
      open: quiet,
      timeoutMs: 1500,
    }), /超时/u);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('CLI 不可用、授权失败、凭证缺失和格式错误均不返回凭证或泄露原始响应', async () => {
  await assert.rejects(browserLogin({ launch: (env) => spawn('codexplus-missing-test-binary', [], { env }), open: quiet }), /安装官方 Codex CLI/u);
  for (const mode of ['exit', 'rpc-error', 'denied', 'missing-file', 'invalid-file', 'bad-url']) {
    let directory = '';
    await assert.rejects(browserLogin({
      launch: (env) => { directory = env.CODEX_HOME!; return spawn(process.execPath, [fixture], { env: { ...env, LOGIN_FIXTURE_MODE: mode } }); },
      open: quiet,
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /sensitive-response|browser-access|fake-key/u);
      return true;
    });
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('浏览器凭证保存复用冲突确认与重试，保持当前登录和同步基线', async (context) => {
  const home = await temporaryHome(context);
  const { client } = makeClient(context, home);
  const session = await client.connect();
  await session.addAuth(JSON.stringify({ tokens: { access_token: 'first' } }));
  await session.switch({ type: 'codex', email: 'person@example.com' });
  const current = await readFile(session.codexAuthPath, 'utf8');
  const baseline = (await client.config()).baseline;
  const auth = await browserLogin({ launch: (env) => spawn(process.execPath, [fixture], { env }), open: quiet });
  let confirmed = false;
  session.confirmUpload = async () => { confirmed = true; return false; };
  await assert.rejects(session.addAuth(auth), /已取消/u);
  session.confirmUpload = async () => { confirmed = true; return true; };
  const result = await session.addAuth(auth);
  assert.ok(confirmed);
  assert.deepEqual(result.credential, { type: 'codex', email: 'person@example.com' });
  assert.ok(result.changed);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), current);
  assert.deepEqual((await client.config()).baseline, baseline);
});
