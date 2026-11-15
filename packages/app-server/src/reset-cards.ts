import { isRecord, parseResetCard, parseResetCardOutcome } from '@weiguangchao/codexplus-shared';
import type { AuthTokens, ResetCard, ResetCardOutcome } from '@weiguangchao/codexplus-shared';

const endpoint = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const uncertain = '重置卡使用结果未能确认，请先查看该账号的用量和重置卡状态，勿直接改用另一张卡。';

async function requestCards(tokens: AuthTokens, request: typeof fetch, body?: { credit_id: string; redeem_request_id: string }): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' };
  if (typeof tokens.account_id === 'string' && tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await request(body === undefined ? endpoint : `${endpoint}/consume`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new Error(body === undefined ? '无法连接 ChatGPT 重置卡接口，请检查网络后重试。' : uncertain);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`ChatGPT 拒绝访问重置卡（HTTP ${response.status}），请重新登录该账号后保存凭证。`);
  }
  if (!response.ok) {
    throw new Error(`${body === undefined ? '查询重置卡失败，请稍后重试。' : uncertain}（HTTP ${response.status}）`);
  }
  try { return await response.json(); } catch {
    throw new Error(body === undefined ? 'ChatGPT 重置卡接口未返回有效的 JSON 数据。' : uncertain);
  }
}

export async function listResetCards(tokens: AuthTokens, request: typeof fetch = fetch): Promise<ResetCard[]> {
  const result = await requestCards(tokens, request);
  if (!isRecord(result) || !Array.isArray(result.credits)) throw new Error('ChatGPT 重置卡列表格式无效。');
  const cards: ResetCard[] = [];
  for (const value of result.credits) {
    if (!isRecord(value) || typeof value.status !== 'string') throw new Error('ChatGPT 重置卡信息格式无效。');
    if (value.status !== 'available') continue;
    const card = parseResetCard({ id: value.id, resetType: value.reset_type, title: value.title ?? null,
      description: value.description ?? null, grantedAt: value.granted_at, expiresAt: value.expires_at ?? null });
    if (card.expiresAt === null || Date.parse(card.expiresAt) > Date.now()) cards.push(card);
  }
  return cards.toSorted((a, b) => (a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)) -
    (b.expiresAt === null ? Infinity : Date.parse(b.expiresAt)) || a.grantedAt.localeCompare(b.grantedAt) || a.id.localeCompare(b.id));
}

export async function useResetCard(tokens: AuthTokens, cardId: string, requestId: string, request: typeof fetch = fetch): Promise<ResetCardOutcome> {
  const result = await requestCards(tokens, request, { credit_id: cardId, redeem_request_id: requestId });
  try {
    return parseResetCardOutcome(isRecord(result) ? result.code : undefined);
  } catch { throw new Error(uncertain); }
}
