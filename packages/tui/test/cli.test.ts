import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { usage } from '../src/options.js';
import { temporaryHome } from './helpers.js';

async function run({ root, args }: { root: string; args: string[] }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root,
    CODEX_HOME: join(root, 'codex'), CODEXBAR_CONFIG: join(root, 'codexbar.json'), NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--conditions=source', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
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

test('--help 和 -h 无需 TTY，输出相同帮助且不启动服务端或创建数据', async (context) => {
  const root = await temporaryHome(context);
  for (const flag of ['--help', '-h']) {
    const result = await run({ root, args: [flag] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${usage}\n`);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /codexplus (?:status|list|switch)|--port|--home/u);
  }
  assert.deepEqual(await readdir(root), []);
});

test('旧子命令和启动参数在真实 CLI 中报错，不启动服务端或创建数据', async (context) => {
  const root = await temporaryHome(context);
  for (const args of [
    ['status'], ['list'], ['switch', 'person@example.com'], ['serve'],
    ['--home', join(root, 'vault')], ['--port', '47831'], ['--help', 'status'],
  ]) {
    const result = await run({ root, args });
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /codexplus --help/u);
  }
  assert.deepEqual(await readdir(root), []);
});

test('无参数启动需要交互式终端，失败时不创建数据', async (context) => {
  const root = await temporaryHome(context);
  const result = await run({ root, args: [] });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /交互式终端/u);
  assert.deepEqual(await readdir(root), []);
});
