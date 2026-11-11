import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withLock } from '../src/lock.js';
import { AccessStore } from '../src/access.js';
import { requestService } from '../src/protocol.js';
import { standalone, temporaryHome } from './helpers.js';

test('残留锁回收，子进程并发读改写不丢失', async (context) => {
  const home = await temporaryHome(context);
  await writeFile(join(home, '.lock'), JSON.stringify({ time: Date.now() - 31_000 }));
  await withLock(home, () => writeFile(join(home, 'count'), '0'));
  const code = `import { withLock } from ${JSON.stringify(new URL('../src/lock.ts', import.meta.url).href)};
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
for (let i = 0; i < 30; i++) await withLock(${JSON.stringify(home)}, async () => {
const path = ${JSON.stringify(join(home, 'count'))};
await writeFile(path, String(Number(await readFile(path, 'utf8')) + 1));
});`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(await readFile(join(home, 'count'), 'utf8'), '120');
});

test('进程在写入锁内容前崩溃留下的空锁按文件时间回收，新建的空锁不会被抢走', async (context) => {
  const home = await temporaryHome(context);
  const path = join(home, '.lock');
  await writeFile(path, '');
  const old = new Date(Date.now() - 31_000);
  await utimes(path, old, old);
  assert.equal(await withLock(home, async () => 'ok'), 'ok');
  assert.equal((await readdir(home)).includes('.lock'), false);
  await writeFile(path, '');
  const waiting = withLock(home, async () => 'late');
  const winner = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300))]);
  assert.equal(winner, 'still waiting');
  assert.equal(await readFile(path, 'utf8'), '');
  await writeFile(path, JSON.stringify({ time: Date.now() - 31_000 }));
  assert.equal(await waiting, 'late');
});

test('同目录双服务端并发上传保留索引，慢查询不阻塞健康接口', async (context) => {
  const home = await temporaryHome(context);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = await standalone(context, home, 0, async () => { entered(); await gate; return Response.json({ email: 'one@example.com' }); });
  const second = await standalone(context, home, 0, async () => Response.json({ email: 'two@example.com' }));
  const { token } = await new AccessStore(home).addClient('测试');
  const upload = requestService(first.url, '/v1/credentials', token, { auth: { tokens: { access_token: 'one' } }, base: null });
  await started;
  try {
    const health = await fetch(`${first.url}/v1/health`, { signal: AbortSignal.timeout(1_000) });
    assert.equal(health.status, 200);
    await requestService(second.url, '/v1/credentials', token, { auth: { tokens: { access_token: 'two' } }, base: null });
  } finally { release(); }
  await upload;
  const result = await requestService(first.url, '/v1/credentials', token) as { credentials: unknown[] };
  assert.equal(result.credentials.length, 2);
});
