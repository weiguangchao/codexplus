#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { localKeyPath } from './access.js';
import { isRecord } from './auth.js';
import { expandPath, readOptional } from './files.js';
import { parseHome } from './options.js';
import { defaultServerUrl, requestService, serverUrl } from './protocol.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '47831' },
      url: { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('codexplus-server [serve] [--home 目录] [--host 127.0.0.1] [--port 47831] [--tls-cert 文件 --tls-key 文件]\ncodexplus-server pair|clients|revoke <客户端ID> [--home 目录] [--url 本机服务地址]');
    return;
  }
  const [command = 'serve', id] = positionals;
  const home = parseHome(values.home === undefined ? [] : ['--home', values.home]);
  if (!['serve', 'pair', 'clients', 'revoke'].includes(command) || positionals.length > (command === 'revoke' ? 2 : 1) ||
    (command === 'revoke' && !id)) {
    throw new Error('命令无效，请运行 codexplus-server --help。');
  }
  if (command === 'serve') {
    if (values.url) {
      throw new Error('启动服务请使用 --host 和 --port；--url 仅用于服务端管理命令。');
    }
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('端口必须介于 1 和 65535。');
    }
    if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) {
      throw new Error('--tls-cert 和 --tls-key 必须同时提供。');
    }
    const tls = values['tls-cert'] && values['tls-key'] ? {
      cert: await readFile(expandPath(values['tls-cert'], homedir())),
      key: await readFile(expandPath(values['tls-key'], homedir())),
    } : undefined;
    const server = await startServer({ home, host: values.host, port, ...(tls ? { tls } : {}) });
    console.log(`codexplus-server 已启动：${server.url}\n本机客户端无需配对。生成远程配对码：codexplus-server pair --url ${server.url}\n使用自定义 --home 时，客户端和管理命令需指定各自的配置目录。`);
    const stop = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (values['tls-cert'] || values['tls-key']) {
    throw new Error('管理命令不接受 TLS 文件参数，请使用 --url 指定本机服务地址。');
  }
  const url = serverUrl(values.url ?? defaultServerUrl, true);
  const key = await readOptional(localKeyPath(home));
  if (!key) {
    throw new Error('请先以当前用户启动 codexplus-server。');
  }
  const result = await requestService(url, `/v1/admin/${command}`, key,
    command === 'pair' ? {} : command === 'revoke' ? { id } : undefined);
  if (command === 'pair') {
    if (!isRecord(result) || typeof result.code !== 'string' || typeof result.expiresAt !== 'string') {
      throw new Error('服务端配对响应格式无效。');
    }
    console.log(`配对码：${result.code}\n有效期至：${result.expiresAt}\n仅可使用一次；生成新码会替换旧码。请在客户端选择“配对远程服务端”。`);
  } else if (command === 'clients') {
    if (!isRecord(result) || !Array.isArray(result.clients)) {
      throw new Error('服务端客户端列表格式无效。');
    }
    if (result.clients.length === 0) {
      console.log('暂无已配对客户端。');
    }
    for (const client of result.clients) {
      if (isRecord(client)) {
        console.log(`${String(client.id)}  ${String(client.name)}  ${String(client.createdAt)}`);
      }
    }
  } else {
    console.log('已撤销该客户端的服务端访问授权。');
  }
}

main().catch((error: unknown) => {
  console.error(`错误：${error instanceof Error ? error.message : '服务端操作失败。'}`);
  process.exitCode = 1;
});
