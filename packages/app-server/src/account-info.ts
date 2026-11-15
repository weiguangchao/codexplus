import { isRecord, parseAccountInfo } from '@weiguangchao/codexplus-shared';
import type { AccountInfo, AuthTokens, QuotaWindow } from '@weiguangchao/codexplus-shared';

const base = 'https://chatgpt.com/backend-api';

async function getJson(tokens: AuthTokens, path: string, request: typeof fetch): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'codex-cli' };
  if (typeof tokens.account_id === 'string' && tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  if (path.startsWith('/subscriptions')) headers['OpenAI-Beta'] = 'codex-1';
  let response: Response;
  try {
    response = await request(`${base}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  } catch { throw new Error('无法连接 ChatGPT 账户信息接口，请检查网络后重试。'); }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`ChatGPT 拒绝访问账户信息（HTTP ${response.status}），请在 Codex 中重新登录。`);
  }
  if (!response.ok) throw new Error(`查询账户信息失败，请稍后重试。（HTTP ${response.status}）`);
  try { return await response.json(); } catch { throw new Error('ChatGPT 账户信息接口未返回有效的 JSON 数据。'); }
}

function quota(value: Record<string, unknown>): QuotaWindow {
  if (typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)) throw new Error('ChatGPT 账户额度信息格式无效。');
  const reset = typeof value.reset_at === 'number' && value.reset_at > 0 ? new Date(value.reset_at * 1000) : null;
  return { remainingPercent: Math.max(0, Math.min(100, 100 - value.used_percent)),
    resetsAt: reset !== null && Number.isFinite(reset.getTime()) ? reset.toISOString() : null };
}

export async function lookupAccountInfo(tokens: AuthTokens, request: typeof fetch = fetch): Promise<AccountInfo> {
  const result = await getJson(tokens, '/wham/usage', request);
  if (!isRecord(result) || typeof result.plan_type !== 'string' || !result.plan_type.trim() ||
    !(result.rate_limit == null || isRecord(result.rate_limit))) throw new Error('ChatGPT 账户信息格式无效。');
  if (typeof tokens.account_id === 'string' && tokens.account_id && typeof result.account_id === 'string' && result.account_id !== tokens.account_id) {
    throw new Error('ChatGPT 返回的账号与当前登录不一致，请重新登录后重试。');
  }
  let fiveHour: QuotaWindow | null = null;
  let weekly: QuotaWindow | null = null;
  if (isRecord(result.rate_limit)) {
    for (const value of [result.rate_limit.primary_window, result.rate_limit.secondary_window]) {
      if (value == null) continue;
      if (!isRecord(value)) throw new Error('ChatGPT 账户额度信息格式无效。');
      if (value.limit_window_seconds === 18_000) fiveHour = quota(value);
      else if (value.limit_window_seconds === 604_800) weekly = quota(value);
    }
  }
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id : result.account_id;
  let expiresAt: string | null = null;
  if (typeof accountId === 'string' && accountId) {
    try {
      const subscription = await getJson({ ...tokens, account_id: accountId }, `/subscriptions?account_id=${encodeURIComponent(accountId)}`, request);
      if (isRecord(subscription) && typeof subscription.active_until === 'string' && Number.isFinite(Date.parse(subscription.active_until))) {
        expiresAt = new Date(subscription.active_until).toISOString();
      }
    } catch { expiresAt = null; }
  }
  return parseAccountInfo({ email: typeof result.email === 'string' ? result.email : null,
    planType: result.plan_type, expiresAt, fiveHour, weekly });
}
