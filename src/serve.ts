import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isRecord } from './auth.js';
import { expandPath } from './files.js';
import { requestLocalProof } from './local-codes.js';
import type { Command } from './options.js';
import { requestService, ServiceError } from './protocol.js';
import { startServer } from './server.js';

export async function runServe(command: Extract<Command, { kind: 'serve' }>): Promise<void> {
  const tls = command.tlsCert && command.tlsKey ? {
    cert: await readFile(expandPath(homedir(), command.tlsCert)),
    key: await readFile(expandPath(homedir(), command.tlsKey)),
  } : undefined;
  const server = await startServer({ home: command.home, host: command.host, port: command.port, ...(tls ? { tls } : {}) });
  console.log([
    `codexplus 服务端已启动：${server.url}（目录 ${command.home}）`,
    `生成远程配对码：codexplus serve pair --port ${command.port} --home ${command.home}`,
  ].join('\n'));
  const stop = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export async function runAdmin(command: Extract<Command, { kind: 'admin' }>, log: (message: string) => void = console.log): Promise<void> {
  let health: unknown;
  try {
    health = await requestService(command.url, '/v1/health');
  } catch (error) {
    if (!(error instanceof ServiceError)) {
      throw error;
    }
    health = null;
  }
  if (!isRecord(health) || health.service !== 'codexplus') {
    throw new Error(`${command.url} 上运行的不是 codexplus 服务端，请检查 --port 或 --server。`);
  }
  const proof = await requestLocalProof(command.url, command.home, 'admin');
  if (proof === null) {
    throw new Error('无法读取服务端的本机验证文件：管理命令需要与服务端使用同一系统用户和同一 --home 目录。');
  }
  const result = await requestService(command.url, `/v1/admin/${command.action}`, undefined,
    { proof, ...(command.id === undefined ? {} : { id: command.id }) });
  if (command.action === 'pair') {
    if (!isRecord(result) || typeof result.code !== 'string' || typeof result.expiresAt !== 'string') {
      throw new Error('服务端配对响应格式无效。');
    }
    log(`配对码：${result.code}\n有效期至：${result.expiresAt}\n仅可使用一次；生成新码会替换旧码。请在客户端运行 codexplus --server <服务端地址>。`);
  } else if (command.action === 'clients') {
    if (!isRecord(result) || !Array.isArray(result.clients)) {
      throw new Error('服务端客户端列表格式无效。');
    }
    if (result.clients.length === 0) {
      log('暂无已配对客户端。');
    }
    for (const client of result.clients) {
      if (isRecord(client)) {
        log(`${String(client.id)}  ${String(client.name)}  ${String(client.createdAt)}`);
      }
    }
  } else {
    log('已撤销该客户端的服务端访问授权。');
  }
}
