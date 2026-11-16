import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseAuthDigest } from './identity.js';
import type { AuthDigest, Email } from './identity.js';

export const authSchema = z.object({
  tokens: z.object({
    access_token: z.string().refine((value) => value.trim().length > 0),
    id_token: z.unknown().optional(),
    refresh_token: z.unknown().optional(),
    account_id: z.unknown().optional(),
  }),
  auth_mode: z.unknown().optional(),
  OPENAI_API_KEY: z.unknown().optional(),
  last_refresh: z.unknown().optional(),
});

export type Auth = z.infer<typeof authSchema>;
export type AuthTokens = Auth['tokens'];

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

  const result = authSchema.safeParse(auth);
  if (!result.success) throw new Error('auth.json 缺少 tokens.access_token，请使用通过 ChatGPT 登录生成的凭证。');
  return result.data;
}

export function credentialDirectory(email: Email): string {
  return `codex-${email}`;
}

export function authDigest(auth: Auth): AuthDigest {
  const { tokens } = auth;
  const canonical: Auth = { tokens: { access_token: tokens.access_token, id_token: tokens.id_token,
    refresh_token: tokens.refresh_token, account_id: tokens.account_id },
    auth_mode: auth.auth_mode, OPENAI_API_KEY: auth.OPENAI_API_KEY, last_refresh: auth.last_refresh };
  return parseAuthDigest(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}
