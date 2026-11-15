import figures from '@inquirer/figures';
import { Separator } from '@inquirer/prompts';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { styleText } from 'node:util';
import { newerRefresh } from '@weiguangchao/codexplus-shared';
import type { Credential, CurrentLogin } from '@weiguangchao/codexplus-shared';
import { displayWidth, fit, wrapWords } from './text-layout.js';
import { glyph, unicode } from './terminal-symbols.js';
export { displayWidth, fit, wrapWords } from './text-layout.js';

export type MainAction = 'switch' | 'add' | 'update' | 'delete' | 'info' | 'reset' | 'details' | 'exit';
export type AddSource = 'codex' | 'file' | 'browser' | 'back';

const dots = { filled: glyph.filled, empty: glyph.empty };
const currentLabel = () => styleText('green', `${dots.filled} 当前`);

export const symbols = {
  success: styleText('green', figures.tick),
  failure: styleText('red', figures.cross),
  warning: styleText('yellow', figures.warning),
  info: styleText('cyan', figures.info),
};

const divider = (label = '') => new Separator(label || figures.line.repeat(6));
const prefix = { idle: styleText('cyan', glyph.cursor), done: styleText('green', figures.tick) };
const error = (text: string) => `${symbols.failure} ${styleText('red', wrapWords(text, (process.stdout.columns || 80) - 2).replaceAll('\n', '\n  '))}`;

export function selectTheme(escapeLabel: string) {
  return { escapeLabel };
}

export const inputTheme = { prefix, style: { error } };

function activeEmail(current: CurrentLogin): string | null {
  return current.status === 'saved' || current.status === 'ahead' ? current.email : null;
}

export function needsBackup(current: CurrentLogin): current is Extract<CurrentLogin, { status: 'ahead' | 'diverged' | 'unsaved' | 'deleted' }> {
  return current.status === 'ahead' || current.status === 'diverged' || current.status === 'unsaved' || current.status === 'deleted';
}

function maskName(name: string): string {
  const characters = Array.from(name);
  return characters.length > 4 ? `${characters.slice(0, 2).join('')}***${characters.slice(-2).join('')}` : '***';
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? maskName(email) : `${maskName(email.slice(0, at))}@${Array.from(email.slice(at + 1))[0] ?? ''}***`;
}

