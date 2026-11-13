import { select } from '@inquirer/prompts';
import { emitKeypressEvents } from 'node:readline';
import { styleText } from 'node:util';
import { refreshDetails, selectTheme } from './ui.js';

export const BACK = Symbol('back');

interface PromptContext {
  signal: AbortSignal;
  clearPromptOnDone: boolean;
}

export function requireInteractive(message = '此操作需要选择或确认，请在交互式终端中运行 codexplus。'): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(message);
  }
}

export async function escapable<T>(run: (context: PromptContext) => Promise<T>): Promise<T | typeof BACK> {
  requireInteractive();
  const controller = new AbortController();
  const onKeypress = (_: string, key?: { name?: string }) => {
    if (key?.name === 'escape') {
      controller.abort();
    }
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKeypress);
  try {
    return await run({ signal: controller.signal, clearPromptOnDone: true });
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

export async function confirmUpload(details: Record<string, unknown>): Promise<boolean> {
  const answer = await escapable((context) => select({
    message: `服务端已保存 ${styleText('cyan', String(details.email))}，内容与本次上传不同\n  ${styleText('dim', refreshDetails(details.localRefresh, details.lastRefresh, '本次上传的'))}`,
    choices: [
      { value: false, name: '返回', description: '不做更改' },
      { value: true, name: '用本次上传覆盖服务端', description: '服务端保存的版本将被替换，无法恢复' },
    ],
    default: false,
    theme: selectTheme('返回'),
  }, context));
  return answer === true;
}

export async function confirmRestore(email: string | null): Promise<boolean> {
  const answer = await escapable((context) => select({
    message: email === null ? '无法识别这份凭证的账号，保存可能重新添加刚删除的账号。继续吗？' : `将重新保存刚删除的账号 ${styleText('cyan', email)}，继续吗？`,
    choices: [
      { value: false, name: '取消', description: '保留删除结果，本机登录不变' },
      { value: true, name: email === null ? '确认保存' : '重新保存', description: '把这份凭证保存到服务端' },
    ],
    default: false,
    theme: selectTheme('取消'),
  }, context));
  return answer === true;
}
