import type { Email, UploadConflict } from '@weiguangchao/codexplus-shared';
import { select } from './select.js';
import { emitKeypressEvents } from 'node:readline';
import { maskEmail, refreshDetails, selectTheme } from './ui.js';
import { stepTitle } from './screens.js';
import type { EscapeControl } from './prompt-context.js';

export const BACK = Symbol('back');

interface PromptContext {
  signal: AbortSignal;
  clearPromptOnDone: boolean;
  escape: EscapeControl;
}

export function requireInteractive(message = '此操作需要选择或确认，请在交互式终端中运行 codexplus。'): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(message);
  }
}

export async function escapable<T>(run: (context: PromptContext) => Promise<T>): Promise<T | typeof BACK> {
  requireInteractive();
  const controller = new AbortController();
  const escape: EscapeControl = {};
  const onKeypress = (_: string, key?: { name?: string }) => {
    if (key?.name === 'escape' && !escape.isReading?.()) {
      controller.abort();
    }
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKeypress);
  try {
    return await run({ signal: controller.signal, clearPromptOnDone: true, escape });
  } catch (error) {
    if (controller.signal.aborted && error instanceof Error && error.name === 'AbortPromptError') {
      return BACK;
    }
    throw error;
  } finally {
    process.stdin.off('keypress', onKeypress);
  }
}

export function isCancel(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError');
}

export async function confirmUpload(details: UploadConflict): Promise<boolean> {
  const answer = await escapable((context) => select({ config: {
    message: stepTitle('添加账号 / 确认覆盖', `账号库已保存 ${maskEmail(details.email)}，内容不同`, `  ${refreshDetails(details.localRefresh, details.lastRefresh, '本次上传的')}`),
    choices: [
      { value: false, name: '返回', description: '不做更改' },
      { value: true, name: '用本次上传覆盖服务端', tone: 'danger', description: '服务端保存的版本将被替换，无法恢复' },
    ],
    default: false,
    theme: selectTheme('返回'),
  }, context }));
  return answer === true;
}

export async function confirmRestore(email: Email | null): Promise<boolean> {
  const answer = await escapable((context) => select({ config: {
    message: stepTitle('添加账号 / 确认恢复', email === null ? '无法识别账号，保存可能重新添加刚删除的账号。' : `重新保存刚删除的账号 ${maskEmail(email)}？`),
    choices: [
      { value: false, name: '取消', description: '保留删除结果，本机登录不变' },
      { value: true, name: email === null ? '确认保存' : '重新保存', description: '把这份凭证保存到服务端' },
    ],
    default: false,
    theme: selectTheme('取消'),
  }, context }));
  return answer === true;
}
