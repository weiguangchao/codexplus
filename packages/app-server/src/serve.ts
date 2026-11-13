import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readAudit } from './audit.js';
import { startServer } from './server.js';

export interface ServeCommand { kind: 'serve'; home: string; port: number }

export interface AdminCommand { kind: 'admin'; home: string; action: 'log'; limit?: number }

export async function runServe(command: ServeCommand): Promise<void> {
  const server = await startServer({ home: command.home, port: command.port });
  console.log(`codexplus 本机服务端已启动：${server.url}（目录 ${command.home}）`);
  const stop = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export async function runAdmin(command: AdminCommand, log: (message: string) => void = console.log): Promise<void> {
  const home = resolve(command.home);
  const directory = await stat(home).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new Error(`数据目录不存在或不是目录：${home}，请检查 --home 或先运行 codexplus-server。`);
  }
  const entries = await readAudit(home, command.limit ?? 50);
  if (entries.length === 0) log('暂无操作记录。');
  for (const entry of entries) {
    log(`${entry.time}  ${entry.event}  ${entry.clientId}  ${entry.clientName}${entry.email ? `  ${entry.email}` : ''}`);
  }
}
