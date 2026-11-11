import { createHash } from 'node:crypto';

export interface AuthTokens {
  access_token: string;
  id_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

export interface Auth {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens: AuthTokens;
  last_refresh?: unknown;
}

export interface Account {
  email: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAuth(content: string): Auth {
  let auth: unknown;
  try {
    auth = JSON.parse(content);
  } catch {
    throw new Error('auth.json 不是有效的 JSON 文件。');
  }

  if (
    !isRecord(auth) ||
    !isRecord(auth.tokens) ||
    typeof auth.tokens.access_token !== 'string' ||
    !auth.tokens.access_token.trim()
  ) {
    throw new Error('auth.json 缺少 tokens.access_token，请使用通过 ChatGPT 登录生成的凭证。');
  }

  const tokens: AuthTokens = { access_token: auth.tokens.access_token };
  for (const key of ['id_token', 'refresh_token', 'account_id'] as const) {
    if (Object.hasOwn(auth.tokens, key)) {
      tokens[key] = auth.tokens[key];
    }
  }
  const filtered: Auth = { tokens };
  for (const key of ['auth_mode', 'OPENAI_API_KEY', 'last_refresh'] as const) {
    if (Object.hasOwn(auth, key)) {
      filtered[key] = auth[key];
    }
  }
  return filtered;
}

export function credentialFilename(email: string): string {
  if (
    !/^[^\s@/\\<>:"|?*]+@[^\s@/\\<>:"|?*]+$/u.test(email) ||
    Array.from(email).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    Buffer.byteLength(`codex-${email}.json`) > 255
  ) {
    throw new Error('账号邮箱无效，无法生成凭证文件名。');
  }
  return `codex-${email}.json`;
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
  credentialFilename(email);
  return { email };
}

export function idTokenEmail(content: string): string | null {
  try {
    const auth: unknown = JSON.parse(content);
    if (!isRecord(auth) || !isRecord(auth.tokens) || typeof auth.tokens.id_token !== 'string') {
      return null;
    }
    const payload = auth.tokens.id_token.split('.')[1];
    if (!payload) {
      return null;
    }
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(claims) && typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : null;
  } catch {
    return null;
  }
}

export function authDigest(content: string): string {
  return createHash('sha256').update(JSON.stringify(parseAuth(content))).digest('hex');
}
