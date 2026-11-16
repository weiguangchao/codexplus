import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authDigest, parseAuth } from '../src/auth.js';
import { parseBrowserStatus, parseCredentialSnapshots, parseCurrentLogin, parseUploadFailure } from '../src/session.js';

test('登录状态在入口验证所需字段，忽略扩展字段且不接受未知状态', () => {
  assert.deepEqual(parseCurrentLogin({ current: { status: 'none', future: true } }), { status: 'none' });
  assert.deepEqual(parseCurrentLogin({ current: { status: 'unsaved', email: null } }), { status: 'unsaved', email: null });
  for (const current of [{ status: 'saved' }, { status: 'invalid' }, { status: 'saved', email: '../a@example.com' }, { status: 'future' }]) {
    assert.throws(() => parseCurrentLogin({ current }), /格式无效/u);
  }
});

test('凭证快照在解析时拒绝不完整列表和无效摘要，损坏凭证保留 null', () => {
  const credential = { type: 'codex', email: 'person@example.com' };
  const snapshot = { ...credential, digest: authDigest(parseAuth('{"tokens":{"access_token":"fixture"}}')), lastRefresh: null };
  assert.deepEqual(parseCredentialSnapshots({ credentials: [{ ...snapshot, future: true }] }), [snapshot]);
  assert.deepEqual(parseCredentialSnapshots({ credentials: [{ ...snapshot, digest: null }] }), [{ ...snapshot, digest: null }]);
  for (const entry of [credential, { ...snapshot, digest: 'invalid' }, { ...snapshot, lastRefresh: 123 }]) {
    assert.throws(() => parseCredentialSnapshots({ credentials: [entry] }), /格式无效/u);
  }
});

test('浏览器登录错误必须携带错误，上传冲突必须携带经过验证的身份和摘要', () => {
  assert.throws(() => parseBrowserStatus({ status: 'error', url: '', manual: false }), /状态无效/u);
  assert.deepEqual(parseBrowserStatus({ status: 'complete', url: '', manual: false, future: true }),
    { status: 'complete', url: '', manual: false });
  assert.throws(() => parseUploadFailure({ code: 'conflict', email: 'person@example.com', digest: 'invalid', lastRefresh: null }));
  assert.deepEqual(parseUploadFailure({ code: 'restore_required', email: null, future: true }), { code: 'restore_required', email: null });
});
