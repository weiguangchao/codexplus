import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeAtomic } from '@weiguangchao/codexplus-shared';
import { LoginState } from '../src/login-state.js';
import { temporaryHome } from './helpers.js';

test('服务端迁移旧客户端配置，仅保留内嵌服务端基线并清除旧连接令牌', async (context) => {
  const home = await temporaryHome(context);
  const authPath = join(home, 'codex', 'auth.json');
  for (const version of [1, 2, 3]) {
    for (const server of ['local', 'http://127.0.0.1:47831', 'https://example.com']) {
      const baseline = { server, email: 'person@example.com', digest: 'baseline' };
      await writeAtomic(join(home, 'client.json'), JSON.stringify({ version, current: server, servers: { [server]: { token: 'old-secret' } }, baseline }));
      const state = new LoginState(home, authPath);
      assert.deepEqual((await state.get()).baseline, server === 'local' ? { email: baseline.email, digest: baseline.digest } : null);
      assert.deepEqual(JSON.parse(await readFile(join(home, 'client.json'), 'utf8')), { version: 4 });
      assert.doesNotMatch(await readFile(join(home, 'login.json'), 'utf8'), /old-secret|https:|servers|current/u);
      await rm(join(home, 'login.json'));
    }
  }
});

test('登录路径改变后不复用其他登录文件的基线和删除记录', async (context) => {
  const home = await temporaryHome(context);
  const state = new LoginState(home, join(home, 'first', 'auth.json'));
  await state.update((value) => {
    value.baseline = { email: 'person@example.com', digest: 'baseline' };
    value.deleted['other@example.com'] = 'deleted';
  });
  const other = await new LoginState(home, join(home, 'second', 'auth.json')).get();
  assert.equal(other.baseline, null);
  assert.deepEqual(other.deleted, {});
});
