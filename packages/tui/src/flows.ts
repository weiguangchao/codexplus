import { writeOutput, isRecord, ServiceError } from '@weiguangchao/codexplus-shared';
import { select } from './select.js';
import { isAbsolute, relative, sep } from 'node:path';
import { styleText } from 'node:util';
import { UploadCancelled } from './client.js';
import type { Session } from './client.js';
import { BACK, escapable, isCancel } from './prompts.js';
import { pathInput } from './path-input.js';
import { browserLoginPrompt } from './browser-prompt.js';
import { resetCardFlow } from './reset-cards.js';
import { accountInfoFlow } from './account-info.js';
import { antigravityFlow } from './antigravity.js';
import { homeSummary, locationSummary, renderHome, renderLocations, stepTitle } from './screens.js';
import type { AuthDigest, Credential, CurrentLogin, Email } from '@weiguangchao/codexplus-shared';
import { confirmRunningCodex } from './switch.js';
import { askRunningCodex, logRunningCodex } from './process-prompt.js';
import {
  addChoices,
  describeCurrent,
  deleteChoices,
  fitPath,
  line,
  maskEmail,
  maskHomePath,
  report,
  mainChoices,
  pathLabel,
  needsBackup,
  refreshDetails,
  selectTheme,
  switchChoices,
  symbols,
  withSpinner,
} from './ui.js';
import type { AddSource, MainAction } from './ui.js';

function tildify({ store, path }: { store: Session; path: string }): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(store.userHome, path);
  if (inside === '') {
    return '~';
  }
  return inside.startsWith('..') || isAbsolute(inside) ? path : `~${sep}${inside}`;
}

