import figures, { mainSymbols } from '@inquirer/figures';
import { Separator } from '@inquirer/prompts';
import stringWidth from 'fast-string-width';
import { styleText } from 'node:util';
import { newerRefresh } from './auth.js';
import type { Credential, CurrentLogin } from './protocol.js';

export type MainAction = 'switch' | 'add' | 'update' | 'delete' | 'exit';
export type AddSource = 'codex' | 'file' | 'back';

const unicode = figures.tick === mainSymbols.tick;
const dots = { filled: unicode ? '●' : figures.circleFilled, empty: unicode ? '○' : figures.circle };
const keyLabels: Record<string, string> = { navigate: '移动', select: '确认' };

export const symbols = {
  success: styleText('green', figures.tick),
  failure: styleText('red', figures.cross),
  warning: styleText('yellow', figures.warning),
  info: styleText('cyan', figures.info),
};

const divider = () => new Separator(styleText('dim', ` ${figures.line.repeat(6)}`));
const prefix = { idle: styleText('cyan', '?'), done: styleText('green', figures.tick) };
const error = (text: string) => `${symbols.failure} ${styleText('red', wrapWords(text, (process.stdout.columns || 80) - 2).replaceAll('\n', '\n  '))}`;

export function selectTheme(escapeLabel: string) {
  return {
    prefix,
    style: {
      error,
      disabled: (text: string) => styleText('dim', text.replace(/^- /u, '  ')),
      description: (text: string) => styleText('dim', wrapWords(text, (process.stdout.columns || 80) - 2)),
      keysHelpTip: (keys: [string, string][]) =>
        [...keys, ['esc', escapeLabel] as [string, string]]
          .map(([key, action]) => `${styleText('bold', key)} ${styleText('dim', keyLabels[action] ?? action)}`)
          .join(styleText('dim', ' · ')),
    },
    i18n: { disabledError: '该选项暂不可用，原因见上方说明。' },
  };
}

export const inputTheme = { prefix, style: { error } };

export function menuTheme() {
  const theme = selectTheme('退出');
  return { ...theme, prefix: { idle: '', done: '' }, style: { ...theme.style, message: (text: string) => text } };
}

function activeEmail(current: CurrentLogin): string | null {
  return current.status === 'saved' || current.status === 'ahead' ? current.email : null;
}

export function needsBackup(current: CurrentLogin): current is Extract<CurrentLogin, { status: 'ahead' | 'diverged' | 'unsaved' | 'deleted' }> {
  return current.status === 'ahead' || current.status === 'diverged' || current.status === 'unsaved' || current.status === 'deleted';
}

export function describeCurrent(current: CurrentLogin, authPath = '~/.codex/auth.json'): string {
  const dot = (color: 'green' | 'yellow') => styleText(color, dots.filled);
  if (current.status === 'saved') {
    return `${dot('green')} ${styleText('bold', current.email)}`;
  }
  if (current.status === 'behind' || current.status === 'diverged') {
    const note = current.status === 'behind' ? '服务端有更新版本' : '与服务端版本不一致';
    return `${dot('yellow')} ${styleText('bold', current.email)} ${styleText('yellow', note)}`;
  }
  if (current.status === 'ahead') {
    return `${dot('yellow')} ${styleText('bold', current.email)} ${styleText('yellow', '有更新未保存')}`;
  }
  if (current.status === 'deleted') {
    return `${dot('yellow')} ${styleText('bold', current.email)} ${styleText('dim', '已从凭证库删除，本机登录保留')}`;
  }
  if (current.status === 'unsaved') {
    return current.email === null
      ? `${dot('yellow')} ${styleText('yellow', '无法识别')} ${styleText('dim', '与已保存的账号都不一致')}`
      : `${dot('yellow')} ${styleText('bold', current.email)} ${styleText('yellow', '未保存')}`;
  }
  if (current.status === 'invalid') {
    return `${dot('yellow')} ${styleText('yellow', '登录文件无效或无法读取')}\n  ${current.reason}\n  请先在 Codex 中重新登录，或从其他文件添加有效凭证。`;
  }
  return styleText('dim', `${dots.empty} 未登录\n  未找到登录文件：\n  ${fitPath(authPath, (process.stdout.columns || 80) - 2)}`);
}

