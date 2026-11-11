import { input, password, select } from '@inquirer/prompts';
import { readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { styleText } from 'node:util';
import { isRecord, parseAuth } from './auth.js';
import type { Session } from './client.js';
import { expandPath } from './files.js';
import { ServiceError } from './protocol.js';
import type { Credential, CurrentLogin } from './protocol.js';
import { confirmRunningCodex } from './switch.js';
import {
  addChoices,
  describeCurrent,
  inputTheme,
  line,
  report,
  mainChoices,
  menuTheme,
  needsBackup,
  renderStatus,
  selectTheme,
  switchChoices,
  symbols,
  withSpinner,
} from './ui.js';
import type { AddSource } from './ui.js';

const BACK = Symbol('back');

interface PromptContext {
  signal: AbortSignal;
  clearPromptOnDone: boolean;
}

async function escapable<T>(run: (context: PromptContext) => Promise<T>): Promise<T | typeof BACK> {
  const controller = new AbortController();
  const onKeypress = (_: string, key?: { name?: string }) => {
    if (key?.name === 'escape') {
      controller.abort();
    }
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKeypress);
  try {
    return await run({ signal: controller.signal, clearPromptOnDone: true });
  } catch (error) {
    if (controller.signal.aborted && error instanceof Error && error.name === 'AbortPromptError') {
      return BACK;
    }
    throw error;
  } finally {
    process.stdin.off('keypress', onKeypress);
  }
}

export function isCancel(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError');
}

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
      return `找不到文件：${path}`;
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return `没有权限访问：${path}`;
    }
    if (error.code === 'EISDIR') {
      return `这是一个目录，不是 auth.json 文件：${path}`;
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
      return `这是一个目录，请输入 auth.json 文件的路径：${tildify(store, path)}`;
    }
    parseAuth(await readFile(path, 'utf8'));
    return true;
  } catch (error) {
    return describeError(store, error);
  }
}

async function saveFrom(store: Session, credentials: Credential[], path: string, base?: string | null): Promise<Credential> {
  const credential = await store.add(path, base, (task) => withSpinner('正在向 ChatGPT 查询账号邮箱…', task));
  const existed = credentials.some((entry) => entry.email === credential.email);
  report(symbols.success, `${existed ? '已更新' : '已保存'} ${styleText('bold', credential.email)}`, tildify(store, expandPath(store.userHome, path)));
  return credential;
}

async function trySave(store: Session, credentials: Credential[], path: string, base?: string | null): Promise<Credential | null> {
  try {
    return await saveFrom(store, credentials, path, base);
  } catch (error) {
    if (isCancel(error)) {
      throw error;
    }
    const message = describeError(store, error);
    const shown = tildify(store, expandPath(store.userHome, path));
    report(symbols.failure, styleText('red', `保存失败：${message}`), message.includes(shown) ? undefined : shown);
    return null;
  }
}

async function askPath(store: Session, previous: string) {
  return escapable((context) =>
    input(
      {
        message: `auth.json 路径 ${styleText('dim', '(esc 返回)')}`,
        validate: (value) => validatePath(store, value),
        theme: inputTheme,
        ...(previous ? { default: previous, prefill: 'editable' as const } : {}),
      },
      context,
    ),
  );
}

