import { parseOptions } from '@weiguangchao/codexplus-shared';

export type Command = { kind: 'help' | 'client' };

export const usage = [
  'codexplus',
  'codexplus --help | -h',
  '',
  '打开交互式菜单，查看状态、管理和切换账号；需要交互式终端。',
  '--help, -h  显示帮助并退出。',
  '自带本机服务端，数据目录固定为 ~/.codexplus，退出时关闭服务端。',
  '',
  '仅支持 ChatGPT 登录凭证，不接受只有 API key 的文件。',
  '登录文件由服务端读写：使用 $CODEX_HOME/auth.json，未设置时为 ~/.codex/auth.json。',
  '独立服务端命令：codexplus-server --help；TUI 不连接独立服务端。',
].join('\n');

export function parseCommand(args: string[]): Command {
  const { values, positionals } = parseOptions({ program: 'codexplus', args, options: {
    help: { type: 'boolean', short: 'h' },
  } });
  if (positionals.length > 0) {
    throw new Error('不支持子命令，请运行 codexplus --help。');
  }
  return { kind: values.help ? 'help' : 'client' };
}
