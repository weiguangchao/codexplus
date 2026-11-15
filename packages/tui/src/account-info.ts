import { select } from '@inquirer/prompts';
import { stripVTControlCharacters, styleText } from 'node:util';
import type { AccountInfo, QuotaWindow } from '@weiguangchao/codexplus-shared';
import type { Session } from './client.js';
import { BACK, escapable } from './prompts.js';
import { displayWidth, maskEmail, menuTheme, symbols, withSpinner, wrapWords } from './ui.js';

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
const date = (value: string) => new Date(value).toLocaleString('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
});
const plans: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };

function renderQuota(label: string, window: QuotaWindow | null, relative: boolean, now: number, columns: number): string {
  if (window === null) return `  ${label}  ${styleText('dim', '未提供')}`;
  const percent = Math.round(window.remainingPercent);
  const width = Math.max(1, Math.min(20, columns - 4));
  const filled = Math.round(window.remainingPercent / 100 * width);
  let reset = '重置时间未提供';
  if (window.resetsAt !== null) {
    const minutes = Math.ceil((Date.parse(window.resetsAt) - now) / 60_000);
    reset = relative ? minutes <= 0 ? '等待重置' : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置` : `${date(window.resetsAt)} 重置`;
  }
  return [
    `  ${label}${' '.repeat(Math.max(2, 14 - displayWidth(label)))}${styleText('cyan', `剩余 ${percent}%`)}`,
    `  ${styleText('cyan', '█'.repeat(filled))}${styleText('dim', '░'.repeat(width - filled))}`,
    `  ${styleText('dim', reset)}`,
  ].join('\n');
}

export function renderAccountInfo(info: AccountInfo, now = Date.now(), columns = process.stdout.columns || 80): string {
  return [
    `${symbols.info} ${styleText('bold', '账户信息')}`,
    `  ${info.email === null ? '无法识别邮箱' : maskEmail(info.email)} ${styleText('green', '● 当前')}`,
    '',
    `  ${styleText('dim', '当前套餐')}  ChatGPT ${clean(Object.hasOwn(plans, info.planType) ? plans[info.planType]! : info.planType)}`,
    `  ${styleText('dim', '到期时间')}  ${info.expiresAt === null ? '未提供' : date(info.expiresAt)}`,
    '',
    renderQuota('五小时额度', info.fiveHour, true, now, columns),
    '',
    renderQuota('每周额度', info.weekly, false, now, columns),
    '',
  ].join('\n').split('\n').map((line) => line.startsWith('  ')
    ? `  ${wrapWords(line.slice(2), Math.max(1, columns - 2)).replaceAll('\n', '\n  ')}` : wrapWords(line, columns)).join('\n');
}

async function prompt(info: AccountInfo): Promise<'refresh' | 'back' | typeof BACK> {
  return await escapable((context) => select({
    message: renderAccountInfo(info),
    choices: [{ value: 'refresh' as const, name: '刷新' }, { value: 'back' as const, name: '返回' }],
    theme: menuTheme('返回'),
  }, context));
}

export async function accountInfoFlow(store: Pick<Session, 'accountInfo'>, ask = prompt): Promise<void> {
  for (;;) {
    const info = await withSpinner('正在查询当前账户信息…', () => store.accountInfo());
    if (await ask(info) !== 'refresh') return;
  }
}
