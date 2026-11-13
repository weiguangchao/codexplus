import { credentialDirectory, isRecord } from '@codexplus/shared';
import type { AuthTokens } from '@codexplus/shared';

export interface Account {
  email: string;
}

export async function lookupAccount(tokens: AuthTokens, request: typeof fetch = fetch): Promise<Account> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: 'application/json',
  };
  if (typeof tokens.account_id === 'string' && tokens.account_id) {
    headers['ChatGPT-Account-Id'] = tokens.account_id;
  }

  let response: Response;
  try {
    response = await request('https://chatgpt.com/backend-api/me', {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new Error('无法连接 ChatGPT 账号接口，请检查网络后重试。');
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`ChatGPT 拒绝访问（HTTP ${response.status}），请检查凭证是否有效或重新登录后添加。`);
  }
  if (!response.ok) {
    throw new Error(`查询 ChatGPT 账号失败（HTTP ${response.status}），请稍后重试。`);
  }

  let account: unknown;
  try {
    account = await response.json();
  } catch {
    throw new Error('ChatGPT 账号接口未返回有效的 JSON 数据。');
  }
  if (!isRecord(account) || typeof account.email !== 'string') {
    throw new Error('ChatGPT 账号接口未返回邮箱，未保存凭证。');
  }

  const email = account.email.trim();
  credentialDirectory(email);
  return { email };
}
