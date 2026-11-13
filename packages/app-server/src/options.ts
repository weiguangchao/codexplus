import { defaultPort, parseOptions, parsePort, resolveHome } from '@codexplus/shared';
import type { AdminCommand, ServeCommand } from './serve.js';

export type ServerCommand = { kind: 'help' } | ServeCommand | AdminCommand;

export const serverUsage = [
  'codexplus-server [--port 47831] [--home 目录]',
  'codexplus-server log [--limit 条数] [--home 目录]',
  '',
  '服务端仅监听 127.0.0.1，不接受远程连接。',
].join('\n');

export function parseServerCommand(args: string[]): ServerCommand {
  const { values, positionals, allow } = parseOptions('codexplus-server', args, {
    home: { type: 'string' },
    limit: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) return { kind: 'help' };
  const home = resolveHome(values.home);
  if (positionals.length === 0) {
    allow('home', 'port');
    return { kind: 'serve', home, port: values.port === undefined ? defaultPort : parsePort(values.port) };
  }
  if (positionals.length !== 1 || positionals[0] !== 'log') {
    throw new Error('命令无效，请运行 codexplus-server --help。');
  }
  allow('home', 'limit');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!/^\d+$/u.test(values.limit!) || !Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit 必须为正整数。');
  return { kind: 'admin', home, action: 'log', ...(limit === undefined ? {} : { limit }) };
}
