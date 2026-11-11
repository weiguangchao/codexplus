import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultPort, serverUrl } from './protocol.js';

export type AdminAction = 'pair' | 'clients' | 'revoke' | 'log';

export type Command =
  | { kind: 'help' }
  | { kind: 'client'; home: string; target?: string }
  | { kind: 'serve'; home: string; host: string; port: number; tlsCert?: string; tlsKey?: string }
  | { kind: 'admin'; home: string; action: AdminAction; id?: string; limit?: number };

export const usage = [
  'codexplus [--server 地址 | --local] [--home 目录]',
  'codexplus serve [--host 127.0.0.1] [--port 47831] [--tls-cert 文件 --tls-key 文件] [--home 目录]',
  'codexplus serve pair|clients|revoke <客户端ID>|log [--limit 条数] [--home 目录]',
  '',
  '仅支持 ChatGPT 登录凭证，不接受只有 API key 的文件。',
  '登录文件：$CODEX_HOME/auth.json；未设置 CODEX_HOME 时使用 ~/.codex/auth.json。',
].join('\n');

function resolveHome(value: string | undefined): string {
  const home = value ?? join(homedir(), '.codexplus');
  if (!home.trim()) {
    throw new Error('--home 需要指定目录路径。');
  }
  return home === '~' ? homedir() : home.startsWith('~/') ? resolve(homedir(), home.slice(2)) : resolve(home);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须介于 1 和 65535。');
  }
  return port;
}

export function parseCommand(args: string[]): Command {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      limit: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      server: { type: 'string' },
      local: { type: 'boolean' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    return { kind: 'help' };
  }
  const allow = (...names: string[]): void => {
    const extra = Object.keys(values).find((name) => !names.includes(name));
    if (extra) {
      throw new Error(`--${extra} 不能用于此命令，请运行 codexplus --help。`);
    }
  };
  const home = resolveHome(values.home);
  const port = values.port === undefined ? undefined : parsePort(values.port);
  if (values.server !== undefined && (values.local || port !== undefined)) {
    throw new Error('--server 不能与 --local 或 --port 同时使用。');
  }
  const [command, action, id, ...rest] = positionals;
  if (command === undefined) {
    allow('home', 'server', 'local');
    const target = values.server !== undefined ? serverUrl(values.server)
      : values.local ? 'local' : undefined;
    return { kind: 'client', home, ...(target === undefined ? {} : { target }) };
  }
  if (command !== 'serve') {
    throw new Error('命令无效，请运行 codexplus --help。');
  }
  if (action === undefined) {
    allow('home', 'port', 'host', 'tls-cert', 'tls-key');
    const { 'tls-cert': tlsCert, 'tls-key': tlsKey } = values;
    if (Boolean(tlsCert) !== Boolean(tlsKey)) {
      throw new Error('--tls-cert 和 --tls-key 必须同时提供。');
    }
    return { kind: 'serve', home, host: values.host ?? '127.0.0.1', port: port ?? defaultPort,
      ...(tlsCert && tlsKey ? { tlsCert, tlsKey } : {}) };
  }
  if (!['pair', 'clients', 'revoke', 'log'].includes(action) || rest.length > 0 || (action === 'revoke') !== (id !== undefined)) {
    throw new Error('命令无效，请运行 codexplus --help。');
  }
  allow('home', ...(action === 'log' ? ['limit'] : []));
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!/^\d+$/u.test(values.limit!) || !Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit 必须为正整数。');
  return { kind: 'admin', home, action: action as AdminAction, ...(id === undefined ? {} : { id }), ...(limit === undefined ? {} : { limit }) };
}
