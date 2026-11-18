import { isRecord, parseUploadFailure, ServiceError } from '@weiguangchao/codexplus-shared';
import type { AntigravityAccount, AntigravityStatus, AuthDigest, Email } from '@weiguangchao/codexplus-shared';
import { pathInput } from './path-input.js';
import { BACK, escapable, isCancel } from './prompts.js';
import { stepTitle } from './screens.js';
import { select } from './select.js';
import { maskEmail, maskHomePath, report, selectTheme, symbols } from './ui.js';
import type { Session } from './client.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function distinctPrefix(value: string, peers: string[]): string {
  let prefix = '';
  for (const character of value) {
    prefix += character;
    if (prefix !== value && peers.every((peer) => !peer.startsWith(prefix))) return `${prefix}…`;
  }
  return value;
}

export function antigravityEmailLabel(email: Email, emails: Email[]): string {
  const masked = maskEmail(email);
  const peers = emails.filter((other) => other !== email && maskEmail(other) === masked);
  if (peers.length === 0) return masked;

  const at = email.indexOf('@');
  const domain = email.slice(at + 1);
  const domains = peers.map((other) => other.slice(other.indexOf('@') + 1));
  const sameDomain = peers.filter((other) => other.endsWith(`@${domain}`)).map((other) => other.slice(0, other.indexOf('@')));
  const local = sameDomain.length ? `${distinctPrefix(email.slice(0, at), sameDomain)}@` : '';
  return `${masked}（${local}${distinctPrefix(domain, domains.filter((other) => other !== domain))}）`;
}

async function save({ store, account, path }: { store: Session; account: AntigravityAccount; path?: string }): Promise<boolean> {
  let base: AuthDigest | null = null;
  for (;;) {
    try {
      await store.saveAntigravity({ path, sourceDigest: account.digest, base });
      report({ symbol: symbols.success, text: `已保存 ${maskEmail(account.email)}` });
      return true;
    } catch (error) {
      if (!(error instanceof ServiceError) || error.status !== 409 || !isRecord(error.details) || error.details.code !== 'conflict') throw error;
      const conflict = parseUploadFailure(error.details);
      if (conflict.code !== 'conflict') throw error;
      const confirmed = await escapable((context) => select({ config: {
        message: stepTitle('Antigravity CLI', `覆盖已保存的 ${maskEmail(account.email)}？`),
        choices: [{ value: false, name: '取消' }, { value: true, name: '覆盖' }],
        default: false, theme: selectTheme('取消'),
      }, context }));
      if (confirmed !== true) return false;
      base = conflict.digest;
    }
  }
}

async function importFile(store: Session): Promise<void> {
  const inspection: { account?: AntigravityAccount } = {};
  const path = await escapable((context) => pathInput({
    initial: '', fileName: 'antigravity-oauth-token',
    validate: async (value) => {
      if (!value.trim()) return '请输入凭据文件路径。';
      try {
        inspection.account = await store.inspectAntigravity(value);
        return true;
      } catch (error) { return message(error); }
    },
  }, context));
  if (path !== BACK && inspection.account) await save({ store, account: inspection.account, path });
}

async function switchAccount({ store, current, accounts, label }: { store: Session; label(email: Email): string } & Pick<AntigravityStatus, 'current' | 'accounts'>): Promise<void> {
  const active = current.status === 'valid' ? current : null;
  const target = await escapable((context) => select({ config: {
    message: stepTitle('Antigravity CLI', '选择要切换到的账号'),
    choices: [
      ...accounts.map((account) => ({
        value: account, name: label(account.email),
        disabled: account.digest === active?.digest ? '● 当前' : false,
      })),
      { value: null, name: '返回' },
    ],
    default: accounts.find((account) => account.digest !== active?.digest) ?? null,
    searchable: true, theme: selectTheme('返回'),
  }, context }));
  if (target === BACK || target === null) return;
  const needsSave = active !== null && !accounts.some((account) => account.digest === active.digest);
  const sameAccount = active?.email === target.email;
  const name = label(target.email);
  const decision = await escapable((context) => select({ config: {
    message: stepTitle('Antigravity CLI', sameAccount ? `使用 ${name} 已保存的凭据？` : `切换到 ${name}？`,
      '请先退出正在运行的 agy。下次以文件模式启动时会读取新凭据。'),
    choices: [
      { value: 'cancel', name: '取消' },
      ...(needsSave && !sameAccount ? [{ value: 'save', name: '保存当前登录并切换' }] : []),
      { value: 'switch', name: needsSave ? '直接切换' : '切换' },
    ],
    default: 'cancel', theme: selectTheme('取消'),
  }, context }));
  if (decision === BACK || decision === 'cancel') return;
  if (decision === 'save' && active !== null && !await save({ store, account: active })) return;
  await store.switchAntigravity({ account: target, currentDigest: current.digest });
  report({ symbol: symbols.success, text: `已写入 ${name} 的凭据，请以文件模式重新启动 agy。` });
}

export async function antigravityFlow(store: Session): Promise<void> {
  for (;;) {
    const { authPath, current, accounts } = await store.antigravityStatus();
    const email = current.status === 'valid' ? current.email : null;
    const emails = accounts.map((account) => account.email);
    if (email !== null) emails.push(email);
    const label = (value: Email) => antigravityEmailLabel(value, emails);
    const currentLabel = email === null ? current.status === 'invalid' ? '凭据文件无效' : '未找到凭据文件' : label(email);
    const path = maskHomePath({ path: authPath, userHome: store.userHome });
    const action = await escapable((context) => select({ config: {
      message: stepTitle('Antigravity CLI', `当前文件 · ${currentLabel}`, `${path}\n  适用于 agy 使用文件存储的会话 · 已保存 ${accounts.length} 个账号`),
      choices: [
        { value: 'switch', name: '切换账号', key: 's', disabled: accounts.some((account) => account.digest !== current.digest) ? false : '(暂无可切换凭据)' },
        { value: 'save', name: '保存当前登录', key: 'a', disabled: current.status === 'valid' ? false : '(暂无有效凭据文件)' },
        { value: 'import', name: '从文件导入…', key: 'i' },
        { value: 'back', name: '返回', key: 'q' },
      ],
      theme: selectTheme('返回'),
    }, context }));
    if (action === BACK || action === 'back') return;
    try {
      if (action === 'switch') await switchAccount({ store, current, accounts, label });
      else if (action === 'save' && current.status === 'valid') await save({ store, account: current });
      else if (action === 'import') await importFile(store);
    } catch (error) {
      if (isCancel(error)) throw error;
      report({ symbol: symbols.failure, text: message(error) });
    }
  }
}
