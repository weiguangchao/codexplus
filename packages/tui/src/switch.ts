import { confirm } from '@inquirer/prompts';
import type { Credential } from '@weiguangchao/codexplus-shared';

interface SwitchOptions {
  action?: 'switch' | 'update';
  authPath?: string;
  findProcesses: () => Promise<{ pid: number; command: string }[]>;
  ask?: (options: { message: string; default: boolean; action?: 'switch' | 'update' }) => Promise<boolean>;
  log?: (message: string) => void;
}

export async function confirmRunningCodex({
  action = 'switch',
  authPath = '~/.codex/auth.json',
  findProcesses,
  ask = confirm,
  log = console.log,
}: SwitchOptions): Promise<boolean> {
  const processes = await findProcesses();
  const verb = action === 'update' ? '更新' : '切换';
  if (processes.length > 0) {
    log('检测到以下 Codex 进程仍在运行：');
    for (const { pid, command } of processes) {
      log(`  PID ${pid}  ${command}`);
    }
    log('进程存在不代表任务正忙。');
    log(`现在${verb}会改写本机登录文件：`);
    log(`  ${authPath}`);
    log('可能影响这些会话的后续请求。');
    log('建议先退出 Codex。');
    if (!await ask({ message: action === 'update' ? '仍要更新本机登录吗？' : '仍要切换账号吗？', default: false, action })) {
      log(`已取消${verb}，当前凭证未更改。`);
      return false;
    }
  }
  return true;
}

export async function switchCredential(
  store: { switch(credential: Credential): Promise<void> },
  credential: Credential,
  options: SwitchOptions,
): Promise<void> {
  if (!await confirmRunningCodex(options)) {
    return;
  }
  await store.switch(credential);
  (options.log ?? console.log)(`已切换到：${credential.email}`);
}
