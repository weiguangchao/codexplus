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

export function credentialDirectory(email: string): string {
  if (
    !/^[^\s@/\\<>:"|?*]+@[^\s@/\\<>:"|?*]+$/u.test(email) ||
    Array.from(email).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    Buffer.byteLength(`codex-${email}`) > 255
  ) {
    throw new Error('账号邮箱无效，无法生成凭证目录名。');
  }
  return `codex-${email}`;
}

export function authDigest(content: string): string {
  return createHash('sha256').update(JSON.stringify(parseAuth(content))).digest('hex');
}
