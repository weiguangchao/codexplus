import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEmail, ServiceError, writeAtomic } from '@weiguangchao/codexplus-shared';
import { antigravityEmailLabel } from '../src/antigravity.js';
import { makeClient, temporaryHome } from './helpers.js';

function credential({ email, token, claims = false }: { email: string; token: string; claims?: boolean }): string {
  const id = `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
  return `${JSON.stringify({
    token: { access_token: token, refresh_token: 'fake-agy-refresh', expiry: '2099-01-01T00:00:00Z' },
    ...(claims ? { id_token: id } : { id_token_email: email }),
    auth_method: 'consumer', extra: { keep: true },
  }, null, 2)}\n`;
}

test('本机服务端导入和切换 agy 文件，保留原始内容并只传送元数据', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ userHome, context });
  const first = credential({ email: 'person@example.com', token: 'fake-agy-person' });
  const second = credential({ email: 'other@example.com', token: 'fake-agy-other', claims: true });
  const codex = JSON.stringify({ tokens: { access_token: 'fake-codex' } });
  const responses: string[] = [];
  const fetchService = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await fetchService(...args);
    const body = String(args[1]?.body ?? '');
    if (body.includes('"method":"antigravity.')) responses.push(body, await response.clone().text());
    return response;
  });
  const session = await client.connect();
  const initial = await session.antigravityStatus();
  assert.equal(initial.authPath, join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
  assert.deepEqual(initial.current, { status: 'none', digest: null });
  assert.deepEqual(initial.accounts, []);

  await writeAtomic({ path: initial.authPath, content: first });
  await writeAtomic({ path: session.codexAuthPath, content: codex });
  const { credential: codexAccount } = await session.saveCurrent();
  await writeAtomic({ path: join(userHome, 'second account.json'), content: second });
  const { current } = await session.antigravityStatus();
  assert.equal(current.status, 'valid');
  await session.saveAntigravity({ sourceDigest: current.digest, base: null });
  const other = await session.inspectAntigravity('"~/second account.json"');
  assert.equal(other.email, 'other@example.com');
  await session.saveAntigravity({ path: '"~/second account.json"', sourceDigest: other.digest, base: null });
  assert.equal(await readFile(initial.authPath, 'utf8'), first);

  await session.switchAntigravity({ account: other, currentDigest: current.digest });
  assert.equal(await readFile(initial.authPath, 'utf8'), second);
  await session.close();
  const next = await client.connect();
  const status = await next.antigravityStatus();
  assert.deepEqual(status.current, { status: 'valid', ...other });
  const original = status.accounts.find((account) => account.email === 'person@example.com');
  assert.ok(original);
  await next.switchAntigravity({ account: original, currentDigest: other.digest });
  assert.equal(await readFile(initial.authPath, 'utf8'), first);
  assert.equal(await readFile(next.codexAuthPath, 'utf8'), codex);
  assert.deepEqual(await next.list(), [codexAccount]);
  if (process.platform !== 'win32') assert.equal((await stat(initial.authPath)).mode & 0o777, 0o600);
  assert.ok(responses.length > 0);
  for (const response of responses) assert.doesNotMatch(response, /fake-agy|access_token|refresh_token|id_token/u);
});

test('agy 账号掩码相同的邮箱可以通过不同的本地名或域名前缀区分', () => {
  const alex = parseEmail('alex@acme.com');
  const alice = parseEmail('alic@acme.com');
  const another = parseEmail('alex@alpha.com');
  const bob = parseEmail('bob@example.com');
  const emails = [alex, alice, another, bob];
  assert.deepEqual(emails.map((email) => antigravityEmailLabel(email, emails)), [
    '***@a***（ale…@ac…）', '***@a***（ali…@ac…）', '***@a***（al…）', '***@e***',
  ]);
});

test('agy 文件变化、已保存版本变化或来源格式错误时不会覆盖凭据', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ userHome, context });
  const session = await client.connect();
  const { authPath } = await session.antigravityStatus();
  const path = join(userHome, 'source.json');
  const email = 'other@example.com';
  const initial = credential({ email, token: 'initial' });
  const updated = credential({ email, token: 'refreshed' });
  await writeAtomic({ path, content: initial });
  const original = await session.inspectAntigravity(path);
  await session.saveAntigravity({ path, sourceDigest: original.digest, base: null });
  await writeAtomic({ path, content: updated });
  const next = await session.inspectAntigravity(path);
  const conflict = (error: unknown) => error instanceof ServiceError && error.status === 409;
  await assert.rejects(session.saveAntigravity({ path, sourceDigest: original.digest, base: original.digest }), conflict);
  await assert.rejects(session.saveAntigravity({ path, sourceDigest: next.digest, base: null }), conflict);
  await session.saveAntigravity({ path, sourceDigest: next.digest, base: original.digest });

  await writeAtomic({ path: authPath, content: 'invalid current JSON' });
  await assert.rejects(session.switchAntigravity({ account: next, currentDigest: null }), conflict);
  const { current } = await session.antigravityStatus();
  assert.equal(current.status, 'invalid');
  await assert.rejects(session.switchAntigravity({ account: original, currentDigest: current.digest }), conflict);
  assert.equal(await readFile(authPath, 'utf8'), 'invalid current JSON');
  await writeAtomic({ path, content: JSON.stringify({ tokens: { access_token: 'wrong-provider' } }) });
  await assert.rejects(session.inspectAntigravity(path), /缺少有效的 token/u);
  await session.switchAntigravity({ account: next, currentDigest: current.digest });
  assert.equal(await readFile(authPath, 'utf8'), updated);
});

test('损坏的 agy 账号副本不会阻断其他账号的导入和切换', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ userHome, context });
  const session = await client.connect();
  await mkdir(join(session.home, 'credentials', 'antigravity', 'agy-broken@example.com', 'antigravity-oauth-token'), { recursive: true });
  assert.deepEqual((await session.antigravityStatus()).accounts, []);
  const path = join(userHome, 'valid.json');
  const content = credential({ email: 'valid@example.com', token: 'valid' });
  await writeAtomic({ path, content });
  const account = await session.inspectAntigravity(path);
  await session.saveAntigravity({ path, sourceDigest: account.digest, base: null });
  const { accounts, authPath } = await session.antigravityStatus();
  assert.deepEqual(accounts, [account]);
  await session.switchAntigravity({ account, currentDigest: null });
  assert.equal(await readFile(authPath, 'utf8'), content);
});

test('两个数据目录同时切换同一个 agy 文件时，只有一个请求能使用原摘要', async (context) => {
  const userHome = await temporaryHome(context);
  const open = async (label: string) => {
    const { client } = makeClient({ userHome, home: join(userHome, label), context });
    const session = await client.connect();
    const path = join(userHome, `${label}.json`);
    const content = credential({ email: `${label}@example.com`, token: label });
    await writeAtomic({ path, content });
    const account = await session.inspectAntigravity(path);
    await session.saveAntigravity({ path, sourceDigest: account.digest, base: null });
    return { session, account };
  };
  const stores = await Promise.all([open('first'), open('second')]);
  const { authPath } = await stores[0].session.antigravityStatus();
  await writeAtomic({ path: authPath, content: credential({ email: 'before@example.com', token: 'before' }) });
  const { current: { digest: currentDigest } } = await stores[0].session.antigravityStatus();
  const results = await Promise.allSettled(stores.map(({ session, account }) => session.switchAntigravity({ account, currentDigest })));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.reason instanceof ServiceError && rejected.reason.status === 409);
  const winner = results.findIndex(({ status }) => status === 'fulfilled');
  assert.deepEqual((await stores[0].session.antigravityStatus()).current, { status: 'valid', ...stores.at(winner)?.account });
});

test('agy 凭据按原始字节比较和保存，JSON 解码不会改变文件内容', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ userHome, context });
  const session = await client.connect();
  const email = 'bytes@example.com';
  const content = credential({ email, token: 'byte-token' });
  const raw = (byte: number) => Buffer.concat([
    Buffer.from(content.replace(/\}\s*$/u, ', "extra_bytes": "')),
    Buffer.from([byte]),
    Buffer.from('"}\n'),
  ]);
  const path = join(userHome, 'source.json');
  await writeAtomic({ path, content: raw(0xfe) });
  const original = await session.inspectAntigravity(path);
  await writeAtomic({ path, content: raw(0xff) });
  const account = await session.inspectAntigravity(path);
  assert.notEqual(account.digest, original.digest);
  await assert.rejects(session.saveAntigravity({ path, sourceDigest: original.digest, base: null }), /来源凭据已变化/u);
  await session.saveAntigravity({ path, sourceDigest: account.digest, base: null });
  const savedPath = join(session.home, 'credentials', 'antigravity', `agy-${email}`, 'antigravity-oauth-token');
  assert.deepEqual(await readFile(savedPath), raw(0xff));
  const { authPath } = await session.antigravityStatus();
  await session.switchAntigravity({ account, currentDigest: null });
  assert.deepEqual(await readFile(authPath), raw(0xff));
});

test('非普通的 agy 目标文件会被拒绝，服务端仍可读取 Codex 状态', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient({ userHome, context });
  const session = await client.connect();
  const { authPath } = await session.antigravityStatus();
  const path = join(userHome, 'source.json');
  const email = 'regular@example.com';
  await writeAtomic({ path, content: credential({ email, token: 'regular' }) });
  const account = await session.inspectAntigravity(path);
  await mkdir(join(session.home, 'credentials', 'antigravity', `agy-${email}`, 'antigravity-oauth-token'), { recursive: true });
  await assert.rejects(session.saveAntigravity({ path, sourceDigest: account.digest, base: null }), /必须是普通文件/u);
  await mkdir(authPath, { recursive: true });
  await assert.rejects(session.antigravityStatus(), /必须是普通文件/u);
  await assert.rejects(session.saveAntigravity({ sourceDigest: account.digest, base: null }), /必须是普通文件/u);
  assert.deepEqual(await session.current(), { status: 'none' });
});