export function maskHomePath(path: string, userHome: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(userHome, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return path;
  return join(dirname(userHome), maskName(basename(userHome)), inside);
}

export function describeCurrent(current: CurrentLogin, authPath = '~/.codex/auth.json'): string {
  const dot = (color: 'green' | 'yellow') => styleText(color, dots.filled);
  if (current.status === 'saved') {
    return `${dot('green')} ${styleText('bold', maskEmail(current.email))}`;
  }
  if (current.status === 'behind' || current.status === 'diverged') {
    const note = current.status === 'behind' ? '账号库有更新版本' : '与账号库版本不一致';
    return `${dot('yellow')} ${styleText('bold', maskEmail(current.email))} ${styleText('yellow', note)}`;
  }
  if (current.status === 'ahead') {
    return `${dot('yellow')} ${styleText('bold', maskEmail(current.email))} ${styleText('yellow', '有更新未保存')}`;
  }
  if (current.status === 'deleted') {
    return `${dot('yellow')} ${styleText('bold', maskEmail(current.email))} ${styleText('dim', '已从账号库删除，本机登录保留')}`;
  }
  if (current.status === 'unsaved') {
    return current.email === null
      ? `${dot('yellow')} ${styleText('yellow', '无法识别')} ${styleText('dim', '与已保存的账号都不一致')}`
      : `${dot('yellow')} ${styleText('bold', maskEmail(current.email))} ${styleText('yellow', '未保存')}`;
  }
  if (current.status === 'invalid') {
    return `${dot('yellow')} ${styleText('yellow', '登录文件无效或无法读取')}\n  ${current.reason}\n  请先在 Codex 中重新登录，或从其他文件添加有效凭证。`;
  }
  return styleText('dim', `${dots.empty} 未登录\n  未找到登录文件：\n  ${fitPath(authPath, (process.stdout.columns || 80) - 2)}`);
}

export function renderStatus(current: CurrentLogin, count: number, authPath = '~/.codex/auth.json'): string {
  const saved = count === 0 ? styleText('dim', '暂无') : `${count} 个`;
  return [
    `${styleText('dim', '当前账号')}  ${describeCurrent(current, authPath)}`,
    `${styleText('dim', '已保存  ')}  ${saved}`,
  ].join('\n');
}

export function mainChoices(credentials: Credential[], current: CurrentLogin, authPath = '~/.codex/auth.json') {
  const active = activeEmail(current);
  const others = credentials.filter((credential) => credential.email !== active).length;
  const switchDescription =
    credentials.length === 0
      ? '还没有保存的账号，请先添加。'
      : others === 0
        ? '已保存的账号只有当前这一个，请先添加其他账号。'
        : active === null ? `从 ${others} 个已保存的账号中选择一个` : `从 ${others} 个其他账号中选择一个`;
  const addDescription =
    current.status === 'invalid'
      ? '当前登录文件无效，请先重新登录，或从其他文件添加有效凭证。'
      : current.status === 'deleted'
        ? '将重新保存刚删除的账号，需要再次确认。'
        : current.status === 'unsaved'
          ? '当前 Codex 登录尚未保存，建议先保存。'
          : current.status === 'ahead'
            ? '当前登录有更新，可以重新保存以更新凭证。'
            : current.status === 'diverged'
              ? '当前登录与账号库中保存的版本不一致，可以选择保留哪一份。'
              : '通过浏览器登录或导入 auth.json，同一邮箱已保存时会先确认再覆盖';
  const choices = [
    ...(current.status === 'behind'
      ? [{ value: 'update' as const, name: '更新本机登录', key: 'u', description: `使用账号库中 ${maskEmail(current.email)} 的新版本，写入 ${authPath}` }]
      : []),
    {
      value: 'switch' as const,
      name: '切换账号',
      key: 's',
      description: switchDescription,
      disabled: others === 0 ? styleText('dim', credentials.length === 0 ? '(暂无账号)' : '(没有其他账号)') : false,
    },
    { value: 'add' as const, name: '添加账号', key: 'a', description: addDescription },
    {
      value: 'info' as const,
      name: '查看账户信息',
      key: 'i',
      description: '查看当前账户的套餐、到期时间和五小时、每周剩余额度',
      disabled: current.status === 'none' || current.status === 'invalid' ? styleText('dim', '(未登录或登录无效)') : false,
    },
    {
      value: 'reset' as const,
      name: '使用 Codex 重置卡',
      key: 'r',
      description: '先选择账号，再选择该账号的可用重置卡，确认后重置用量',
      disabled: credentials.length === 0 ? styleText('dim', '(暂无账号)') : false,
    },
    divider('账号管理'),
    {
      value: 'delete' as const,
      name: '删除账号',
      key: 'd',
      tone: 'danger' as const,
      description: '从账号库删除已保存的凭证。需要再次确认，本机登录保留。',
      disabled: credentials.length === 0 ? styleText('dim', '(暂无账号)') : false,
    },
    { value: 'details' as const, name: '位置与连接', key: 'p', description: '查看账号库位置、当前登录文件与本机服务连接' },
    { value: 'exit' as const, name: '退出', key: 'q', description: '退出 codexplus' },
  ];
  const fallback: MainAction = others === 0 || needsBackup(current) ? 'add' : 'switch';
  const defaultAction: MainAction = current.status === 'invalid' ? others > 0 ? 'switch' : 'add'
    : current.status === 'deleted' ? 'exit' : current.status === 'behind' ? 'update' : fallback;
  return { choices, default: defaultAction };
}

export function refreshDetails(local: unknown, server: unknown, localLabel = '本机'): string {
  const time = (value: unknown) => typeof value === 'string' && value.trim() ? value : '未知';
  const newer = newerRefresh(local, server);
  const advice = newer === null
    ? '无法比较哪份更新，覆盖可能替换仍可用的凭证。建议先在 Codex 中重新登录获取凭证。'
    : newer === 'local' ? `${localLabel}刷新时间较晚，覆盖本机可能回退凭证。` : '服务端刷新时间较晚，覆盖服务端可能回退凭证。';
  return `${localLabel}刷新时间：${time(local)}\n  服务端刷新时间：${time(server)}\n  ${advice}`;
}

export function switchChoices(credentials: Credential[], current: CurrentLogin, digest?: (email: string) => string | null) {
  const active = activeEmail(current);
  const choices = [
    ...credentials.map((credential) =>
      credential.email === active
        ? {
            value: credential as Credential | null,
            name: maskEmail(credential.email),
            description: '这是正在使用的账号',
            disabled: currentLabel(),
          }
        : { value: credential as Credential | null, name: maskEmail(credential.email),
          ...(digest?.(credential.email) === null ? { disabled: '(凭证不可用)', description: '保存的凭证文件缺失或损坏，请重新添加该账号。' } : {}) },
    ),
    divider(),
    { value: null, name: '返回', description: '回到主菜单' },
  ];
  const first = credentials.find((credential) => credential.email !== active && (!digest || digest(credential.email) !== null)) ?? null;
  return { choices, default: first };
}

export function resetCardChoices(credentials: Credential[], current: CurrentLogin) {
  const active = 'email' in current ? current.email : null;
  return [
    ...credentials.map((credential) => ({
      value: credential as Credential | null,
      name: credential.email === active
        ? `${styleText('dim', maskEmail(credential.email))} ${currentLabel()}`
        : maskEmail(credential.email),
    })),
    divider(),
    { value: null, name: '返回', description: '回到主菜单' },
  ];
}

export function deleteChoices(credentials: Credential[], digest: (email: string) => string | null) {
  return [
    ...credentials.map((credential) => ({
      value: credential as Credential | null,
      name: maskEmail(credential.email),
      ...(digest(credential.email) === null ? { description: '账号库中的凭证文件缺失或损坏' } : {}),
    })),
    divider(),
    { value: null, name: '返回', description: '回到主菜单' },
  ];
}

export function addChoices(current: CurrentLogin, authPath = '~/.codex/auth.json') {
  const codexDescription =
    current.status === 'none'
      ? `未找到 ${authPath}，请先在 Codex 中登录`
      : current.status === 'invalid'
        ? '登录文件无效或无法读取，请先在 Codex 中重新登录'
        : current.status === 'saved'
          ? `${maskEmail(current.email)} 已保存，与当前登录一致，无需更新`
          : current.status === 'ahead'
            ? `${maskEmail(current.email)} 有更新，将用当前登录更新已保存的凭证`
            : `${authPath}${current.email === null ? '' : ` · ${maskEmail(current.email)}`}`;
  return [
    {
      value: 'codex' as AddSource,
      name: '当前 Codex 登录',
      description: codexDescription,
      disabled: current.status === 'none' ? styleText('dim', '(未登录)') : current.status === 'invalid' ? styleText('dim', '(登录文件无效)') : false,
    },
    { value: 'file' as AddSource, name: '其他文件…', description: '手动输入 auth.json 的路径' },
    { value: 'browser' as AddSource, name: '浏览器登录', description: '通过服务端的官方 Codex CLI 登录 ChatGPT，添加后可选择切换' },
    divider(),
    { value: 'back' as AddSource, name: '返回', description: '回到主菜单' },
  ];
}

export function line(symbol: string, text: string, detail?: string): string {
  const head = `${symbol} ${text}`;
  if (!detail) {
    return head;
  }
  const columns = process.stdout.columns || 80;
  const separator = displayWidth(`${head}  ${detail}`) > columns ? '\n  ' : '  ';
  const available = separator.startsWith('\n') ? columns - 2 : columns - displayWidth(head) - 2;
  return `${head}${separator}${styleText('dim', wrapWords(detail, available).replaceAll('\n', '\n  '))}`;
}

export function fitPath(path: string, columns: number): string {
  const width = Math.max(1, columns);
  if (displayWidth(path) <= width) return path;
  const points = Array.from(path);
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const suffix = path.slice(separator);
  if (separator >= 0 && suffix.length < path.length && displayWidth(suffix) <= width - 2) {
    return `${fit(path.slice(0, path.length - suffix.length), width - displayWidth(suffix))}${suffix}`;
  }
  const head = fit(path, Math.max(1, Math.floor(width / 3)));
  let tail = '';
  while (points.length > 0 && displayWidth(head + points.at(-1)! + tail) <= width) tail = points.pop()! + tail;
  return head + tail;
}

export function pathLabel(label: string, path: string, columns = process.stdout.columns || 80): string {
  const inline = `${label}  ${path}`;
  return displayWidth(inline) <= columns ? inline : `${label}\n  ${fitPath(path, columns - 2)}`;
}

export function report(symbol: string, text: string, detail?: string): void {
  console.log(`${line(symbol, text, detail)}\n`);
}

export function cancelled(): void {
  console.log(line(styleText('dim', '·'), styleText('dim', '已取消。')));
}

const frames = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];

export async function withSpinner<T>(text: string, task: () => Promise<T>): Promise<T> {
  const output = process.stdout;
  const input = process.stdin;
  const wasRaw = input.isRaw;
  let index = 0;
  const render = () => {
    const label = fit(text, Math.max((output.columns || 80) - 3, 1));
    output.write(`\r\x1B[2K${styleText('cyan', frames[index % frames.length] ?? '')} ${label}`);
    index++;
  };
  const restore = () => output.write('\r\x1B[2K\x1B[?25h');
  const interrupt = () => {
    restore();
    cancelled();
    process.exit(0);
  };
  const discard = (data: Buffer) => {
    if (data.includes(3)) {
      interrupt();
    }
  };
  output.write('\x1B[?25l');
  render();
  const timer = setInterval(render, 80);
  process.once('SIGINT', interrupt);
  if (input.isTTY) {
    input.setRawMode(true);
  }
  input.on('data', discard);
  input.resume();
  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.off('SIGINT', interrupt);
    input.off('data', discard);
    input.pause();
    if (input.isTTY) {
      input.setRawMode(wasRaw);
    }
    restore();
  }
}
