import { parseAuth, isRecord, parseEmail, parseUploadFailure, requestService, ServiceError } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAudit, CredentialStore } from '@weiguangchao/codexplus-server';
import { deleteChoices } from '../src/ui.js';
import { account, makeClient, standalone, temporaryHome } from './helpers.js';

for (const broken of [null, '{broken', '{"tokens":{}}']) {
  test(`不可读快照可用 null 删除，字符串摘要冲突（${String(broken)}）`, async (context) => {
    const home = await temporaryHome(context);
    const server = await standalone({ context, home });

    const store = new CredentialStore({ home, request: account });
    const { credential } = await store.add({ auth: parseAuth('{"tokens":{"access_token":"test"}}') });
    const base = await store.digest(credential);
    const path = join(store.credentialsPath, 'codex-person@example.com', 'auth.json');
    if (broken === null) await rm(path);
    else await writeFile(path, broken);
    await assert.rejects(requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, base } }), (error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, 409);
      const failure = parseUploadFailure(error.details);
      assert.ok(failure.code === 'conflict');
      assert.equal(failure.digest, null);
      assert.equal(failure.lastRefresh, null);
      return true;
    });
    await requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, base: null } });
    assert.deepEqual(await store.list(), []);
    const config: unknown = JSON.parse(await readFile(store.configPath, 'utf8'));
    assert.ok(isRecord(config));
    assert.deepEqual(config.credentials, []);
    assert.deepEqual(await readdir(store.credentialsPath), []);
    assert.deepEqual((await readAudit({ home })).map((entry) => entry.event), ['删除']);
  });
}

test('健康快照拒绝 null，删除请求必须提供 base，未注册账号报未找到', async (context) => {
  const home = await temporaryHome(context);
  const server = await standalone({ context, home });

  const store = new CredentialStore({ home, request: account });
  const { credential } = await store.add({ auth: parseAuth('{"tokens":{"access_token":"test"}}') });
  const awaitDigest = await store.digest(credential);
  await assert.rejects(requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, base: null } }), (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 409);
    const failure = parseUploadFailure(error.details);
    assert.equal(failure.code, 'conflict');
    assert.ok(failure.code === 'conflict');
    assert.equal(failure.digest, awaitDigest);
    return true;
  });
  await assert.rejects(requestService({ url: server.url, method: 'credentials.delete', params: credential }), (error) => error instanceof ServiceError && error.status === 400);
  await assert.rejects(requestService({ url: server.url, method: 'credentials.delete', params: { ...credential, email: parseEmail('missing@example.com'), base: null } }), /未找到/u);
  assert.equal((await store.list()).length, 1);
});

test('Session 删除损坏账号，删除菜单显示说明，未列出的账号仍拒绝删除', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ context, userHome });
  const session = await client.connect();
  context.after(() => session.close());
  const source = join(userHome, 'input.json');
  await writeFile(source, '{"tokens":{"access_token":"test"}}');
  const { credential } = await session.add({ path: source });
  await writeFile(join(client.home, 'credentials', 'codex-person@example.com', 'auth.json'), '{broken');
  const credentials = await session.list();
  const choices = deleteChoices({ credentials, digest: (email) => session.snapshotDigest(email) });
  const first = choices[0];
  const healthy = deleteChoices({ credentials, digest: () => 'healthy' })[0];
  assert.ok(first && 'value' in first && healthy && 'value' in healthy);
  assert.equal(first.description, '账号库中的凭证文件缺失或损坏');
  assert.equal(healthy.description, undefined);
  await session.delete(credential);
  assert.deepEqual(await session.list(), []);
  await assert.rejects(session.delete(credential), /账号列表已变化/u);
});
