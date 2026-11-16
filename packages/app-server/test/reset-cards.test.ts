import { parseResetRequestId, parseResetCardId } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listResetCards, useResetCard } from '../src/reset-cards.js';

const tokens = { access_token: 'fake-access', account_id: 'fake-account', refresh_token: 'fake-refresh' };
const endpoint = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const card = { id: 'card-1', reset_type: 'codex_rate_limits', status: 'available', granted_at: '2026-01-01T00:00:00Z' };

test('只查询所选账号可用且未到期的卡片，先到期的排在前面，不返回额外资料', async () => {
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, endpoint);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.body, undefined);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(options?.headers, { Authorization: 'Bearer fake-access', Accept: 'application/json', 'ChatGPT-Account-Id': 'fake-account' });
    return Response.json({ credits: [
      { ...card, profile_user_id: 'private-profile' },
      { ...card, id: 'later', expires_at: '2099-02-01T00:00:00Z' },
      { ...card, id: 'earlier', expires_at: '2099-01-01T00:00:00Z', title: 'Weekly + 5 hr', description: 'Full reset' },
      { ...card, id: 'expired', expires_at: '2000-01-01T00:00:00Z' },
      { ...card, id: 'redeemed', status: 'redeemed' },
      { ...card, id: 'redeeming', status: 'redeeming' },
    ], available_count: 4 });
  };
  const cards = await listResetCards({ tokens, request });
  assert.equal(calls, 1);
  assert.deepEqual(cards.map(({ id }) => id), ['earlier', 'later', 'card-1']);
  assert.equal(cards[0]?.description, 'Full reset');
  assert.deepEqual(cards[2], { id: card.id, resetType: card.reset_type, title: null, description: null, grantedAt: card.granted_at, expiresAt: null });
  assert.doesNotMatch(JSON.stringify(cards), /private-profile|fake-access|fake-refresh/u);
});

for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const) {
  test(`使用指定卡片和请求 ID，正确处理结果 ${code}，不自动重试`, async () => {
    let calls = 0;
    const request: typeof fetch = async (url, options) => {
      calls++;
      assert.equal(url, `${endpoint}/consume`);
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      assert.deepEqual(options?.headers, { Authorization: 'Bearer fake-access', Accept: 'application/json', 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(String(options?.body)), { credit_id: 'chosen-card', redeem_request_id: 'same-attempt' });
      return Response.json({ code, windows_reset: 2, credit: { private: 'ignored' } });
    };
    assert.equal(await useResetCard({ tokens: { access_token: tokens.access_token }, cardId: parseResetCardId('chosen-card'), requestId: parseResetRequestId('same-attempt'), request }), code);
    assert.equal(calls, 1);
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} 不泄漏上游响应或 token`, async () => {
    const request: typeof fetch = async () => new Response('fake-secret-response', { status });
    for (const task of [() => listResetCards({ tokens, request }), () => useResetCard({ tokens, cardId: parseResetCardId('card'), requestId: parseResetRequestId('request'), request })]) {
      await assert.rejects(task, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`HTTP ${status}`, 'u'));
        assert.doesNotMatch(error.message, /fake-/u);
        return true;
      });
    }
  });
}

test('网络错误、非 JSON 和未知使用结果提示结果未确认，不重试', async () => {
  for (const response of [new Error('fake-secret'), new Response('not json'), Response.json({ code: 'future_code' }), Response.json({ code: ['reset'] })]) {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      if (response instanceof Error) throw response;
      return response;
    };
    await assert.rejects(useResetCard({ tokens, cardId: parseResetCardId('card'), requestId: parseResetRequestId('request'), request }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /结果未能确认/u);
      assert.doesNotMatch(error.message, /fake-secret/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('无卡片正常返回，列表或有效卡片格式异常不伪造可用卡片', async () => {
  assert.deepEqual(await listResetCards({ tokens, request: async () => Response.json({ credits: [] }) }), []);
  for (const value of [null, {}, { credits: [null] }, { credits: [{ ...card, id: '' }] },
    { credits: [{ ...card, expires_at: 'invalid-date' }] }, { credits: [{ ...card, granted_at: null }] }]) {
    await assert.rejects(listResetCards({ tokens, request: async () => Response.json(value) }), /格式无效/u);
  }
  await assert.rejects(listResetCards({ tokens, request: async () => { throw new Error('fake-secret'); } }), /无法连接 ChatGPT/u);
  await assert.rejects(listResetCards({ tokens, request: async () => new Response('not json') }), /JSON/u);
});
