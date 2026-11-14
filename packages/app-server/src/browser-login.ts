import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord, parseAuth } from '@weiguangchao/codexplus-shared';

interface LoginOptions {
  signal?: AbortSignal;
  onUrl?: (url: string) => void;
  onBrowserError?: () => void;
  open?: (url: string) => Promise<void>;
  launch?: (env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
}

export async function codexCommand(env: NodeJS.ProcessEnv, platform = process.platform): Promise<string[]> {
  if (platform !== 'win32') return ['codex'];
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const require = createRequire(import.meta.url);
  for (const directory of path.split(';').filter(Boolean)) {
    const file = join(directory, 'codex.exe');
    if (await access(file).then(() => true, () => false)) return [file];
    try {
      await access(join(directory, 'codex.cmd'));
      const manifest = require.resolve('@openai/codex/package.json', { paths: [directory] });
      const script = join(dirname(manifest), 'bin', 'codex.js');
      await access(script);
      return [process.execPath, script];
    } catch { continue; }
  }
  throw new Error('找不到 Codex CLI，请先安装官方 Codex CLI 并确保 codex 在 PATH 中。');
}

export function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

export async function browserLogin(options: LoginOptions = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codexplus-login-'));
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const timer = setTimeout(() => controller.abort(new Error('浏览器登录超时，请重新登录。')), options.timeoutMs ?? 5 * 60_000);
  let stop: (() => Promise<void>) | undefined;
  let cancel: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const env = { ...process.env, CODEX_HOME: directory };
    const command = options.launch ? [] : await codexCommand(env);
    signal.throwIfAborted();
    const processChild = options.launch ? options.launch(env) : spawn(command[0]!, [...command.slice(1), 'app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], { env, cwd: directory, windowsHide: true });
    const exited = new Promise<void>((resolve) => processChild.once('close', () => resolve()));
    stop = async () => {
      processChild.stdin.end();
      const terminate = setTimeout(() => processChild.kill(), 250);
      const force = setTimeout(() => processChild.kill('SIGKILL'), 1250);
      try { await exited; } finally { clearTimeout(terminate); clearTimeout(force); }
    };
    let nextId = 0;
    let loginId = '';
    let failed: Error | undefined;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const completions = new Map<string, Record<string, unknown>>();
    let finish: (value: Record<string, unknown>) => void;
    let failLogin: (error: Error) => void;
    const completed = new Promise<Record<string, unknown>>((resolve, reject) => { finish = resolve; failLogin = reject; });
    void completed.catch(() => {});
    const fail = (error: Error) => {
      failed ??= error;
      for (const request of pending.values()) request.reject(failed);
      pending.clear();
      failLogin(failed);
    };
    const lines = createInterface({ input: processChild.stdout });
    lines.on('line', (line) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { fail(new Error('Codex 登录接口返回了无效数据，请升级 Codex CLI 后重试。')); return; }
      if (!isRecord(message)) return;
      if (typeof message.id === 'number') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error('Codex 无法启动浏览器登录，请升级 CLI 并检查回调端口是否被其他登录流程占用。'));
        else request.resolve(message.result);
      } else if (message.method === 'account/login/completed' && isRecord(message.params) && typeof message.params.loginId === 'string') {
        if (message.params.loginId === loginId) finish(message.params);
        else if (!loginId) completions.set(message.params.loginId, message.params);
      }
    });
    processChild.stderr.resume();
    processChild.once('error', (error) => fail(new Error('code' in error && error.code === 'ENOENT' ? '找不到 Codex CLI，请先安装官方 Codex CLI 并确保 codex 在 PATH 中。' : '无法启动 Codex CLI，请检查安装后重试。')));
    processChild.once('close', () => { lines.close(); fail(new Error('Codex 登录进程已退出，请重新登录。')); });
    processChild.stdin.on('error', () => fail(new Error('无法连接 Codex 登录进程，请重新登录。')));
    const request = (method: string, params: unknown): Promise<unknown> => {
      if (failed) return Promise.reject(failed);
      signal.throwIfAborted();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        processChild.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    };
    const abort = () => {
      if (loginId && !processChild.stdin.destroyed) processChild.stdin.write(`${JSON.stringify({ id: nextId++, method: 'account/login/cancel', params: { loginId } })}\n`);
      fail(signal.reason instanceof Error ? signal.reason : new Error('已取消浏览器登录。'));
    };
    signal.addEventListener('abort', abort, { once: true });
    cancel = () => signal.removeEventListener('abort', abort);
    signal.throwIfAborted();
    await request('initialize', { clientInfo: { name: 'codexplus', title: 'codexplus', version: '0.1.0' } });
    processChild.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const result = await request('account/login/start', { type: 'chatgpt' });
    if (!isRecord(result) || result.type !== 'chatgpt' || typeof result.loginId !== 'string' || typeof result.authUrl !== 'string') throw new Error('Codex 浏览器登录响应无效，请升级 Codex CLI 后重试。');
    loginId = result.loginId;
    const url = new URL(result.authUrl);
    if (url.protocol !== 'https:') throw new Error('Codex 返回的登录链接无效。');
    if (completions.has(loginId)) finish!(completions.get(loginId)!);
    options.onUrl?.(url.href);
    signal.throwIfAborted();
    void (options.open ?? openBrowser)(url.href).catch(() => { if (!signal.aborted) options.onBrowserError?.(); });
    const outcome = await completed;
    signal.throwIfAborted();
    if (outcome.success !== true) throw new Error('Codex 浏览器登录失败，请返回浏览器检查授权结果后重试。');
    const content = await readFile(join(directory, 'auth.json'), 'utf8').catch(() => { throw new Error('Codex 未生成可导入的文件凭证，请检查 CLI 的凭证存储策略。'); });
    const auth = parseAuth(content);
    signal.throwIfAborted();
    return JSON.stringify(auth);
  } finally {
    clearTimeout(timer);
    cancel?.();
    try { await stop?.(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
