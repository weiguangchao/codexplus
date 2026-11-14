import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { authDigest } from '@weiguangchao/codexplus-shared';
import { CredentialStore } from '../src/store.js';
import { temporaryHome } from './helpers.js';

const credential = { type: 'codex', email: 'person@example.com' } as const;
const content = '{\n  "tokens": { "access_token": "legacy", "refresh_token": "keep" },\n  "last_refresh": "2026-11-01T00:00:00Z"\n}\n';

async function legacyStore(context: TestContext) {
  const home = await temporaryHome(context);
  const store = new CredentialStore({ home, request: async () => { throw new Error('迁移不应请求账号接口'); } });
  await mkdir(store.credentialsPath, { recursive: true });
  await writeFile(store.configPath, JSON.stringify({ version: 1, credentials: [credential] }));
  const legacy = join(store.credentialsPath, 'codex-person@example.com.json');
  const directory = join(store.credentialsPath, 'codex-person@example.com');
  const destination = join(directory, 'auth.json');
  await writeFile(legacy, content);
  return { home, store, legacy, directory, destination };
}

test('读取旧凭证时迁移到账号目录，保留原内容、摘要和索引', async (context) => {
  const { store, legacy, directory, destination } = await legacyStore(context);
  const config = await readFile(store.configPath, 'utf8');
  assert.deepEqual(await store.snapshots(), [{ ...credential, digest: authDigest(content), lastRefresh: '2026-11-01T00:00:00Z' }]);
  assert.equal(await readFile(destination, 'utf8'), content);
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
  assert.equal(await store.get(credential), content);
  assert.equal(await readFile(store.configPath, 'utf8'), config);
  if (process.platform !== 'win32') {
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  await store.delete(credential, authDigest(content));
  assert.deepEqual(await readdir(store.credentialsPath), []);
});

test('新旧路径同时存在时保留新文件，移除旧文件且不重复改写新文件', async (context) => {
  const { store, legacy, directory, destination } = await legacyStore(context);
  const newer = '{"tokens":{"access_token":"newer"}}';
  await mkdir(directory);
  await writeFile(destination, newer);
  const before = await stat(destination);
  assert.equal(await store.get(credential), newer);
  assert.equal((await stat(destination)).mtimeMs, before.mtimeMs);
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
});

test('损坏的旧凭证迁移后仍可按 null 摘要删除', async (context) => {
  const { store, legacy, destination } = await legacyStore(context);
  await writeFile(legacy, '{broken');
  assert.deepEqual(await store.snapshots(), [{ ...credential, digest: null, lastRefresh: null }]);
  assert.equal(await readFile(destination, 'utf8'), '{broken');
  await store.delete(credential, null);
  assert.deepEqual(await readdir(store.credentialsPath), []);
});

test('迁移目标无法写入时保留旧凭证和索引', async (context) => {
  const { store, legacy, directory } = await legacyStore(context);
  const config = await readFile(store.configPath, 'utf8');
  await writeFile(directory, 'occupied');
  await assert.rejects(store.get(credential));
  assert.equal(await readFile(legacy, 'utf8'), content);
  assert.equal(await readFile(store.configPath, 'utf8'), config);
});
