import { isRecord } from './auth.js';

export interface ResetCard {
  id: string;
  resetType: string;
  title: string | null;
  description: string | null;
  grantedAt: string;
  expiresAt: string | null;
}

export type ResetCardOutcome = 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed';

export function parseResetCard(value: unknown): ResetCard {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
    typeof value.resetType !== 'string' || !value.resetType.trim() ||
    typeof value.grantedAt !== 'string' || !Number.isFinite(Date.parse(value.grantedAt)) ||
    !(value.expiresAt === null || typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))) ||
    !(value.title === null || typeof value.title === 'string') ||
    !(value.description === null || typeof value.description === 'string')) {
    throw new Error('重置卡信息格式无效。');
  }
  return { id: value.id, resetType: value.resetType, title: value.title, description: value.description,
    grantedAt: value.grantedAt, expiresAt: value.expiresAt };
}

export function parseResetCardOutcome(value: unknown): ResetCardOutcome {
  if (typeof value !== 'string' || !['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(value)) {
    throw new Error('重置卡使用结果格式无效。');
  }
  return value as ResetCardOutcome;
}
