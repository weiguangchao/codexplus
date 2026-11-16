import { z } from 'zod';

export type Email = string & { readonly __brand: 'Email' };
export type AuthDigest = string & { readonly __brand: 'AuthDigest' };
export type BrowserLoginId = string & { readonly __brand: 'BrowserLoginId' };
export type ResetCardId = string & { readonly __brand: 'ResetCardId' };
export type ResetRequestId = string & { readonly __brand: 'ResetRequestId' };

export function isEmail(value: unknown): value is Email {
  return typeof value === 'string' && /^[^\s@/\\<>:"|?*]+@[^\s@/\\<>:"|?*]+$/u.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    Buffer.byteLength(`codex-${value}`) <= 255;
}

export function isAuthDigest(value: unknown): value is AuthDigest {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function isBrowserLoginId(value: unknown): value is BrowserLoginId {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
}

export function isResetCardId(value: unknown): value is ResetCardId {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isResetRequestId(value: unknown): value is ResetRequestId {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseEmail(value: unknown): Email {
  if (!isEmail(value)) throw new Error('账号邮箱无效，无法生成凭证目录名。');
  return value;
}

export function parseAuthDigest(value: unknown): AuthDigest {
  if (!isAuthDigest(value)) throw new Error('凭证摘要格式无效。');
  return value;
}

export function parseBrowserLoginId(value: unknown): BrowserLoginId {
  if (!isBrowserLoginId(value)) throw new Error('浏览器登录标识无效。');
  return value;
}

export function parseResetCardId(value: unknown): ResetCardId {
  if (!isResetCardId(value)) throw new Error('重置卡标识无效。');
  return value;
}

export function parseResetRequestId(value: unknown): ResetRequestId {
  if (!isResetRequestId(value)) throw new Error('重置请求标识无效。');
  return value;
}

export const emailSchema = z.custom<Email>(isEmail, '账号邮箱无效，无法生成凭证目录名。');
export const authDigestSchema = z.custom<AuthDigest>(isAuthDigest, '凭证摘要格式无效。');
export const browserLoginIdSchema = z.custom<BrowserLoginId>(isBrowserLoginId, '浏览器登录标识无效。');
export const resetCardIdSchema = z.custom<ResetCardId>(isResetCardId, '重置卡标识无效。');
export const resetRequestIdSchema = z.custom<ResetRequestId>(isResetRequestId, '重置请求标识无效。');
