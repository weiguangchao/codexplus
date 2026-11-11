import { confirm } from '@inquirer/prompts';
import { findCodexProcesses } from './processes.js';
import type { Credential } from './protocol.js';

interface SwitchOptions {
  findProcesses?: typeof findCodexProcesses;
  ask?: (options: { message: string; default: boolean }) => Promise<boolean>;
  log?: (message: string) => void;
}

export async function confirmRunningCodex({
  findProcesses = findCodexProcesses,
  ask = confirm,
  log = console.log,
}: SwitchOptions = {}): Promise<boolean> {
  const processes = await findProcesses();
  if (processes.length > 0) {
    log('检测到以下 Codex 进程仍在运行：');
    for (const { pid, command } of processes) {
      log(`  PID ${pid}  ${command}`);
    }
    log('进程存在不代表任务正忙。现在切换可能影响这些会话的后续请求，建议先退出 Codex。');
    if (!await ask({ message: '仍要切换账号吗？', default: false })) {
      log('已取消切换，当前凭证未更改。');
      return false;
    }
  }
  return true;
}

export async function switchCredential(
  store: { switch(credential: Credential): Promise<void> },
  credential: Credential,
  options: SwitchOptions = {},
): Promise<void> {
  if (!await confirmRunningCodex(options)) {
    return;
  }
  await store.switch(credential);
  (options.log ?? console.log)(`已切换到：${credential.email}`);
}
