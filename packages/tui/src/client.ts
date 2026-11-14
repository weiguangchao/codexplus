import { isRecord, parseCredential, requestService, parsePort, protocolVersion, ServiceError } from '@weiguangchao/codexplus-shared';
import type { Credential, CurrentLogin, UploadResult } from '@weiguangchao/codexplus-shared';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startServer } from '@weiguangchao/codexplus-server';

export interface ConnectOptions {
  port?: number;
  log?: (message: string) => void;
}

type StartLocal = (options: { home: string; userHome: string; codexHome?: string; port: number; sessionToken: string }) => Promise<{ url: string; close(): Promise<void> }>;

export class UploadCancelled extends Error {
  constructor(message = '已取消，服务端保存的版本未更改。') { super(message); }
}

export class Session {
  confirmUpload?: (details: Record<string, unknown>) => Promise<boolean>;
  confirmRestore?: (email: string | null) => Promise<boolean>;
  private digests = new Map<string, string | null>();

  constructor(
    readonly url: string,
    readonly userHome: string,
    readonly codexAuthPath: string,
    private readonly stop: () => Promise<void>,
    readonly home = userHome,
    readonly server = url,
    private readonly log: (message: string) => void = console.log,
    private readonly sessionToken?: string,
  ) {}

  private async request(path: string, body?: unknown): Promise<unknown> {
    return await requestService(this.url, path, body, this.sessionToken);
  }

  async list(): Promise<Credential[]> {
    const result = await this.request('/v1/credentials');
    if (!isRecord(result) || !Array.isArray(result.credentials)) throw new Error('服务端凭证列表格式无效。');
    const digests = new Map<string, string | null>();
    const credentials = result.credentials.map((entry: unknown) => {
      const credential = parseCredential(entry);
      if (isRecord(entry) && (typeof entry.digest === 'string' || entry.digest === null)) digests.set(credential.email, entry.digest);
      return credential;
    });
    this.digests = digests;
    return credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async current(): Promise<CurrentLogin> {
    const result = await this.request('/v1/login');
    if (!isRecord(result) || !isRecord(result.current)) throw new Error('服务端登录状态格式无效。');
    const current = result.current;
    if (current.status === 'none') return { status: 'none' };
    if (current.status === 'invalid' && typeof current.reason === 'string') return { status: 'invalid', reason: current.reason };
    if (current.status === 'unsaved' && current.email === null) return { status: 'unsaved', email: null };
    if (['saved', 'ahead', 'behind', 'diverged', 'deleted', 'unsaved'].includes(String(current.status)) && typeof current.email === 'string') {
      return { status: current.status, email: current.email } as CurrentLogin;
    }
    throw new Error('服务端登录状态格式无效。');
  }

  snapshotDigest(email: string): string | null { return this.digests.get(email) ?? null; }

  async refreshTimes(email: string): Promise<{ local: unknown; server: unknown }> {
    const result = await this.request('/v1/login/refresh-times', { type: 'codex', email });
    if (!isRecord(result)) throw new Error('服务端刷新时间格式无效。');
    return { local: result.local, server: result.server };
  }

  async processes(): Promise<{ pid: number; command: string }[]> {
    const result = await this.request('/v1/login/processes');
    if (!isRecord(result) || !Array.isArray(result.processes) || !result.processes.every((entry: unknown) =>
      isRecord(entry) && Number.isSafeInteger(entry.pid) && Number(entry.pid) > 0 && typeof entry.command === 'string')) {
      throw new Error('服务端 Codex 进程列表格式无效。');
    }
    return result.processes;
  }

  async validateSource(path: string): Promise<void> { await this.request('/v1/credentials/validate', { path }); }

  async add(path: string, base?: string | null, upload: (task: () => Promise<unknown>) => Promise<unknown> = (task) => task()): Promise<UploadResult> {
    return await this.save('/v1/credentials/import', { path, ...(base === undefined ? {} : { base }) }, upload);
  }

  async saveCurrent(base?: string | null, upload: (task: () => Promise<unknown>) => Promise<unknown> = (task) => task()): Promise<UploadResult> {
    return await this.save('/v1/login/save', base === undefined ? {} : { base }, upload);
  }

  async saveBrowserLogin(id: string, upload: (task: () => Promise<unknown>) => Promise<unknown> = (task) => task()): Promise<UploadResult> {
    return await this.save('/v1/login/browser/save', { id }, upload);
  }

  private async save(path: string, body: Record<string, unknown>, upload: (task: () => Promise<unknown>) => Promise<unknown>): Promise<UploadResult> {
    for (;;) {
      try {
        const result = await upload(() => this.request(path, body));
        if (!isRecord(result) || typeof result.changed !== 'boolean') throw new Error('服务端保存响应格式无效。');
        return { credential: parseCredential(result.credential), changed: result.changed };
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 409) throw error;
        if (error.details.code === 'restore_required') {
          if (!await this.confirmRestore?.(typeof error.details.email === 'string' ? error.details.email : null)) {
            throw new UploadCancelled('已取消，账号未重新保存。');
          }
          body.restore = true;
        } else if (error.details.code === 'conflict' && this.confirmUpload) {
          if (!await this.confirmUpload(error.details)) throw new UploadCancelled();
          body.base = error.details.digest;
        } else throw error;
      }
    }
  }

