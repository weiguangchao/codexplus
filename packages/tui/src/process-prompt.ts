import { writeOutput } from '@weiguangchao/codexplus-shared';
import { styleText } from 'node:util';
import { BACK, escapable } from './prompts.js';
import { stepTitle } from './screens.js';
import { select } from './select.js';
import { line, selectTheme, symbols } from './ui.js';
import type { RunningCodexDecision, RunningCodexPrompt } from './switch.js';
import type { SelectConfig } from './select-layout.js';

export function logRunningCodex(message: string): void {
  if (message.startsWith('  ')) writeOutput(styleText('dim', message));
  else if (message.startsWith('检测到')) writeOutput(line(symbols.warning, styleText('yellow', message)));
  else writeOutput(line(' ', styleText('dim', message)));
}

export function runningCodexConfig({ message, detail, count, action }: RunningCodexPrompt): SelectConfig<RunningCodexDecision> {
  return {
    message: stepTitle(`${action === 'update' ? '更新本机登录' : '切换账号'} / 进程确认`, message, detail),
    compactMessage: stepTitle('进程确认', `${count} 个 Codex 进程仍在运行`, `${message}\n可能影响会话，建议先退出 Codex。`),
    choices: [
      { value: false, name: '取消，先退出 Codex', description: '当前凭证不变' },
      { value: true, name: action === 'update' ? '仍然更新' : '仍然切换', tone: 'danger', description: '将改写本机凭证，正在运行的会话后续请求可能受影响' },
      ...(action === 'update' ? [] : [{ value: 'restart' as const, name: '仍然切换并重启 codex server', tone: 'danger' as const, description: '切换后重启 Codex 托管后台服务，可能中断正在运行的任务' }]),
    ],
    default: false,
    theme: selectTheme('取消'),
  };
}

export async function askRunningCodex(options: RunningCodexPrompt): Promise<RunningCodexDecision> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) options.detail.split('\n').forEach(logRunningCodex);
  const answer = await escapable((context) => select({ config: runningCodexConfig(options), context }));
  if (answer === true || answer === 'restart') writeOutput('');
  return answer === BACK ? false : answer;
}
