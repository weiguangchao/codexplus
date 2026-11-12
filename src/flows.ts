import { select } from '@inquirer/prompts';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { styleText } from 'node:util';
import { isRecord, parseAuth } from './auth.js';
import { UploadCancelled } from './client.js';
import type { Session } from './client.js';
import { expandPath } from './files.js';
import { BACK, escapable, isCancel } from './prompts.js';
import { pathInput } from './path-input.js';
import { ServiceError } from './protocol.js';
import type { Credential, CurrentLogin } from './protocol.js';
import { confirmRunningCodex } from './switch.js';
import {
  addChoices,
  describeCurrent,
  deleteChoices,
  fitPath,
  line,
  report,
  mainChoices,
  pathLabel,
  menuTheme,
  needsBackup,
  renderStatus,
  refreshDetails,
  selectTheme,
  switchChoices,
  symbols,
  withSpinner,
} from './ui.js';
import type { AddSource } from './ui.js';

function tildify(store: Session, path: string): string {
  const inside = relative(store.userHome, path);
  if (inside === '') {
    return '~';
  }
  return inside.startsWith('..') || isAbsolute(inside) ? path : `~${sep}${inside}`;
}

function describeError(store: Session, error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    const path = typeof error.path === 'string' ? tildify(store, error.path) : '';
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return pathLabel('找不到文件：', path, (process.stdout.columns || 80) - 2);
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return pathLabel('没有权限访问：', path, (process.stdout.columns || 80) - 2);
    }
    if (error.code === 'EISDIR') {
      return pathLabel('这是目录，请输入文件路径：', path, (process.stdout.columns || 80) - 2);
    }
  }
  return error instanceof Error && error.message ? error.message : '操作失败，请重试。';
}

async function validatePath(store: Session, value: string): Promise<string | true> {
  if (!value.trim()) {
    return '请输入 auth.json 的路径。';
  }
  const path = expandPath(store.userHome, value);
  try {
    if (!(await stat(path)).isFile()) {
      return pathLabel('这是目录，请输入文件路径：', tildify(store, path), (process.stdout.columns || 80) - 2);
    }
    parseAuth(await readFile(path, 'utf8'));
    return true;
  } catch (error) {
    return describeError(store, error);
  }
}

async function saveFrom(store: Session, credentials: Credential[], path: string, base?: string | null): Promise<Credential> {
  const { credential, changed } = await store.add(path, base, (task) => withSpinner('正在向 ChatGPT 查询账号邮箱…', task));
  const existed = credentials.some((entry) => entry.email === credential.email);
  report(symbols.success, `${changed ? existed ? '已更新' : '已保存' : '已是最新，无需更新'} ${styleText('bold', credential.email)}`, fitPath(tildify(store, expandPath(store.userHome, path)), (process.stdout.columns || 80) - 2));
  return credential;
}

async function trySave(store: Session, credentials: Credential[], path: string, base?: string | null): Promise<Credential | null> {
  try {
    return await saveFrom(store, credentials, path, base);
  } catch (error) {
    if (isCancel(error)) {
      throw error;
    }
    if (error instanceof UploadCancelled) {
      report(symbols.info, error.message);
      return null;
    }
    const message = describeError(store, error);
    const shown = tildify(store, expandPath(store.userHome, path));
    report(symbols.failure, styleText('red', `保存失败：${message}`), isRecord(error) && typeof error.path === 'string' || message.includes(shown) ? undefined : fitPath(shown, (process.stdout.columns || 80) - 2));
    return null;
  }
}

async function askPath(store: Session, previous: string) {
  return escapable((context) => pathInput({ initial: previous, validate: (value) => validatePath(store, value) }, context));
}

async function addFlow(store: Session, credentials: Credential[], current: CurrentLogin): Promise<void> {
  let source: AddSource = current.status === 'none' || current.status === 'invalid' || current.status === 'saved' ? 'file' : 'codex';
  let previous = '';
  for (;;) {
    const choice = await escapable((context) =>
      select(
        { message: '从哪里添加？\n仅支持 ChatGPT 登录凭证。\n不接受只有 API key 的文件。', choices: addChoices(current, tildify(store, store.codexAuthPath)), default: source, theme: selectTheme('返回') },
        context,
      ),
    );
    if (choice === BACK || choice === 'back') {
      return;
    }
    source = choice;
    if (choice === 'codex') {
      const latest = await store.current();
      current = latest;
      if (latest.status === 'none' || latest.status === 'invalid') {
        report(symbols.failure, styleText('red', latest.status === 'none' ? `未找到 ${tildify(store, store.codexAuthPath)}，请先在 Codex 中登录。` : `${latest.reason} 请先在 Codex 中重新登录。`));
        source = 'file';
        continue;
      }
      if (latest.status === 'behind') {
        report(symbols.info, `服务端保存的 ${styleText('bold', latest.email)} 版本更新，无需保存`, '可在主菜单选择「更新本机登录」');
        return;
      }
      if (latest.status === 'saved') {
        report(symbols.info, `${styleText('bold', latest.email)} 已是最新，无需更新`, `${fitPath(tildify(store, store.codexAuthPath), (process.stdout.columns || 80) - 2)} 与已保存的凭证一致`);
        return;
      }
      if (latest.status === 'diverged') {
        const decision = await resolveDivergence(store, latest.email, false);
        if (decision === 'back') {
          continue;
        }
        if (decision === 'local' && !await trySave(store, credentials, store.codexAuthPath, store.snapshotDigest(latest.email))) {
          continue;
        }
        return;
      }
      if (await trySave(store, credentials, store.codexAuthPath)) {
        return;
      }
      continue;
    }
    for (;;) {
      const path = await askPath(store, previous);
      if (path === BACK) {
        break;
      }
      previous = path;
      if (await trySave(store, credentials, path)) {
        return;
      }
    }
  }
}

