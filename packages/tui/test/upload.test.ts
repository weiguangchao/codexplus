import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccessStore, readAudit } from '@codexplus/app-server';
import { authDigest, requestService } from '@codexplus/shared';
import type { UploadResult } from '@codexplus/shared';
import { makeClient, standalone, temporaryHome } from './helpers.js';

test('相同内容上传返回未写入且不新增记录，不同内容照常写入和记录', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const { token } = await new AccessStore(home).addClient('测试');
  const upload = async (access: string, base: string | null) => await requestService(server.url, '/v1/credentials', token,
    { auth: { tokens: { access_token: access } }, base }) as UploadResult;
  assert.equal((await upload('v1', null)).changed, true);
  const path = join(home, 'credentials', 'codex-person@example.com.json');
  const before = await stat(path);
  assert.equal((await upload('v1', null)).changed, false);
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  assert.equal((await readAudit(home)).length, 1);
  const base = authDigest(await readFile(path, 'utf8'));
  assert.equal((await upload('v2', base)).changed, true);
  assert.deepEqual((await readAudit(home)).map((entry) => entry.event), ['上传', '上传']);
});

test('Session 返回写入结果，相同的当前登录上传仍保存基线，其他文件不保存基线', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect();
  context.after(() => session.close());
  const source = join(userHome, 'input.json');
  const content = '{"tokens":{"access_token":"test"}}';
  await writeFile(source, content);
  assert.equal((await session.add(source)).changed, true);
  assert.equal((await session.add(source)).changed, false);
  assert.equal((await client.config()).baseline, null);
  await mkdir(join(userHome, '.codex'));
  await writeFile(session.codexAuthPath, content);
  const result = await session.add(session.codexAuthPath);
  assert.equal(result.changed, false);
  assert.deepEqual((await client.config()).baseline, { server: 'local', email: result.credential.email, digest: authDigest(content) });
  assert.equal((await readAudit(client.home)).length, 1);
});
