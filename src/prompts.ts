import { input, password, select } from '@inquirer/prompts';
import { hostname } from 'node:os';
import { emitKeypressEvents } from 'node:readline';
import { styleText } from 'node:util';
import { inputTheme, report, selectTheme, symbols } from './ui.js';

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
  const time = (value: unknown): string => typeof value === 'string' ? value : '未知';
  const answer = await escapable((context) => select({
    message: `服务端已保存 ${styleText('cyan', String(details.email))}，内容与本次上传不同\n  ${styleText('dim', `本次上传的刷新时间：${time(details.localRefresh)}，服务端保存的刷新时间：${time(details.lastRefresh)}`)}`,
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
  return await select({
    message: '要与这个服务端重新配对吗？',
    choices: [
      { value: false, name: '取消', description: '退出，客户端配置不变' },
      { value: true, name: '重新配对', description: '需要在该服务端运行 codexplus serve pair 获取配对码' },
    ],
    default: false,
    theme: selectTheme('取消'),
  });
}

export async function askPairing(url: string) {
  report(symbols.info, `${url} 需要配对`, '请在服务端运行 codexplus serve pair 获取配对码');
  const code = await password({ message: '服务端生成的配对码', mask: true, theme: inputTheme,
    validate: (value) => Boolean(value.trim()) || '请输入配对码。' });
  const name = await input({ message: '客户端名称', default: hostname(), theme: inputTheme,
    validate: (value) => (Boolean(value.trim()) && value.length <= 100) || '请输入名称，最多 100 字符。' });
  console.log('');
  return { code, name };
}
