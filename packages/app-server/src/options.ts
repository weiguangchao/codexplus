import { defaultPort, parseOptions, resolveHome } from '@codexplus/shared';
import type { AdminAction, AdminCommand, ServeCommand } from './serve.js';

export type ServerCommand = { kind: 'help' } | ServeCommand | AdminCommand;

export const serverUsage = [
  'codexplus-server [--host 127.0.0.1] [--port 47831] [--tls-cert 文件 --tls-key 文件] [--home 目录]',
  'codexplus-server pair|clients|revoke <客户端ID>|log [--limit 条数] [--home 目录]',
].join('\n');

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须介于 1 和 65535。');
  }
  return port;
}

export function parseServerCommand(args: string[]): ServerCommand {
  const { values, positionals, allow } = parseOptions('codexplus-server', args, {
    home: { type: 'string' },
    limit: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    return { kind: 'help' };
  }
  const home = resolveHome(values.home);
  const port = values.port === undefined ? undefined : parsePort(values.port);
  const [action, id, ...rest] = positionals;
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
    throw new Error('命令无效，请运行 codexplus-server --help。');
  }
  allow('home', ...(action === 'log' ? ['limit'] : []));
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!/^\d+$/u.test(values.limit!) || !Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit 必须为正整数。');
  return { kind: 'admin', home, action: action as AdminAction, ...(id === undefined ? {} : { id }), ...(limit === undefined ? {} : { limit }) };
}