async function confirmOverwrite(current: Extract<CurrentLogin, { status: 'ahead' | 'diverged' | 'unsaved' | 'deleted' }>, target: Credential) {
  const warning =
    current.status === 'ahead'
      ? `当前登录 ${current.email} 有更新尚未保存，切换后会被覆盖。`
      : `${current.email === null ? '当前 Codex 登录' : `当前登录 ${current.email} `}尚未保存，切换后会被覆盖。`;
  const save = current.status === 'ahead' ? '先更新保存，再切换' : '先保存当前登录，再切换';
  return escapable((context) =>
    select(
      {
        message: `即将切换到 ${styleText('cyan', target.email)}\n  ${styleText('yellow', warning)}`,
        choices: [
          { value: 'save' as const, name: save, description: '保存后再切换，之后可以随时切回来' },
          { value: 'overwrite' as const, name: '不保存，直接切换', description: '当前登录的最新凭证将被覆盖，无法恢复' },
          { value: 'back' as const, name: '返回', description: '重新选择账号' },
        ],
        theme: selectTheme('返回'),
      },
      context,
    ),
  );
}

async function downloadCurrent(store: Session, email: string): Promise<boolean> {
  if (!(await confirmRunningCodex({ action: 'update', authPath: fitPath(tildify(store, store.codexAuthPath), (process.stdout.columns || 80) - 4), ask: askRunningCodex, log: logRunningCodex }))) {
    console.log('');
    return false;
  }
  await store.switch({ type: 'codex', email });
  console.log(line(symbols.success, `已用服务端版本更新本机登录 ${styleText('bold', email)}`));
  report(' ', styleText('dim', '请重新启动正在运行的 Codex 会话以使用更新后的凭证。'));
  return true;
}

async function resolveDivergence(store: Session, email: string, switching: boolean): Promise<'local' | 'server' | 'back'> {
  const times = await store.refreshTimes(email);
  const decision = await escapable((context) => select({
    message: `${styleText('bold', email)} 的本机登录与服务端保存的版本不一致\n  ${styleText('dim', refreshDetails(times.local, times.server))}`,
    choices: [
      { value: 'local' as const, name: switching ? '先用本机登录覆盖服务端，再切换' : '用本机登录覆盖服务端', description: '服务端保存的版本将被替换，无法恢复' },
      switching
        ? { value: 'server' as const, name: '不保存，直接切换', description: '本机登录将被覆盖，服务端保存的版本不变' }
        : { value: 'server' as const, name: '用服务端版本覆盖本机', description: `下载服务端保存的版本并写入 ${tildify(store, store.codexAuthPath)}` },
      { value: 'back' as const, name: '返回', description: switching ? '重新选择账号' : '不做更改' },
    ],
    default: 'back',
    theme: selectTheme('返回'),
  }, context));
  if (decision === BACK || decision === 'back') {
    return 'back';
  }
  if (decision === 'server' && !switching) {
    return await downloadCurrent(store, email) ? 'server' : 'back';
  }
  return decision;
}

async function backupBeforeSwitch(store: Session, credentials: Credential[], target: Credential) {
  const current = await store.current();
  if (!needsBackup(current)) {
    return 'switch' as const;
  }
  if (current.status === 'diverged') {
    const decision = await resolveDivergence(store, current.email, true);
    if (decision === 'back') {
      return 'back' as const;
    }
    if (decision === 'server') {
      return 'switch' as const;
    }
    const saved = await trySave(store, credentials, store.codexAuthPath, store.snapshotDigest(current.email));
    if (saved?.email === target.email) {
      report(symbols.info, `${saved.email} 就是当前登录的账号，无需切换。`);
      return 'done' as const;
    }
    return saved ? 'switch' as const : 'back' as const;
  }
  for (;;) {
    const decision = await confirmOverwrite(current, target);
    if (decision === BACK || decision === 'back') {
      return 'back' as const;
    }
    if (decision === 'overwrite') {
      return 'switch' as const;
    }
    const saved = await trySave(store, credentials, store.codexAuthPath);
    if (saved?.email === target.email) {
      report(symbols.info, `${saved.email} 就是当前登录的账号，无需切换。`);
      return 'done' as const;
    }
    if (saved) {
      return 'switch' as const;
    }
  }
}

function logRunningCodex(message: string): void {
  if (message.startsWith('  ')) {
    console.log(styleText('dim', message));
  } else if (message.startsWith('检测到')) {
    console.log(line(symbols.warning, styleText('yellow', message)));
  } else {
    console.log(line(' ', styleText('dim', message)));
  }
}

