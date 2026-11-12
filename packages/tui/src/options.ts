import { parseOptions, resolveHome, serverUrl } from '@codexplus/shared';

export type Command =
  | { kind: 'help' }
  | { kind: 'client'; home: string; target?: string };

export const usage = [
  'codexplus [--server 地址 | --local] [--home 目录]',
  '',
  '仅支持 ChatGPT 登录凭证，不接受只有 API key 的文件。',
  '登录文件：$CODEX_HOME/auth.json；未设置 CODEX_HOME 时使用 ~/.codex/auth.json。',
  '服务端已改为独立命令 codexplus-server，运行 codexplus-server --help 查看用法。',
].join('\n');

export function parseCommand(args: string[]): Command {
  if (args[0] === 'serve') {
    throw new Error('服务端已改为独立命令 codexplus-server，请运行 codexplus-server --help。');
  }
  const { values, positionals } = parseOptions('codexplus', args, {
    home: { type: 'string' },
    server: { type: 'string' },
    local: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    return { kind: 'help' };
  }
  const home = resolveHome(values.home);
  if (values.server !== undefined && values.local) {
    throw new Error('--server 不能与 --local 同时使用。');
  }
  if (positionals.length > 0) {
    throw new Error('命令无效，请运行 codexplus --help。');
  }
  const target = values.server !== undefined ? serverUrl(values.server)
    : values.local ? 'local' : undefined;
  return { kind: 'client', home, ...(target === undefined ? {} : { target }) };
}
