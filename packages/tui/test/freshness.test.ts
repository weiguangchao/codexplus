import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { newerRefresh } from '@codexplus/shared';
import { UploadCancelled } from '../src/client.js';
import { mainChoices, refreshDetails, renderStatus } from '../src/ui.js';
import { makeClient, temporaryHome } from './helpers.js';

const email = 'person@example.com';
const idToken = `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const older = '2026-11-01T00:00:00Z';
const newer = '2026-11-10T00:00:00Z';
const auth = (access: string, last_refresh?: unknown) => JSON.stringify({ tokens: { access_token: access, id_token: idToken }, last_refresh });

test('刷新时间按带时区的时间比较，缺失、无效、相同时间都不能推荐覆盖', () => {
  assert.equal(newerRefresh(newer, older), 'local');
  assert.equal(newerRefresh(older, newer), 'server');
  assert.equal(newerRefresh('2026-11-01T08:00:00+08:00', older), null);
  for (const value of [undefined, null, '', 'v1', 123, '2026-11-01T00:00:00', '2026-11-01T99:00:00Z', older]) {
    assert.equal(newerRefresh(value, older), null);
    assert.equal(newerRefresh(older, value), null);
  }
  assert.match(refreshDetails(undefined, undefined), /无法比较哪份更新.*覆盖可能替换仍可用的凭证.*重新登录/u);
  assert.match(refreshDetails(newer, older), /本机刷新时间较晚/u);
});

for (const refresh of [older, undefined, newer]) {
  test(`本机内容变化但时间未更新（${String(refresh)}）时，取消上传保留服务端文件`, async (context) => {
    const userHome = await temporaryHome(context);
    const { client } = makeClient(context, userHome);
    const session = await client.connect();
    await mkdir(join(userHome, '.codex'));
    await writeFile(session.codexAuthPath, auth('saved', newer));
    const { credential } = await session.add(session.codexAuthPath);
    const snapshot = join(client.home, 'credentials', `codex-${email}`, 'auth.json');
    const before = await readFile(snapshot, 'utf8');
    await writeFile(session.codexAuthPath, auth('local-changed', refresh));
    assert.equal((await session.current()).status, 'diverged');
    let confirmations = 0;
    session.confirmUpload = async (details) => {
      confirmations++;
      assert.equal(details.localRefresh, refresh ?? null);
      assert.equal(details.lastRefresh, newer);
      return false;
    };
    await assert.rejects(session.add(session.codexAuthPath), UploadCancelled);
    assert.equal(confirmations, 1);
    assert.equal(await readFile(snapshot, 'utf8'), before);
    assert.equal(mainChoices([credential], await session.current()).choices.some((choice) => 'value' in choice && choice.value === 'update'), false);
    session.confirmUpload = async () => true;
    await session.add(session.codexAuthPath);
    assert.equal(JSON.parse(await readFile(snapshot, 'utf8')).tokens.access_token, 'local-changed');
  });

  test(`服务端内容变化但时间未更新（${String(refresh)}）时，不默认下载覆盖本机`, async (context) => {
    const userHome = await temporaryHome(context);
    const { client } = makeClient(context, userHome);
    const session = await client.connect();
    await mkdir(join(userHome, '.codex'));
    const login = auth('saved', newer);
    await writeFile(session.codexAuthPath, login);
    const { credential } = await session.add(session.codexAuthPath);
    const other = await client.connect();
    const source = join(userHome, 'other.json');
    await writeFile(source, auth('server-changed', refresh));
    other.confirmUpload = async () => true;
    await other.add(source);
    const current = await session.current();
    assert.equal(current.status, 'diverged');
    assert.notEqual(mainChoices([credential], current).default, 'update');
    assert.equal(await readFile(session.codexAuthPath, 'utf8'), login);
  });
}

test('删除当前账号保留本机登录且默认退出，再次保存必须明确确认', async (context) => {
  const userHome = await temporaryHome(context);
  const { client } = makeClient(context, userHome);
  const session = await client.connect();
  await mkdir(join(userHome, '.codex'));
  const login = auth('saved', newer);
  await writeFile(session.codexAuthPath, login);
  const { credential } = await session.add(session.codexAuthPath);
  await session.list();
  await session.delete(credential);
  const current = await session.current();
  assert.deepEqual(current, { status: 'deleted', email });
  assert.match(renderStatus(current, 0), /已从凭证库删除，本机登录保留/u);
  assert.equal(mainChoices([], current).default, 'exit');
  await assert.rejects(session.add(session.codexAuthPath), UploadCancelled);
  session.confirmRestore = async (restoring) => { assert.equal(restoring, email); return false; };
  await assert.rejects(session.add(session.codexAuthPath), UploadCancelled);
  assert.deepEqual(await session.list(), []);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), login);
  session.confirmRestore = async () => true;
  await session.add(session.codexAuthPath);
  assert.deepEqual(await session.list(), [credential]);
  assert.equal((await session.current()).status, 'saved');
});

for (const token of [undefined, 'not-a-jwt']) {
  test(`删除后无法识别已变化的凭证（${String(token)}）时，取消保留删除结果，明确确认才保存`, async (context) => {
    const userHome = await temporaryHome(context);
    const { client } = makeClient(context, userHome);
    const session = await client.connect();
    await mkdir(join(userHome, '.codex'));
    const content = (access: string) => JSON.stringify({ tokens: { access_token: access, id_token: token } });
    await writeFile(session.codexAuthPath, content('v1'));
    const { credential } = await session.add(session.codexAuthPath);
    await session.list();
    const changed = content('v2');
    await writeFile(session.codexAuthPath, changed);
    await session.delete(credential);
    let confirmations = 0;
    session.confirmRestore = async (restoring) => {
      confirmations++;
      assert.equal(restoring, null);
      return false;
    };
    await assert.rejects(session.add(session.codexAuthPath), UploadCancelled);
    assert.equal(confirmations, 1);
    assert.deepEqual(await session.list(), []);
    assert.equal(await readFile(session.codexAuthPath, 'utf8'), changed);
    session.confirmRestore = async () => true;
    await session.add(session.codexAuthPath);
    assert.deepEqual(await session.list(), [credential]);
    assert.equal((await session.current()).status, 'saved');
  });
}
