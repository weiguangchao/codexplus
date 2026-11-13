import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccessStore, readAudit, CredentialStore } from '@codexplus/app-server';
import { requestService, ServiceError } from '@codexplus/shared';
import { deleteChoices } from '../src/ui.js';
import { account, makeClient, standalone, temporaryHome } from './helpers.js';

for (const broken of [null, '{broken', '{"tokens":{}}']) {
  test(`不可读快照可用 null 删除，字符串摘要冲突（${String(broken)}）`, async (context) => {
    const home = await temporaryHome(context);
    const server = await standalone(context, home);
    const { token } = await new AccessStore(home).addClient('测试');
    const store = new CredentialStore({ home, request: account });
    const { credential } = await store.add('{"tokens":{"access_token":"test"}}');
    const base = await store.digest(credential);
    const path = join(store.credentialsPath, 'codex-person@example.com', 'auth.json');
    if (broken === null) await rm(path);
    else await writeFile(path, broken);
    await assert.rejects(requestService(server.url, '/v1/credentials/delete', token, { ...credential, base }), (error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 409);
      assert.equal(error.details.digest, null);
      assert.equal(error.details.lastRefresh, null);
      return true;
    });
    await requestService(server.url, '/v1/credentials/delete', token, { ...credential, base: null });
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(JSON.parse(await readFile(store.configPath, 'utf8')).credentials, []);
    assert.deepEqual(await readdir(store.credentialsPath), []);
    assert.deepEqual((await readAudit(home)).map((entry) => entry.event), ['删除']);
  });
}

test('健康快照拒绝 null，删除请求必须提供 base，未注册账号报未找到', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone(context, home);
  const { token } = await new AccessStore(home).addClient('测试');
  const store = new CredentialStore({ home, request: account });
  const { credential } = await store.add('{"tokens":{"access_token":"test"}}');
  const awaitDigest = await store.digest(credential);
  await assert.rejects(requestService(server.url, '/v1/credentials/delete', token, { ...credential, base: null }), (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 409);
    assert.equal(error.details.digest, awaitDigest);
    return true;
  });
  await assert.rejects(requestService(server.url, '/v1/credentials/delete', token, credential), (error) => error instanceof ServiceError && error.status === 400);
  await assert.rejects(requestService(server.url, '/v1/credentials/delete', token, { ...credential, email: 'missing@example.com', base: null }), /未找到/u);
  assert.equal((await store.list()).length, 1);
});

test('Session 删除损坏账号，删除菜单显示说明，未列出的账号仍拒绝删除', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect();
  context.after(() => session.close());
  const source = join(userHome, 'input.json');
  await writeFile(source, '{"tokens":{"access_token":"test"}}');
  const { credential } = await session.add(source);
  await writeFile(join(client.home, 'credentials', 'codex-person@example.com', 'auth.json'), '{broken');
  const credentials = await session.list();
  const choices = deleteChoices(credentials, (email) => session.snapshotDigest(email));
  assert.equal(choices[0]?.description, '服务端保存的凭证文件缺失或损坏');
  assert.equal(deleteChoices(credentials, () => 'healthy')[0]?.description, undefined);
  await session.delete(credential);
  assert.deepEqual(await session.list(), []);
  await assert.rejects(session.delete(credential), /账号列表已变化/u);
});