async function addFlow(store: Session, credentials: Credential[], current: CurrentLogin): Promise<void> {
  let source: AddSource = current.status === 'none' || current.status === 'saved' ? 'file' : 'codex';
  let previous = '';
  for (;;) {
    const choice = await escapable((context) =>
      select(
        { message: '从哪里添加？', choices: addChoices(current), default: source, theme: selectTheme('返回') },
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
      if (latest.status === 'none') {
        report(symbols.failure, styleText('red', '未找到 ~/.codex/auth.json，请先在 Codex 中登录。'));
        source = 'file';
        continue;
      }
      if (latest.status === 'behind') { report(symbols.info, '服务端版本更新，无需保存。'); return; }
      if (latest.status === 'saved') {
        report(symbols.info, `${styleText('bold', latest.email)} 已是最新，无需更新`, '~/.codex/auth.json 与已保存的凭证一致');
        return;
      }
      if (latest.status === 'diverged') {
        const decision = await resolveDivergence(store, latest.email);
        if (decision !== 'upload') return;
        if (await trySave(store, credentials, store.codexAuthPath, store.snapshotDigest(latest.email))) return;
        continue;
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

async function confirmOverwrite(current: Extract<CurrentLogin, { status: 'ahead' | 'diverged' | 'unsaved' }>, target: Credential) {
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

async function resolveDivergence(store: Session, email: string): Promise<'upload' | 'download' | 'back'> {
  const refreshTimes = await store.refreshTimes(email);
  const decision = await escapable((context) => select({
    message: `${email} 与服务端版本不一致\n  ${refreshTimes}`,
    choices: [{ value: 'upload' as const, name: '用本机登录覆盖服务端' }, { value: 'download' as const, name: '用服务端版本覆盖本机' }, { value: 'back' as const, name: '返回' }],
    default: 'back',
    theme: selectTheme('返回'),
  }, context));
  if (decision === 'download') {
    if (await confirmRunningCodex({ ask: askRunningCodex, log: logRunningCodex })) {
      await store.switch({ type: 'codex', email });
      return 'download';
    }
    return 'back';
  }
  return decision === 'upload' ? 'upload' : 'back';
}

async function backupBeforeSwitch(store: Session, credentials: Credential[], target: Credential) {
  const current = await store.current();
  if (!needsBackup(current)) {
    return 'switch' as const;
  }
  if (current.status === 'diverged') {
    const decision = await resolveDivergence(store, current.email);
    if (decision === 'back') return 'back' as const;
    if (decision === 'download') return 'switch' as const;
    return await trySave(store, credentials, store.codexAuthPath, store.snapshotDigest(current.email)) ? 'switch' as const : 'back' as const;
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

async function askRunningCodex({ message }: { message: string; default: boolean }): Promise<boolean> {
  const answer = await escapable((context) =>
    select(
      {
        message,
        choices: [
          { value: false, name: '取消，先退出 Codex', description: '回到主菜单，当前凭证不变' },
          { value: true, name: '仍然切换', description: '正在运行的会话后续请求可能受影响' },
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
      if (!(await confirmRunningCodex({ ask: askRunningCodex, log: logRunningCodex }))) {
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

export async function askPairing(url: string) {
  report(symbols.info, `${url} 需要配对`, '请在服务端运行 codexplus serve pair 获取配对码');
  const code = await password({ message: '服务端生成的配对码', mask: true, theme: inputTheme,
    validate: (value) => Boolean(value.trim()) || '请输入配对码。' });
  const name = await input({ message: '客户端名称', default: hostname(), theme: inputTheme,
    validate: (value) => (Boolean(value.trim()) && value.length <= 100) || '请输入名称，最多 100 字符。' });
  console.log('');
  return { code, name };
}

export async function menu(store: Session): Promise<void> {
  console.log(`${styleText('dim', '服务端  ')}  ${store.server === 'local' ? `本机（目录 ${store.home}）` : store.url}`);
  for (;;) {
    const credentials = await store.list();
    const current = await store.current();
    const menu = mainChoices(credentials, current);
    const action = await escapable((context) =>
      select(
        {
          message: `${renderStatus(current, credentials.length)}\n\n${styleText('cyan', '?')} ${styleText('bold', '要做什么？')}`,
          choices: menu.choices,
          default: menu.default,
          theme: menuTheme(),
        },
        context,
      ),
    );
    if (action === BACK || action === 'exit') {
      console.log(`${styleText('dim', '当前账号')}  ${describeCurrent(current)}\n`);
      return;
    }

    try {
      if (action === 'delete') {
        const selected = await escapable((context) => select({ message: '删除哪个账号？', choices: [...credentials.map((value) => ({ value, name: value.email })), { value: null, name: '返回' }] }, context));
        if (selected && selected !== BACK) {
          const confirmed = await escapable((context) => select({ message: `确认删除 ${selected.email}？${current.status !== 'none' && current.email === selected.email ? '本机 ~/.codex/auth.json 不受影响。' : ''}`, choices: [{ value: false, name: '取消' }, { value: true, name: '删除' }], default: false }, context));
          if (confirmed === true) {
            try { await store.delete(selected); report(symbols.success, '已删除账号。'); } catch (error) {
              if (error instanceof ServiceError && error.status === 409) report(symbols.warning, '该账号在服务端已被更新，请刷新列表后重新决定。');
              else throw error;
            }
          }
        }
      } else if (action === 'update' && current.status !== 'none' && current.email) {
        if (await confirmRunningCodex({ ask: askRunningCodex, log: logRunningCodex })) await store.switch({ type: 'codex', email: current.email });
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