export function renderTitle(version: string): string {
  const meta = [version ? `v${version}` : '', 'Codex 账号切换'].filter(Boolean).join(' · ');
  return `\n${styleText(['bold', 'cyan'], 'codexplus')} ${styleText('dim', meta)}\n`;
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
              ? '当前登录与服务端保存的版本不一致，可以选择保留哪一份。'
              : '保存一个 auth.json，同一邮箱已保存时会先确认再覆盖';
  const choices = [
    ...(current.status === 'behind'
      ? [{ value: 'update' as const, name: '更新本机登录', description: `下载服务端保存的 ${current.email} 新版本，写入 ${authPath}` }]
      : []),
    {
      value: 'switch' as const,
      name: '切换账号',
      description: switchDescription,
      disabled: others === 0 ? styleText('dim', credentials.length === 0 ? '(暂无账号)' : '(没有其他账号)') : false,
    },
    { value: 'add' as const, name: '添加账号', description: addDescription },
    {
      value: 'delete' as const,
      name: '删除账号',
      description: '从服务端删除一个已保存的账号，本机登录不受影响',
      disabled: credentials.length === 0 ? styleText('dim', '(暂无账号)') : false,
    },
    divider(),
    { value: 'exit' as const, name: '退出', description: '退出 codexplus' },
  ];
  const fallback: MainAction = others === 0 || needsBackup(current) ? 'add' : 'switch';
  const defaultAction: MainAction = current.status === 'invalid' ? others > 0 ? 'switch' : 'exit'
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

export function switchChoices(credentials: Credential[], current: CurrentLogin) {
  const active = activeEmail(current);
  const choices = [
    ...credentials.map((credential) =>
      credential.email === active
        ? {
            value: credential as Credential | null,
            name: credential.email,
            description: '这是正在使用的账号',
            disabled: styleText('green', `${dots.filled} 当前`),
          }
        : { value: credential as Credential | null, name: credential.email },
    ),
    divider(),
    { value: null, name: '返回', description: '回到主菜单' },
  ];
  const first = credentials.find((credential) => credential.email !== active) ?? null;
  return { choices, default: first };
}

export function deleteChoices(credentials: Credential[], digest: (email: string) => string | null) {
  return [
    ...credentials.map((credential) => ({
      value: credential as Credential | null,
      name: credential.email,
      ...(digest(credential.email) === null ? { description: '服务端保存的凭证文件缺失或损坏' } : {}),
    })),
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
          ? `${current.email} 已保存，与当前登录一致，无需更新`
          : current.status === 'ahead'
            ? `${current.email} 有更新，将用当前登录更新已保存的凭证`
            : `${authPath}${current.email === null ? '' : ` · ${current.email}`}`;
  return [
    {
      value: 'codex' as AddSource,
      name: '当前 Codex 登录',
      description: codexDescription,
      disabled: current.status === 'none' ? styleText('dim', '(未登录)') : current.status === 'invalid' ? styleText('dim', '(登录文件无效)') : false,
    },
    { value: 'file' as AddSource, name: '其他文件…', description: '手动输入 auth.json 的路径' },
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

export function wrapWords(text: string, columns: number): string {
  const width = Math.max(1, columns);
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  return text.split('\n').map((paragraph) => {
    const words: string[] = [];
    for (const { segment } of segmenter.segment(paragraph)) {
      const previous = words.at(-1);
      if (previous && (/^[，。；：！？、）】》」』,.!?;:]+$/u.test(segment) || /^[\w~./\\:@+-]+$/u.test(segment) && /^[\w~./\\:@+-]+$/u.test(previous))) words[words.length - 1] += segment;
      else words.push(segment);
    }
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      if (line && displayWidth(line + word) > width) { lines.push(line.trimEnd()); line = ''; }
      line += line ? word : word.trimStart();
    }
    lines.push(line.trimEnd());
    return lines.join('\n');
  }).join('\n');
}

export function report(symbol: string, text: string, detail?: string): void {
  console.log(`${line(symbol, text, detail)}\n`);
}

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function fit(text: string, columns: number): string {
  const characters = Array.from(text);
  const widths = characters.map((character) => displayWidth(character));
  if (widths.reduce((total, width) => total + width, 0) <= columns) {
    return text;
  }
  let width = 1;
  let count = 0;
  while (count < characters.length && width + (widths[count] ?? 0) <= columns) {
    width += widths[count] ?? 0;
    count++;
  }
  return `${characters.slice(0, count).join('')}…`;
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
