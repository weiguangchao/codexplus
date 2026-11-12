import { input, password, select } from '@inquirer/prompts';
import { hostname } from 'node:os';
import { emitKeypressEvents } from 'node:readline';
import { styleText } from 'node:util';
import { PairingCancelled } from '@codexplus/shared';
import { inputTheme, refreshDetails, report, selectTheme, symbols } from './ui.js';

export const BACK = Symbol('back');

interface PromptContext {
  signal: AbortSignal;
  clearPromptOnDone: boolean;
}

export async function escapable<T>(run: (context: PromptContext) => Promise<T>): Promise<T | typeof BACK> {
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

export async function askRepair(url: string): Promise<boolean> {
  report(symbols.warning, styleText('yellow', `${url} 上的服务端不是之前配对的那个`), '未发送已保存的令牌');
  const answer = await escapable((context) => select({
    message: '要与这个服务端重新配对吗？',
    choices: [
      { value: false, name: '取消', description: '退出，客户端配置不变' },
      { value: true, name: '重新配对', description: '需要在该服务端运行 codexplus-server pair 获取配对码' },
    ],
    default: false,
    theme: selectTheme('取消'),
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

export async function askPairing(url: string) {
  report(symbols.info, `${url} 需要配对`, '请在服务端运行 codexplus-server pair 获取配对码');
  const code = await escapable((context) => password({ message: '服务端生成的配对码 (esc 取消)', mask: true, theme: inputTheme,
    validate: (value) => Boolean(value.trim()) || '请输入配对码。' }, context));
  if (code === BACK) throw new PairingCancelled();
  const name = await escapable((context) => input({ message: '客户端名称 (esc 取消)', default: hostname(), theme: inputTheme,
    validate: (value) => (Boolean(value.trim()) && value.length <= 100) || '请输入名称，最多 100 字符。' }, context));
  if (name === BACK) throw new PairingCancelled();
  console.log('');
  return { code, name };
}

export async function retryPairing(message: string): Promise<boolean> {
  report(symbols.warning, styleText('yellow', message));
  const answer = await escapable((context) => select({
    message: '要重新输入配对码吗？',
    choices: [
      { value: true, name: '重新输入', description: '使用新的或正确的配对码重试' },
      { value: false, name: '取消配对', description: '退出，客户端配置不变' },
    ],
    default: true,
    theme: selectTheme('取消'),
  }, context));
  return answer === true;
}