async function askRunningCodex({ message, action }: { message: string; default: boolean; action?: 'switch' | 'update' }): Promise<boolean> {
  const answer = await escapable((context) =>
    select(
      {
        message,
        choices: [
          { value: false, name: '取消，先退出 Codex', description: '回到主菜单，当前凭证不变' },
          { value: true, name: action === 'update' ? '仍然更新' : '仍然切换', description: '将改写本机凭证，正在运行的会话后续请求可能受影响' },
        ],
        default: false,
        theme: selectTheme('取消'),
      },
      context,
    ),
  );
  if (answer === true) {
    console.log('');
  }
  return answer === true;
}

async function switchFlow(store: Session, credentials: Credential[], current: CurrentLogin): Promise<boolean> {
  const menu = switchChoices(credentials, current);
  if (menu.default === null) {
    report(symbols.info, '已保存的账号只有当前这一个，请先添加其他账号。');
    return false;
  }
  let selected = menu.default;
  for (;;) {
    const target = await escapable((context) =>
      select(
        { message: '切换到哪个账号？', choices: menu.choices, default: selected, theme: selectTheme('返回'), pageSize: 10 },
        context,
      ),
    );
    if (target === BACK || target === null) {
      return false;
    }
    selected = target;

    const next = await backupBeforeSwitch(store, credentials, target);
    if (next === 'back') {
      continue;
    }
    if (next === 'switch') {
      if (!(await confirmRunningCodex({ authPath: fitPath(tildify(store, store.codexAuthPath), (process.stdout.columns || 80) - 4), ask: askRunningCodex, log: logRunningCodex }))) {
        console.log('');
        return false;
      }
      await store.switch(target);
      console.log(line(symbols.success, `已切换到 ${styleText('bold', target.email)}`));
      report(' ', styleText('dim', '请重新启动正在运行的 Codex 会话以使用新账号。'));
    }
    return true;
  }
}

async function deleteFlow(store: Session, credentials: Credential[], current: CurrentLogin): Promise<void> {
  const selected = await escapable((context) => select({
    message: '删除哪个账号？',
    choices: deleteChoices(credentials, (email) => store.snapshotDigest(email)),
    default: null,
    theme: selectTheme('返回'),
    pageSize: 10,
  }, context));
  if (selected === BACK || selected === null) {
    return;
  }
  const active = 'email' in current && current.email === selected.email;
  const confirmed = await escapable((context) => select({
    message: `确认从服务端删除 ${styleText('cyan', selected.email)}？\n  ${styleText('yellow', '删除后无法恢复。')}${active ? styleText('dim', ` 本机 ${tildify(store, store.codexAuthPath)} 不受影响。`) : ''}`,
    choices: [
      { value: false, name: '取消', description: '保留该账号' },
      { value: true, name: '删除', description: '从服务端移除该账号保存的凭证' },
    ],
    default: false,
    theme: selectTheme('取消'),
  }, context));
  if (confirmed !== true) {
    return;
  }
  try {
    await store.delete(selected);
    report(symbols.success, `已删除 ${styleText('bold', selected.email)}`, active ? '已从凭证库删除，本机登录保留' : undefined);
  } catch (error) {
    if (!(error instanceof ServiceError) || error.status !== 409) {
      throw error;
    }
    report(symbols.warning, styleText('yellow', `${selected.email} 在服务端已被更新，未删除。`), '列表已刷新，请重新决定');
  }
}

export async function menu(store: Session): Promise<void> {
  if (store.server === 'local') {
    console.log(`${styleText('dim', '服务端')}  本机`);
    console.log(pathLabel(styleText('dim', '数据目录'), store.home));
  } else console.log(pathLabel(styleText('dim', '服务端'), store.url));
  const authPath = tildify(store, store.codexAuthPath);
  console.log(pathLabel(styleText('dim', '登录文件'), authPath));
  for (;;) {
    const credentials = await store.list();
    const current = await store.current();
    const menu = mainChoices(credentials, current, authPath);
    const action = await escapable((context) =>
      select(
        {
          message: `${renderStatus(current, credentials.length, authPath)}\n\n${styleText('cyan', '?')} ${styleText('bold', '要做什么？')}`,
          choices: menu.choices,
          default: menu.default,
          theme: menuTheme(),
        },
        context,
      ),
    );
    if (action === BACK || action === 'exit') {
      console.log(`${styleText('dim', '当前账号')}  ${describeCurrent(current, authPath)}\n`);
      return;
    }

    try {
      if (action === 'delete') {
        await deleteFlow(store, credentials, current);
      } else if (action === 'update') {
        if (current.status === 'behind') {
          await downloadCurrent(store, current.email);
        }
      } else if (action === 'switch') {
        if (await switchFlow(store, credentials, current)) {
          return;
        }
      } else {
        await addFlow(store, credentials, current);
      }
    } catch (error) {
      if (isCancel(error)) {
        throw error;
      }
      report(symbols.failure, styleText('red', describeError(store, error)));
    }
  }
}
