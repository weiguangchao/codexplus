import { select } from './select.js';
import { stripVTControlCharacters, styleText } from 'node:util';
import type { AccountInfo, QuotaWindow } from '@weiguangchao/codexplus-shared';
import type { Session } from './client.js';
import { BACK, escapable } from './prompts.js';
import { maskEmail, selectTheme, withSpinner } from './ui.js';
import { displayWidth, fit, wrapWords } from './text-layout.js';
import { stepTitle } from './screens.js';
import { glyph } from './terminal-symbols.js';
import type { SelectConfig } from './select-layout.js';

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
const date = (value: string) => new Date(value).toLocaleString('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
});
const plans: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };

const quotaColor = (percent: number) => percent <= 10 ? 'red' : percent <= 25 ? 'yellow' : 'cyan';

function resetText(window: QuotaWindow | null, relative: boolean, now: number): string {
  if (!window?.resetsAt) return '重置时间未提供';
  const minutes = Math.ceil((Date.parse(window.resetsAt) - now) / 60_000);
  return relative ? minutes <= 0 ? '等待重置' : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置` : `${date(window.resetsAt)} 重置`;
}

function renderQuota(label: string, window: QuotaWindow | null, relative: boolean, now: number, columns: number): string {
  if (window === null) return `  ${label}  ${styleText('dim', '未提供')}`;
  const percent = Math.round(window.remainingPercent);
  const width = Math.max(1, Math.min(20, columns - 4));
  const filled = Math.round(window.remainingPercent / 100 * width);
  const color = quotaColor(percent);
  return [
    `  ${label}${' '.repeat(Math.max(2, 14 - displayWidth(label)))}${styleText(color, `剩余 ${percent}%`)}`,
    `  ${styleText(color, '█'.repeat(filled))}${styleText('dim', '░'.repeat(width - filled))}`,
    `  ${styleText('dim', resetText(window, relative, now))}`,
  ].join('\n');
}

export function renderAccountInfo(info: AccountInfo, now = Date.now(), columns = process.stdout.columns || 80): string {
  return [
    stepTitle('账户信息', '当前套餐与剩余额度'),
    `  ${info.email === null ? '无法识别邮箱' : maskEmail(info.email)} ${styleText('green', `${glyph.filled} 当前`)}`,
    '',
    `  ${styleText('dim', '当前套餐')}  ChatGPT ${clean(Object.hasOwn(plans, info.planType) ? plans[info.planType]! : info.planType)}`,
    `  ${styleText('dim', '到期时间')}  ${info.expiresAt === null ? '未提供' : date(info.expiresAt)}`,
    '',
    renderQuota('五小时额度', info.fiveHour, true, now, columns),
    '',
    renderQuota('每周额度', info.weekly, false, now, columns),
  ].join('\n').split('\n').map((line) => line.startsWith('  ')
    ? `  ${wrapWords(line.slice(2), Math.max(1, columns - 2)).replaceAll('\n', '\n  ')}` : wrapWords(line, columns)).join('\n');
}

export function accountInfoConfig(info: AccountInfo, now = Date.now()): SelectConfig<'refresh' | 'back'> {
  return {
    message: (columns) => renderAccountInfo(info, now, columns - 1),
    compactMessage: (columns, _rows, availableRows) => accountSummary(info, columns, availableRows, now),
    choices: [{ value: 'refresh' as const, name: '刷新' }, { value: 'back' as const, name: '返回' }],
    theme: selectTheme('返回'),
  };
}

async function prompt(info: AccountInfo): Promise<'refresh' | 'back' | typeof BACK> {
  return await escapable((context) => select(accountInfoConfig(info), context));
}

export function accountSummary(info: AccountInfo, columns: number, availableRows = 4, now = Date.now()): string {
  const remaining = (window: QuotaWindow | null) => window === null ? styleText('dim', '未提供')
    : styleText(quotaColor(Math.round(window.remainingPercent)), `${Math.round(window.remainingPercent)}%`);
  const plan = clean(Object.hasOwn(plans, info.planType) ? plans[info.planType]! : info.planType);
  const identity = [fit(`账户信息  ${plan}`, columns - 1), info.email === null ? '无法识别邮箱' : maskEmail(info.email)];
  const five = `五小时剩余 ${remaining(info.fiveHour)}`;
  const weekly = `每周剩余 ${remaining(info.weekly)}`;
  const expiry = `到期时间 ${info.expiresAt === null ? '未提供' : date(info.expiresAt)}`;
  const fiveReset = resetText(info.fiveHour, true, now);
  const weeklyReset = resetText(info.weekly, false, now);
  const basic = [...identity, five, weekly].join('\n');
  const rich = [...identity, expiry, five, ...renderQuota('', info.fiveHour, true, now, columns).split('\n').slice(1),
    weekly, ...renderQuota('', info.weekly, false, now, columns).split('\n').slice(1)].join('\n');
  const times = [`${five} · ${fiveReset}`, `${weekly} · ${weeklyReset}`];
  return [rich, [...identity, expiry, ...times].join('\n'), [...identity, ...times].join('\n'), basic]
    .find((value) => wrapWords(value, columns - 1).split('\n').length <= availableRows) ?? basic;
}

export async function accountInfoFlow(store: Pick<Session, 'accountInfo'>, ask = prompt): Promise<void> {
  for (;;) {
    const info = await withSpinner('正在查询当前账户信息…', () => store.accountInfo());
    if (await ask(info) !== 'refresh') return;
  }
}
