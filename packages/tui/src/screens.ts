import { styleText } from 'node:util';
import type { CurrentLogin } from '@weiguangchao/codexplus-shared';
import { describeCurrent, fitPath, maskEmail } from './ui.js';
import { fit } from './text-layout.js';
import { glyph } from './terminal-symbols.js';

export function stepTitle(section: string, title: string, detail = ''): string {
  return [styleText('dim', `codexplus / ${section}`), styleText('bold', title), detail].filter(Boolean).join('\n');
}

export function renderHome(current: CurrentLogin, count: number, version = '', columns = process.stdout.columns || 80): string {
  const width = Math.max(8, columns - 1);
  const title = `codexplus${version ? `  v${version}` : ''}`;
  const hints: Record<CurrentLogin['status'], string> = {
    saved: '登录已保存，可以随时切换。',
    ahead: '建议先保存当前登录，再切换账号。',
    behind: '账号库有更新，可更新本机登录。',
    diverged: '两份凭证不同，保存时可选择保留哪一份。',
    deleted: '本机仍可使用；添加账号可重新保存。',
    unsaved: '先保存当前登录，之后可以随时切回来。',
    invalid: '请重新登录，或添加其他有效凭证。',
    none: count === 0 ? '添加第一个账号，开始管理 Codex 登录。' : '切换到已保存的账号，或添加新账号。',
  };
  const currentLine = current.status === 'none' ? styleText('dim', `${glyph.empty} 未登录`)
    : current.status === 'invalid' ? styleText('yellow', `${glyph.filled} 登录文件无效或无法读取`)
    : describeCurrent(current);
  return [
    styleText(['bold', 'cyan'], fit(title, width)),
    '',
    styleText('dim', `当前账号  ·  账号库 ${count} 个`),
    currentLine,
    styleText('dim', current.status === 'invalid' ? `${current.reason}\n${hints.invalid}` : hints[current.status]),
  ].join('\n');
}

export function renderLocations(home: string, authPath: string, connection: string): string {
  return [stepTitle('位置与连接', '文件与本机服务'), '', `账号库\n${home}`, '', `登录文件\n${authPath}`, '',
    `本机服务\n${connection}`, '', '切换账号会更新上面的登录文件。'].join('\n');
}

export function homeSummary(current: CurrentLogin, count: number): string {
  const states: Record<CurrentLogin['status'], string> = { saved: '已保存', ahead: '有更新未保存', behind: '账号库有更新版本',
    diverged: '与账号库版本不一致', deleted: '已从账号库删除', unsaved: '未保存', invalid: '登录文件无效', none: '未登录' };
  const account = 'email' in current ? current.email === null ? '无法识别账号' : maskEmail(current.email) : states[current.status];
  return [styleText(['bold', 'cyan'], `codexplus  ${count} 个账号`), account,
    ...('email' in current ? [styleText(current.status === 'saved' ? 'green' : 'yellow', states[current.status])] : [])].join('\n');
}

export function locationSummary(home: string, authPath: string, connection: string, columns: number): string {
  const width = Math.max(8, columns - 1);
  const match = /^(自带服务端|独立服务端)\s+(.+)$/u.exec(connection);
  const kind = match ? match[1] === '自带服务端' ? '自带' : '独立' : '';
  const address = match?.[2] ?? connection;
  let endpoint: string;
  try { endpoint = new URL(address).host; } catch { endpoint = address; }
  return ['位置与连接', `账号库 ${fitPath(home, width - 7)}`, `登录文件 ${fitPath(authPath, width - 9)}`,
    `本机服务 ${kind}`.trimEnd(), fit(endpoint, width)].join('\n');
}
