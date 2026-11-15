import { select } from '@inquirer/prompts';
import { stripVTControlCharacters, styleText } from 'node:util';
import type { Credential, ResetCard } from '@weiguangchao/codexplus-shared';
import type { Session } from './client.js';
import { BACK, escapable } from './prompts.js';
import { maskEmail, report, selectTheme, symbols, withSpinner } from './ui.js';

interface ResetCardPrompts {
  account(credentials: Credential[]): Promise<Credential | null | typeof BACK>;
  card(credential: Credential, cards: ResetCard[]): Promise<ResetCard | null | typeof BACK>;
  confirm(credential: Credential, card: ResetCard): Promise<boolean | typeof BACK>;
}

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });

export function resetCardName(card: ResetCard, index?: number): string {
  const title = clean(card.title ?? '') || (card.resetType === 'codex_rate_limits' ? 'Codex 额度重置' : clean(card.resetType));
  if (index === undefined) return title;
  return `${index + 1}. ${title} · 过期时间：${card.expiresAt === null ? '未提供' : date(card.expiresAt)}`;
}

export function resetCardDetails(card: ResetCard): string {
  return [card.description === null ? '' : clean(card.description), `获得时间：${date(card.grantedAt)}`,
    card.expiresAt === null ? '到期时间：未提供' : `到期时间：${date(card.expiresAt)}`].filter(Boolean).join(' · ');
}

const prompts: ResetCardPrompts = {
  account: async (credentials) => await escapable((context) => select({
    message: '为哪个账号使用 Codex 重置卡？',
    choices: [...credentials.map((credential) => ({ value: credential as Credential | null, name: maskEmail(credential.email) })),
      { value: null, name: '返回', description: '回到主菜单' }],
    theme: selectTheme('返回'),
    pageSize: 10,
  }, context)),
  card: async (credential, cards) => await escapable((context) => select({
    message: `为 ${styleText('cyan', maskEmail(credential.email))} 选择重置卡`,
    choices: [...cards.map((card, index) => ({ value: card as ResetCard | null, name: resetCardName(card, index), description: resetCardDetails(card) })),
      { value: null, name: '返回', description: '重新选择账号' }],
    theme: selectTheme('返回'),
    pageSize: 10,
  }, context)),
  confirm: async (credential, card) => await escapable((context) => select({
    message: `确认为 ${styleText('cyan', maskEmail(credential.email))} 使用「${resetCardName(card)}」？\n  ${resetCardDetails(card)}\n  ${styleText('yellow', '确认后将消耗这张重置卡，无法撤销。')}`,
    choices: [{ value: false, name: '取消', description: '返回重置卡列表' },
      { value: true, name: '使用重置卡', description: '消耗所选重置卡，重置该账号符合条件的用量' }],
    default: false,
    theme: selectTheme('取消'),
  }, context)),
};

export async function resetCardFlow(store: Pick<Session, 'resetCards' | 'useResetCard'>, credentials: Credential[], ask = prompts): Promise<void> {
  if (credentials.length === 0) {
    report(symbols.info, '还没有保存的账号，请先添加。');
    return;
  }
  for (;;) {
    const account = await ask.account(credentials);
    if (account === BACK || account === null) return;
    const cards = await withSpinner('正在查询该账号的 Codex 重置卡…', () => store.resetCards(account));
    if (cards.length === 0) {
      report(symbols.info, `${maskEmail(account.email)} 暂无可用的 Codex 重置卡。`);
      continue;
    }
    for (;;) {
      const card = await ask.card(account, cards);
      if (card === BACK || card === null) break;
      if (await ask.confirm(account, card) !== true) continue;
      const outcome = await withSpinner('正在使用所选 Codex 重置卡…', () => store.useResetCard(account, card.id));
      if (outcome === 'reset') report(symbols.success, `已为 ${styleText('bold', maskEmail(account.email))} 使用重置卡`, '用量可能需要稍等片刻才会更新。');
      else if (outcome === 'already_redeemed') report(symbols.info, '这次请求此前已成功使用重置卡。', '请查看该账号的最新用量。');
      else if (outcome === 'nothing_to_reset') report(symbols.info, '该账号当前没有符合条件的用量可重置，未消耗重置卡。');
      else report(symbols.warning, '所选账号或重置卡已无可用次数，请重新查询。');
      return;
    }
  }
}
