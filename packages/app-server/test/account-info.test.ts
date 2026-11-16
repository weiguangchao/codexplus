import { parseEmail } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupAccountInfo } from '../src/account-info.js';

const tokens = { access_token: 'fake-access', account_id: 'fake-account', refresh_token: 'never-send-refresh' };
const window = (seconds: number, used = 32) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 1_800_000_000 });
const usage = { email: parseEmail('developer@example.com'), account_id: 'fake-account', plan_type: 'plus',
  rate_limit: { primary_window: window(18_000), secondary_window: window(604_800, 58) } };

test('按当前账号读取实时套餐到期时间及剩余额度，仅发送已有 access token', async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    urls.push(String(url));
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer fake-access');
    assert.equal(headers.get('ChatGPT-Account-Id'), 'fake-account');
    assert.equal(headers.get('User-Agent'), 'codex-cli');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.body, undefined);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(options), /never-send-refresh/u);
    if (String(url).includes('/subscriptions')) {
      assert.equal(headers.get('OpenAI-Beta'), 'codex-1');
      return Response.json({ active_until: '2030-12-15T23:59:00+08:00', token: 'do-not-forward' });
    }
    return Response.json(usage);
  };
  assert.deepEqual(await lookupAccountInfo({ tokens, request }), {
    email: usage.email, planType: 'plus', expiresAt: '2030-12-15T15:59:00.000Z',
    fiveHour: { remainingPercent: 68, resetsAt: new Date(1_800_000_000_000).toISOString() },
    weekly: { remainingPercent: 42, resetsAt: new Date(1_800_000_000_000).toISOString() },
  });
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/subscriptions?account_id=fake-account']);
});

test('按窗口时长分类，只有每周窗口时不误标为五小时，不把其他时长标成五小时', async () => {
  for (const [rate_limit, fiveHour, weekly] of [
    [{ primary_window: window(604_800), secondary_window: window(18_000, 58) }, 42, 68],
    [{ primary_window: window(604_800), secondary_window: null }, null, 68],
    [{ primary_window: window(3600), secondary_window: null }, null, null],
    [null, null, null],
  ] as const) {
    const info = await lookupAccountInfo({ tokens, request: async (url) => Response.json(String(url).includes('/subscriptions') ? {} : { ...usage, rate_limit }) });
    assert.equal(info.fiveHour?.remainingPercent ?? null, fiveHour);
    assert.equal(info.weekly?.remainingPercent ?? null, weekly);
  }
});

test('套餐日期缺失、无效或查询失败时仍返回额度，不回退 JWT、用量窗口或其他过期时间', async () => {
  for (const subscription of [{}, { active_until: null }, { active_until: 'invalid' }, { expires_at: '2030-01-01T00:00:00Z' }, 'http-error', 'network-error', 'invalid-json']) {
    const request: typeof fetch = async (url) => {
      if (!String(url).includes('/subscriptions')) return Response.json({ ...usage, subscription_active_until: '2030-02-01T00:00:00Z' });
      if (subscription === 'http-error') return new Response('fake-secret', { status: 403 });
      if (subscription === 'network-error') throw new Error('fake-secret');
      if (subscription === 'invalid-json') return new Response('<html>fake-secret</html>');
      return Response.json(subscription);
    };
    const info = await lookupAccountInfo({ tokens: { ...tokens, id_token: 'fake-expiry-claim' }, request });
    assert.equal(info.expiresAt, null);
    assert.equal(info.fiveHour?.remainingPercent, 68);
  }
});

test('缺少本机账号 ID 时使用额度接口返回的账号 ID 查询套餐，不猜测账号', async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    urls.push(String(url));
    if (String(url).includes('/subscriptions')) {
      assert.equal(new Headers(options?.headers).get('ChatGPT-Account-Id'), 'fake-account');
      return Response.json({ active_until: null });
    }
    return Response.json(usage);
  };
  await lookupAccountInfo({ tokens: { access_token: 'fake-access' }, request });
  assert.equal(urls.length, 2);
  let calls = 0;
  await lookupAccountInfo({ tokens: { access_token: 'fake-access' }, request: async () => { calls++; return Response.json({ ...usage, account_id: undefined }); } });
  assert.equal(calls, 1);
});

test('拒绝账号不一致、无效用量和异常响应，错误不包含 token 或响应正文', async () => {
  for (const value of [null, {}, { ...usage, account_id: 'other-account' }, { ...usage, rate_limit: 'bad' },
    { ...usage, rate_limit: { primary_window: { ...window(18_000), used_percent: 'fake-secret' } } }]) {
    await assert.rejects(lookupAccountInfo({ tokens, request: async () => Response.json(value) }), /格式无效|不一致/u);
  }
  for (const response of [401, 403, 429, 500, 'network', 'json']) {
    await assert.rejects(lookupAccountInfo({ tokens, request: async () => {
      if (response === 'network') throw new Error('fake-secret');
      return new Response('fake-secret', typeof response === 'number' ? { status: response } : {});
    } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fake-secret|fake-access/u);
      assert.match(error.message, typeof response === 'number' ? new RegExp(`HTTP ${response}`, 'u') : /无法连接|JSON/u);
      return true;
    });
  }
});
