import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readAudit, recordCommitted } from './audit.js';
import { AccessStore } from './access.js';
import { expandPath } from '@codexplus/shared';
import { startServer } from './server.js';

export type AdminAction = 'pair' | 'clients' | 'revoke' | 'log';

export interface ServeCommand { kind: 'serve'; home: string; host: string; port: number; tlsCert?: string; tlsKey?: string }

export interface AdminCommand { kind: 'admin'; home: string; action: AdminAction; id?: string; limit?: number }

export async function runServe(command: ServeCommand): Promise<void> {
  const tls = command.tlsCert && command.tlsKey ? {
    cert: await readFile(expandPath(homedir(), command.tlsCert)),
    key: await readFile(expandPath(homedir(), command.tlsKey)),
  } : undefined;
  const server = await startServer({ home: command.home, host: command.host, port: command.port, ...(tls ? { tls } : {}) });
  console.log([
    `codexplus 服务端已启动：${server.url}（目录 ${command.home}）`,
    `生成远程配对码：codexplus serve pair --home ${command.home}`,
  ].join('\n'));
  const stop = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export async function runAdmin(command: AdminCommand, log: (message: string) => void = console.log): Promise<void> {
  const home = resolve(command.home);
  const directory = await stat(home).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new Error(`数据目录不存在或不是目录：${home}，请检查 --home 或先运行 codexplus serve。`);
  }
  const access = new AccessStore(command.home);
  if (command.action === 'log') {
    const entries = await readAudit(command.home, command.limit ?? 50);
    if (entries.length === 0) log('暂无操作记录。');
    for (const entry of entries) {
      const subject = entry.email ?? (entry.target ? `${entry.target.name}（${entry.target.id}）` : '');
      log(`${entry.time}  ${entry.event}  ${entry.clientId}  ${entry.clientName}${subject ? `  ${subject}` : ''}`);
    }
  } else if (command.action === 'pair') {
    const result = await access.createPair();
    log(`配对码：${result.code}\n有效期至：${result.expiresAt}\n仅可使用一次；生成新码会替换旧码。请在客户端运行 codexplus --server <服务端地址>。`);
  } else if (command.action === 'clients') {
    const clients = await access.list();
    if (clients.length === 0) log('暂无已配对客户端。');
    for (const client of clients) log(`${client.id}  ${client.name}  ${client.createdAt}  ${client.lastSeenAt ?? '从未'}`);
  } else {
    const target = await access.revoke(command.id ?? '');
    await recordCommitted(command.home, '撤销', { id: 'admin', name: '管理命令' }, { target });
    log('已撤销该客户端的服务端访问授权。');
  }
}
