import { parseOptions, resolveHome, serverUrl } from '@codexplus/shared';

export type Command =
  | { kind: 'help' }
  | { kind: 'client' | 'status' | 'list'; home: string; target?: string }
  | { kind: 'switch'; home: string; target?: string; email?: string };

export const usage = [
  'codexplus [--server 地址 | --local] [--home 目录]',
  'codexplus status|list [--server 地址 | --local] [--home 目录]',
  'codexplus switch [邮箱] [--server 地址 | --local] [--home 目录]',
  '',
  'status  查看运行模式、登录文件、当前账号及同步状态。',
  'list    列出已保存账号，标记当前账号。',
  'switch  切换账号；省略邮箱时选择账号，仍保留必要确认。',
  '不带子命令时打开交互式菜单；子命令完成后退出。',
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
  const [action, email, ...rest] = positionals;
  if (action !== undefined && !['status', 'list', 'switch'].includes(action)
    || rest.length > 0 || email !== undefined && (action !== 'switch' || !email.trim())) {
    throw new Error('命令无效，请运行 codexplus --help。');
  }
  const target = values.server !== undefined ? serverUrl(values.server)
    : values.local ? 'local' : undefined;
  const connection = { home, ...(target === undefined ? {} : { target }) };
  if (action === 'switch') {
    return { kind: 'switch', ...connection, ...(email === undefined ? {} : { email }) };
  }
  return { kind: action === 'status' || action === 'list' ? action : 'client', ...connection };
}
