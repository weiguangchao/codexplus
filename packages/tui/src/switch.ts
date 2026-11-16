import { writeOutput } from '@weiguangchao/codexplus-shared';
import { confirm } from '@inquirer/prompts';
import type { Credential } from '@weiguangchao/codexplus-shared';

export type RunningCodexDecision = boolean | 'restart';

export interface RunningCodexPrompt {
  message: string;
  detail: string;
  count: number;
  default: boolean;
  action?: 'switch' | 'update';
}

interface SwitchOptions {
  action?: 'switch' | 'update';
  authPath?: string;
  findProcesses: () => Promise<{ pid: number; command: string }[]>;
  ask?: (options: RunningCodexPrompt) => Promise<RunningCodexDecision>;
  log?: (message: string) => void;
}

export async function confirmRunningCodex({
  action = 'switch',
  authPath = '~/.codex/auth.json',
  findProcesses,
  ask = ({ message, detail, default: answer }) => confirm({ message: `${message}\n${detail}`, default: answer }),
  log = writeOutput,
}: SwitchOptions): Promise<RunningCodexDecision> {
  const processes = await findProcesses();
  const verb = action === 'update' ? '更新' : '切换';
  if (processes.length > 0) {
    const detail = ['检测到以下 Codex 进程仍在运行：', ...processes.map(({ pid, command }) => `  PID ${pid}  ${command}`),
      '进程存在不代表任务正忙。', `现在${verb}会改写本机登录文件：`, `  ${authPath}`,
      '可能影响这些会话的后续请求。', '建议先退出 Codex。'].join('\n');
    const decision = await ask({ message: action === 'update' ? '仍要更新本机登录吗？' : '仍要切换账号吗？', detail,
      count: processes.length, default: false, action });
    if (!decision) {
      log(`已取消${verb}，当前凭证未更改。`);
      return false;
    }
    return decision;
  }
  return true;
}

export async function switchCredential({ store, credential, options }: { store: { switch(credential: Credential): Promise<void>; restartCodexServer(): Promise<void> }; credential: Credential; options: SwitchOptions }
): Promise<void> {
  const decision = await confirmRunningCodex(options);
  if (!decision) {
    return;
  }
  await store.switch(credential);
  (options.log ?? writeOutput)(`已切换到：${credential.email}`);
  if (decision === 'restart') await store.restartCodexServer();
}
