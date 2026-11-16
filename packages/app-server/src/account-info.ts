import { z } from 'zod';
import type { AccountInfo, AuthTokens, QuotaWindow } from '@weiguangchao/codexplus-shared';

const base = 'https://chatgpt.com/backend-api';
const quotaSchema = z.object({ used_percent: z.number(), reset_at: z.unknown().optional() });
const windowSchema = z.object({ limit_window_seconds: z.unknown().optional(), used_percent: z.unknown().optional(),
  reset_at: z.unknown().optional() }).transform((value) => {
  if (value.limit_window_seconds !== 18_000 && value.limit_window_seconds !== 604_800) return null;
  const result = quotaSchema.safeParse(value);
  if (!result.success) throw new Error('ChatGPT 账户额度信息格式无效。');
  const reset = typeof result.data.reset_at === 'number' && result.data.reset_at > 0 ? new Date(result.data.reset_at * 1000) : null;
  const quota: QuotaWindow = { remainingPercent: Math.max(0, Math.min(100, 100 - result.data.used_percent)),
    resetsAt: reset !== null && Number.isFinite(reset.getTime()) ? reset.toISOString() : null };
  return { duration: value.limit_window_seconds, quota };
});
const usageSchema = z.object({
  plan_type: z.string().refine((value) => value.trim().length > 0),
  email: z.unknown().optional(), account_id: z.unknown().optional(),
  rate_limit: z.object({ primary_window: windowSchema.nullish(), secondary_window: windowSchema.nullish() }).nullish(),
}).transform((value) => {
  let fiveHour: QuotaWindow | null = null;
  let weekly: QuotaWindow | null = null;
  for (const window of [value.rate_limit?.primary_window, value.rate_limit?.secondary_window]) {
    if (window?.duration === 18_000) fiveHour = window.quota;
    else if (window?.duration === 604_800) weekly = window.quota;
  }
  return { planType: value.plan_type, email: typeof value.email === 'string' ? value.email : null,
    accountId: typeof value.account_id === 'string' ? value.account_id : null, fiveHour, weekly };
});
const subscriptionSchema = z.object({ active_until: z.string().refine((value) => Number.isFinite(Date.parse(value))) });

async function getJson({ tokens, path, request }: { tokens: AuthTokens; path: string; request: typeof fetch }): Promise<unknown> {
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

export async function lookupAccountInfo({ tokens, request = fetch }: { tokens: AuthTokens; request?: typeof fetch | undefined }): Promise<AccountInfo> {
  const parsed = usageSchema.safeParse(await getJson({ tokens, path: '/wham/usage', request }));
  if (!parsed.success) throw new Error('ChatGPT 账户信息格式无效。');
  const { accountId: reportedAccountId, ...info } = parsed.data;
  if (typeof tokens.account_id === 'string' && tokens.account_id && reportedAccountId !== null && reportedAccountId !== tokens.account_id) {
    throw new Error('ChatGPT 返回的账号与当前登录不一致，请重新登录后重试。');
  }
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id : reportedAccountId;
  let expiresAt: string | null = null;
  if (accountId) {
    try {
      const subscription = subscriptionSchema.safeParse(await getJson({ tokens: { ...tokens, account_id: accountId },
        path: `/subscriptions?account_id=${encodeURIComponent(accountId)}`, request }));
      if (subscription.success) expiresAt = new Date(subscription.data.active_until).toISOString();
    } catch { expiresAt = null; }
  }
  return { ...info, expiresAt };
}