  async browserLogin({ signal, onUrl, onBrowserError }: { signal: AbortSignal; onUrl: (url: string) => void; onBrowserError: () => void }): Promise<string> {
    signal.throwIfAborted();
    const result = await this.request('/v1/login/browser/start', {});
    if (!isRecord(result) || typeof result.id !== 'string') throw new Error('服务端浏览器登录响应无效。');
    const id = result.id;
    try {
      for (;;) {
        signal.throwIfAborted();
        const status = await this.request('/v1/login/browser/status', { id });
        if (!isRecord(status)) throw new Error('服务端浏览器登录状态无效。');
        if (typeof status.url === 'string' && status.url) onUrl(status.url);
        if (status.manual === true) onBrowserError();
        if (status.status === 'complete') { signal.throwIfAborted(); return id; }
        if (status.status === 'error') throw new Error(typeof status.error === 'string' ? status.error : '浏览器登录失败。');
        if (status.status !== 'pending') throw new Error('服务端浏览器登录状态无效。');
        await setTimeout(200, undefined, { signal });
      }
    } catch (error) {
      await this.cancelBrowserLogin(id);
      throw error;
    }
  }

  async cancelBrowserLogin(id: string): Promise<void> { await this.request('/v1/login/browser/cancel', { id }); }

  async delete(credential: Credential): Promise<void> {
    const base = this.digests.get(credential.email);
    if (base === undefined) throw new Error('账号列表已变化，请刷新后重新选择。');
    await this.request('/v1/credentials/delete', { ...credential, base });
    this.digests.delete(credential.email);
  }

  async switch(credential: Credential): Promise<void> {
    const result = await this.request('/v1/login/switch', parseCredential(credential));
    if (!isRecord(result) || result.ok !== true) throw new Error('服务端切换响应格式无效。');
    if (typeof result.warning === 'string') this.log(result.warning);
  }

  async close(): Promise<void> { await this.stop(); }
}

export class CredentialClient {
  readonly home: string;
  private readonly userHome: string;
  private readonly codexHome: string | undefined;
  private readonly startLocal: StartLocal;

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus'), codexHome, startLocal = startServer }:
    { home?: string; userHome?: string; codexHome?: string; startLocal?: StartLocal } = {}) {
    this.home = home;
    this.userHome = userHome;
    this.codexHome = codexHome;
    this.startLocal = startLocal;
  }

  async connect({ port, log = console.log }: ConnectOptions = {}): Promise<Session> {
    if (port !== undefined) parsePort(String(port));
    const sessionToken = port === undefined ? randomBytes(32).toString('base64url') : undefined;
    const embedded = sessionToken === undefined ? null : await this.startLocal({ home: this.home, userHome: this.userHome,
      ...(this.codexHome === undefined ? {} : { codexHome: this.codexHome }), port: 0, sessionToken });
    const url = embedded?.url ?? `http://127.0.0.1:${port}`;
    try {
      const health = await requestService(url, '/v1/health');
      if (!isRecord(health) || health.service !== 'codexplus') throw new Error(`${url} 上运行的不是 codexplus 服务端。`);
      if (health.version !== protocolVersion) throw new Error('版本不兼容，请把两端升级到同一版本。');
      const info = await requestService(url, '/v1/login/info', undefined, sessionToken);
      if (!isRecord(info) || typeof info.home !== 'string' || typeof info.userHome !== 'string' || typeof info.authPath !== 'string') {
        throw new Error('服务端登录文件信息无效。');
      }
      return new Session(url, info.userHome, info.authPath, async () => { await embedded?.close(); }, info.home, embedded ? 'local' : url, log, sessionToken);
    } catch (error) {
      await embedded?.close();
      throw error;
    }
  }
}
