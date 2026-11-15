import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '@weiguangchao/codexplus-shared';
import { codexCommand } from './browser-login.js';

const execute = promisify(execFile);

export async function restartCodexServer(codexHome: string): Promise<void> {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const command = await codexCommand(env);
  try {
    const { stdout } = await execute(command[0]!, [...command.slice(1), 'app-server', 'daemon', 'restart'], {
      env,
      encoding: 'utf8',
      timeout: 330_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const result: unknown = JSON.parse(stdout);
    if (!isRecord(result) || result.status !== 'restarted') throw new Error('Codex 未确认重启成功。');
  } catch {
    throw new Error('无法重启 Codex server，请确认已安装支持 app-server daemon restart 的 Codex CLI，并检查服务状态。');
  }
}