function describeError({ store, error }: { store: Session; error: unknown }): string {
  if (error instanceof ServiceError && isRecord(error.details) && typeof error.details.code === 'string') return describeError({ store, error: { ...error.details, message: error.message } });
  if (isRecord(error) && typeof error.code === 'string') {
    const path = typeof error.path === 'string' ? tildify({ store, path: error.path }) : '';
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

async function validatePath({ store, value }: { store: Session; value: string }): Promise<string | true> {
  if (!value.trim()) {
    return '请输入 auth.json 的路径。';
  }
  try {
    await store.validateSource(value);
    return true;
  } catch (error) {
    return describeError({ store, error });
  }
}

async function saveFrom({ store, credentials, path, base }: { store: Session; credentials: Credential[]; path: string; base?: AuthDigest | null | undefined }): Promise<Credential> {
  const upload = (task: () => Promise<unknown>) => withSpinner({ text: '正在向 ChatGPT 查询账号邮箱…', task });
  const { credential, changed } = path === store.codexAuthPath ? await store.saveCurrent({ base, upload }) : await store.add({ path, base, upload });
  const existed = credentials.some((entry) => entry.email === credential.email);
  report({ symbol: symbols.success, text: `${changed ? existed ? '已更新' : '已保存' : '已是最新，无需更新'} ${styleText('bold', maskEmail(credential.email))}`, detail: fitPath(tildify({ store, path }), (process.stdout.columns || 80) - 2) });
  return credential;
}

async function trySave({ store, credentials, path, base }: { store: Session; credentials: Credential[]; path: string; base?: AuthDigest | null | undefined }): Promise<Credential | null> {
  try {
    return await saveFrom({ store, credentials, path, base });
  } catch (error) {
    if (isCancel(error)) {
      throw error;
    }
    if (error instanceof UploadCancelled) {
      report({ symbol: symbols.info, text: error.message });
      return null;
    }
    const message = describeError({ store, error });
    const shown = tildify({ store, path });
    report({ symbol: symbols.failure, text: styleText('red', `保存失败：${message}`), detail: isRecord(error) && typeof error.path === 'string' || message.includes(shown) ? undefined : fitPath(shown, (process.stdout.columns || 80) - 2) });
    return null;
  }
}

async function askPath({ store, previous }: { store: Session; previous: string }) {
  return escapable((context) => pathInput({ initial: previous, validate: (value) => validatePath({ store, value }) }, context));
}

async function afterAdded({ store, added }: { store: Session; added: Credential }): Promise<boolean> {
  const current = await store.current();
  if (current.status === 'saved' && current.email === added.email) return false;
  const use = await escapable((context) => select({ config: {
    message: stepTitle('添加账号', '账号已保存', maskEmail(added.email)),
    choices: [
      { value: false, name: '完成', description: '回到主菜单' },
      { value: true, name: '立即切换', description: `切换到 ${maskEmail(added.email)}` },
    ],
    default: false, theme: selectTheme('完成'),
  }, context }));
  return use === true && await switchTo({ store, credentials: await store.list(), target: added }) === 'done';
}

async function browserAddFlow(store: Session): Promise<boolean> {
  const result = await browserLoginPrompt({ store }, { clearPromptOnDone: true });
  if (result === null) {
    report({ symbol: symbols.info, text: '已取消浏览器登录。' });
    return false;
  }
  if (result.kind === 'error') throw result.error;
  try {
    let added: Credential;
    for (;;) {
      try {
        const { credential, changed } = await store.saveBrowserLogin({ id: result.id, upload: (task) => withSpinner({ text: '正在向 ChatGPT 查询账号邮箱并保存…', task }) });
        report({ symbol: symbols.success, text: `${changed ? '已保存' : '已是最新，无需更新'} ${styleText('bold', maskEmail(credential.email))}` });
        added = credential;
        break;
      } catch (error) {
        if (isCancel(error)) throw error;
        if (error instanceof UploadCancelled) { report({ symbol: symbols.info, text: error.message }); return false; }
        report({ symbol: symbols.failure, text: styleText('red', `保存失败：${describeError({ store, error })}`) });
        const retry = await escapable((context) => select({ config: {
          message: stepTitle('添加账号 / 浏览器登录', '登录已完成，要重新保存吗？'),
          choices: [{ value: true, name: '重试保存', description: '使用本次登录凭证，无需重新登录' }, { value: false, name: '返回', description: '丢弃本次登录凭证' }],
          default: true,
          theme: selectTheme('返回'),
        }, context }));
        if (retry !== true) return false;
      }
    }
    return await afterAdded({ store, added });
  } finally { await store.cancelBrowserLogin(result.id); }
}

async function addFlow({ store, credentials, current }: { store: Session; credentials: Credential[]; current: CurrentLogin }): Promise<boolean> {
  let source: AddSource = current.status === 'none' || current.status === 'invalid' || current.status === 'saved' ? 'browser' : 'codex';
  let previous = '';
  for (;;) {
    const choice = await escapable((context) =>
      select(
        { config: { message: stepTitle('添加账号', '选择添加方式', '使用 ChatGPT 登录凭证，不支持 API key。'), choices: addChoices({ current, authPath: tildify({ store, path: store.codexAuthPath }) }), default: source, theme: selectTheme('返回') },
        context },
      ),
    );
    if (choice === BACK || choice === 'back') {
      return false;
    }
    source = choice;
    if (choice === 'browser') return await browserAddFlow(store);
    if (choice === 'codex') {
      const latest = await store.current();
      current = latest;
      if (latest.status === 'none' || latest.status === 'invalid') {
        report({ symbol: symbols.failure, text: styleText('red', latest.status === 'none' ? `未找到 ${tildify({ store, path: store.codexAuthPath })}，请先在 Codex 中登录。` : `${latest.reason} 请先在 Codex 中重新登录。`) });
        source = 'file';
        continue;
      }
      if (latest.status === 'behind') {
        report({ symbol: symbols.info, text: `服务端保存的 ${styleText('bold', maskEmail(latest.email))} 版本更新，无需保存`, detail: '可在主菜单选择「更新本机登录」' });
        return false;
      }
      if (latest.status === 'saved') {
        report({ symbol: symbols.info, text: `${styleText('bold', maskEmail(latest.email))} 已是最新，无需更新`, detail: `${fitPath(tildify({ store, path: store.codexAuthPath }), (process.stdout.columns || 80) - 2)} 与已保存的凭证一致` });
        return false;
      }
      if (latest.status === 'diverged') {
        const decision = await resolveDivergence({ store, email: latest.email, switching: false });
        if (decision === 'back') {
          continue;
        }
        if (decision === 'local' && !await trySave({ store, credentials, path: store.codexAuthPath, base: store.snapshotDigest(latest.email) })) {
          continue;
        }
        return false;
      }
      if (await trySave({ store, credentials, path: store.codexAuthPath })) {
        return false;
      }
      continue;
    }
    for (;;) {
      const path = await askPath({ store, previous });
      if (path === BACK) {
        break;
      }
      previous = path;
      const added = await trySave({ store, credentials, path });
      if (added) return await afterAdded({ store, added });
    }
  }
}

async function confirmOverwrite({ current, target }: { current: Extract<CurrentLogin, { status: 'ahead' | 'diverged' | 'unsaved' | 'deleted' }>; target: Credential }) {
  const warning =
    current.status === 'ahead'
      ? `当前登录 ${maskEmail(current.email)} 有更新尚未保存，切换后会被覆盖。`
      : `${current.email === null ? '当前 Codex 登录' : `当前登录 ${maskEmail(current.email)} `}尚未保存，切换后会被覆盖。`;
  const save = current.status === 'ahead' ? '先更新保存，再切换' : '先保存当前登录，再切换';
  return escapable((context) =>
    select(
      { config: {
        message: stepTitle('切换账号 / 保存当前登录', `即将切换到 ${maskEmail(target.email)}`, `  ${styleText('yellow', warning)}`),
        choices: [
          { value: 'save' as const, name: save, description: '保存后再切换，之后可以随时切回来' },
          { value: 'overwrite' as const, name: '不保存，直接切换', tone: 'danger', description: '当前登录的最新凭证将被覆盖，无法恢复' },
          { value: 'back' as const, name: '返回', description: '重新选择账号' },
        ],
        theme: selectTheme('返回'),
      },
      context },
    ),
  );
}

async function downloadCurrent({ store, email }: { store: Session; email: Email }): Promise<boolean> {
  if (!(await confirmRunningCodex({ action: 'update', findProcesses: () => store.processes(), authPath: tildify({ store, path: store.codexAuthPath }), ask: askRunningCodex, log: logRunningCodex }))) {
    writeOutput('');
    return false;
  }
  await store.switch({ type: 'codex', email });
  writeOutput(line(symbols.success, `已用服务端版本更新本机登录 ${styleText('bold', maskEmail(email))}`));
  report({ symbol: ' ', text: styleText('dim', '请重新启动正在运行的 Codex 会话以使用更新后的凭证。') });
  return true;
}

async function resolveDivergence({ store, email, switching }: { store: Session; email: Email; switching: boolean }): Promise<'local' | 'server' | 'back'> {
  const times = await store.refreshTimes(email);
  const decision = await escapable((context) => select({ config: {
    message: stepTitle(`${switching ? '切换账号' : '添加账号'} / 解决版本冲突`, `${maskEmail(email)} 的两份凭证版本不一致`, `  ${refreshDetails(times.local, times.server)}`),
    choices: [
      { value: 'local' as const, name: switching ? '先用本机登录覆盖服务端，再切换' : '用本机登录覆盖服务端', tone: 'danger', description: '服务端保存的版本将被替换，无法恢复' },
      switching
        ? { value: 'server' as const, name: '不保存，直接切换', tone: 'danger', description: '本机登录将被覆盖，服务端保存的版本不变' }
        : { value: 'server' as const, name: '用服务端版本覆盖本机', tone: 'danger', description: `下载服务端保存的版本并写入 ${tildify({ store, path: store.codexAuthPath })}` },
      { value: 'back' as const, name: '返回', description: switching ? '重新选择账号' : '不做更改' },
    ],
    default: 'back',
    theme: selectTheme('返回'),
  }, context }));
  if (decision === BACK || decision === 'back') {
    return 'back';
  }
  if (decision === 'server' && !switching) {
    return await downloadCurrent({ store, email }) ? 'server' : 'back';
  }
  return decision;
}

async function backupBeforeSwitch({ store, credentials, target }: { store: Session; credentials: Credential[]; target: Credential }) {
  const current = await store.current();
  if (!needsBackup(current)) {
    return 'switch' as const;
  }
  if (current.status === 'diverged') {
    const decision = await resolveDivergence({ store, email: current.email, switching: true });
    if (decision === 'back') {
      return 'back' as const;
    }
    if (decision === 'server') {
      return 'switch' as const;
    }
    const saved = await trySave({ store, credentials, path: store.codexAuthPath, base: store.snapshotDigest(current.email) });
    if (saved?.email === target.email) {
      report({ symbol: symbols.info, text: `${maskEmail(saved.email)} 就是当前登录的账号，无需切换。` });
      return 'done' as const;
    }
    return saved ? 'switch' as const : 'back' as const;
  }
  for (;;) {
    const decision = await confirmOverwrite({ current, target });
    if (decision === BACK || decision === 'back') {
      return 'back' as const;
    }
    if (decision === 'overwrite') {
      return 'switch' as const;
    }
    const saved = await trySave({ store, credentials, path: store.codexAuthPath });
    if (saved?.email === target.email) {
      report({ symbol: symbols.info, text: `${maskEmail(saved.email)} 就是当前登录的账号，无需切换。` });
      return 'done' as const;
    }
    if (saved) {
      return 'switch' as const;
    }
  }
}

async function switchFlow({ store, credentials, current }: { store: Session; credentials: Credential[]; current: CurrentLogin }): Promise<boolean> {
  const menu = switchChoices({ credentials, current, digest: (email) => store.snapshotDigest(email) });
  if (menu.default === null) {
    report({ symbol: symbols.info, text: '没有其他可切换的账号，请先添加有效凭证。' });
    return false;
  }
  let selected = menu.default;
  for (;;) {
    const target = await escapable((context) =>
      select(
        { config: { message: stepTitle('切换账号', '选择要使用的账号'), choices: menu.choices, default: selected, theme: selectTheme('返回'), searchable: true },
        context },
      ),
    );
    if (target === BACK || target === null) {
      return false;
    }
    selected = target;

    const outcome = await switchTo({ store, credentials, target });
    if (outcome !== 'back') return outcome === 'done';
  }
}

async function switchTo({ store, credentials, target }: { store: Session; credentials: Credential[]; target: Credential }): Promise<'back' | 'cancel' | 'done'> {
  const next = await backupBeforeSwitch({ store, credentials, target });
  if (next === 'back') return 'back';
  if (next === 'switch') {
    const decision = await confirmRunningCodex({ findProcesses: () => store.processes(), authPath: tildify({ store, path: store.codexAuthPath }), ask: askRunningCodex, log: logRunningCodex });
    if (!decision) {
      writeOutput('');
      return 'cancel';
    }
    await store.switch(target);
    writeOutput(line(symbols.success, `已切换到 ${styleText('bold', maskEmail(target.email))}`));
    if (decision === 'restart') {
      try {
        await withSpinner({ text: '正在重启 Codex server…', task: () => store.restartCodexServer() });
        report({ symbol: symbols.success, text: '已重启 Codex server。' });
      } catch (error) {
        report({ symbol: symbols.warning, text: styleText('yellow', `账号已切换，但 Codex server 重启失败：${describeError({ store, error })}`), detail: '请手动重启 Codex。' });
      }
    } else {
      report({ symbol: ' ', text: styleText('dim', '请重新启动正在运行的 Codex 会话以使用新账号。') });
    }
  }
  return 'done';
}

async function restartFlow({ store }: { store: Session }): Promise<void> {
  const confirmed = await escapable((context) => select({ config: {
    message: stepTitle('重启 codex server', '重启 Codex 托管后台服务？', '可能中断正在运行的任务。独立启动的会话仍需手动重启。'),
    choices: [
      { value: false, name: '取消', description: '回到主菜单' },
      { value: true, name: '重启', tone: 'danger', description: '重启当前登录目录的 Codex server' },
    ],
    default: false,
    theme: selectTheme('取消'),
  }, context }));
  if (confirmed !== true) return;
  await withSpinner({ text: '正在重启 Codex server…', task: () => store.restartCodexServer() });
  report({ symbol: symbols.success, text: '已重启 Codex server。' });
}

async function deleteFlow({ store, credentials, current }: { store: Session; credentials: Credential[]; current: CurrentLogin }): Promise<void> {
  const selected = await escapable((context) => select({ config: {
    message: stepTitle('删除账号', '选择要从账号库删除的账号', '下一步再次确认。本机登录会保留。'),
    choices: deleteChoices({ credentials, digest: (email) => store.snapshotDigest(email) }),
    default: null,
    theme: selectTheme('返回'),
    searchable: true,
  }, context }));
  if (selected === BACK || selected === null) {
    return;
  }
  const active = 'email' in current && current.email === selected.email;
  const confirmed = await escapable((context) => select({ config: {
    message: stepTitle('删除账号 / 确认删除', `从账号库删除 ${maskEmail(selected.email)}？`, `  删除后无法恢复。${active ? `本机 ${tildify({ store, path: store.codexAuthPath })} 不受影响。` : ''}`),
    choices: [
      { value: false, name: '取消', description: '保留该账号' },
      { value: true, name: '删除', tone: 'danger', description: '从账号库移除该账号保存的凭证' },
    ],
    default: false,
    theme: selectTheme('取消'),
  }, context }));
  if (confirmed !== true) {
    return;
  }
  try {
    await store.delete(selected);
    report({ symbol: symbols.success, text: `已删除 ${styleText('bold', maskEmail(selected.email))}`, detail: active ? '已从账号库删除，本机登录保留' : undefined });
  } catch (error) {
    if (!(error instanceof ServiceError) || error.status !== 409) {
      throw error;
    }
    report({ symbol: symbols.warning, text: styleText('yellow', `${maskEmail(selected.email)} 在账号库中已被更新，未删除。`), detail: '列表已刷新，请重新决定' });
  }
}

export async function menu({ store, version = '' }: { store: Session; version?: string | undefined }): Promise<void> {
  const authPath = tildify({ store, path: store.codexAuthPath });
  let previous: MainAction | undefined;
  for (;;) {
    const credentials = await store.list();
    const current = await store.current();
    const menu = mainChoices({ credentials, current, authPath });
    const action = await escapable((context) =>
      select(
        { config: {
          message: (columns) => renderHome(current, credentials.length, version, columns),
          compactMessage: homeSummary(current, credentials.length),
          choices: menu.choices,
          default: menu.choices.some((item) => 'value' in item && item.value === previous && !item.disabled) ? previous : menu.default,
          theme: selectTheme('退出'),
        },
        context },
      ),
    );
    if (action === BACK || action === 'exit') {
      writeOutput(`${styleText('dim', '当前账号')}  ${describeCurrent(current, authPath)}\n`);
      return;
    }
    previous = action;
    try {
      if (action === 'details') {
        const home = maskHomePath({ path: store.home, userHome: store.userHome });
        const connection = `自带服务端 ${store.url}`;
        await escapable((context) => select({ config: { message: renderLocations(home, authPath, connection),
          compactMessage: (columns) => locationSummary(home, authPath, connection, columns),
          choices: [{ value: 'back', name: '返回' }], theme: selectTheme('返回') }, context }));
      } else if (action === 'delete') {
        await deleteFlow({ store, credentials, current });
      } else if (action === 'info') {
        await accountInfoFlow({ store });
      } else if (action === 'reset') {
        await resetCardFlow({ store, credentials, current });
      } else if (action === 'restart') {
        await restartFlow({ store });
      } else if (action === 'antigravity') {
        await antigravityFlow(store);
      } else if (action === 'update') {
        if (current.status === 'behind') {
          await downloadCurrent({ store, email: current.email });
        }
      } else if (action === 'switch') {
        if (await switchFlow({ store, credentials, current })) {
          return;
        }
      } else {
        if (await addFlow({ store, credentials, current })) return;
      }
    } catch (error) {
      if (isCancel(error)) {
        throw error;
      }
      report({ symbol: symbols.failure, text: styleText('red', describeError({ store, error })) });
    }
  }
}
