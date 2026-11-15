import { isRecord } from './auth.js';

export interface QuotaWindow {
  remainingPercent: number;
  resetsAt: string | null;
}

export interface AccountInfo {
  email: string | null;
  planType: string;
  expiresAt: string | null;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
}

const date = (value: unknown): value is string | null => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));

function parseWindow(value: unknown): QuotaWindow | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.remainingPercent !== 'number' || !Number.isFinite(value.remainingPercent) ||
    value.remainingPercent < 0 || value.remainingPercent > 100 || !date(value.resetsAt)) {
    throw new Error('账户额度信息格式无效。');
  }
  return { remainingPercent: value.remainingPercent, resetsAt: value.resetsAt };
}

export function parseAccountInfo(value: unknown): AccountInfo {
  if (!isRecord(value) || !(value.email === null || typeof value.email === 'string') ||
    typeof value.planType !== 'string' || !value.planType.trim() || !date(value.expiresAt)) {
    throw new Error('账户信息格式无效。');
  }
  return { email: value.email, planType: value.planType, expiresAt: value.expiresAt,
    fiveHour: parseWindow(value.fiveHour), weekly: parseWindow(value.weekly) };
}
