import {
  withLock,
  authDigest,
  isRecord,
  parseAuth,
  expandPath,
  readOptional,
  writeAtomic,
  parseCredential,
  requestService,
  parsePort,
  protocolVersion,
  ServiceError,
} from '@codexplus/shared';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { idTokenEmail, newerRefresh } from './login.js';
import { syncCodexBar } from './codexbar.js';
import type { Credential, CurrentLogin, UploadResult } from '@codexplus/shared';
import { startServer } from '@codexplus/app-server';

export interface ClientConfig {
  version: 3;
  baseline: { server: string; email: string; digest: string } | null;
}

export interface ConnectOptions {
  port?: number;
  log?: (message: string) => void;
}

type StartLocal = (options: { home: string; port: number; sessionToken: string }) => Promise<{ url: string; close(): Promise<void> }>;

export class UploadCancelled extends Error {
  constructor(message = '已取消，服务端保存的版本未更改。') {
    super(message);
  }
}

export class Session {
  private refreshes = new Map<string, unknown>();
  confirmUpload?: (details: Record<string, unknown>) => Promise<boolean>;
  confirmRestore?: (email: string | null) => Promise<boolean>;
  private digests = new Map<string, string | null>();
  private deleted = new Map<string, string | null>();

  constructor(
    readonly url: string,
    readonly userHome: string,
    readonly codexAuthPath: string,
    private readonly stop: () => Promise<void>,
    private readonly owner?: CredentialClient,
    readonly server = url,
    private readonly log: (message: string) => void = console.log,
    private readonly sessionToken?: string,
  ) {}

  get home(): string { return this.owner?.home ?? this.userHome; }

  private async request(path: string, body?: unknown): Promise<unknown> {
    return await requestService(this.url, path, body, this.sessionToken);
  }

  async list(): Promise<Credential[]> {
    const result = await this.request('/v1/credentials');
    if (!isRecord(result) || !Array.isArray(result.credentials)) {
      throw new Error('服务端凭证列表格式无效。');
    }
    const digests = new Map<string, string | null>();
    const credentials = result.credentials.map((entry: unknown) => {
      const credential = parseCredential(entry);
      if (isRecord(entry) && (typeof entry.digest === 'string' || entry.digest === null)) {
        this.refreshes.set(credential.email, entry.lastRefresh);
        digests.set(credential.email, entry.digest);
      }
      return credential;
    });
    this.digests = digests;
    return credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async current(): Promise<CurrentLogin> {
    let content: string | null;
    try { content = await readOptional(this.codexAuthPath); } catch {
      return { status: 'invalid', reason: '无法读取登录文件，请检查路径和文件权限。' };
    }
    if (content === null) {
      return { status: 'none' };
    }
    let auth;
    try {
      auth = parseAuth(content);
    } catch (error) {
      return { status: 'invalid', reason: error instanceof Error ? error.message : '登录文件格式无效。' };
    }
    const saved = await this.list();
    const login = authDigest(content);
    const match = saved.find((credential) => this.digests.get(credential.email) === login);
    if (match) {
      return { status: 'saved', email: match.email };
    }
    const email = idTokenEmail(content);
    const deleted = this.deletedEmail(content);
    if (deleted !== null) return { status: 'deleted', email: deleted };
    const baseline = (await this.owner?.config())?.baseline;
    const base = baseline?.server === this.server && baseline.email === email ? baseline.digest : null;
    if (email === null || !saved.some((credential) => credential.email === email && this.digests.get(email) != null)) {
      return { status: 'unsaved', email };
    }
    if (base === null) {
      return { status: 'diverged', email };
    }
    const newer = newerRefresh(auth.last_refresh, this.refreshes.get(email));
    return { status: this.digests.get(email) === base && newer === 'local' ? 'ahead' : login === base && newer === 'server' ? 'behind' : 'diverged', email };
  }

  snapshotDigest(email: string): string | null { return this.digests.get(email) ?? null; }

  async refreshTimes(email: string): Promise<{ local: unknown; server: unknown }> {
    let local: unknown;
    try { local = parseAuth(await readFile(this.codexAuthPath, 'utf8')).last_refresh; } catch { local = null; }
    return { local, server: this.refreshes.get(email) };
  }

  private deletedEmail(content: string): string | null {
    const email = idTokenEmail(content);
    if (email !== null && this.deleted.has(email)) return email;
    try { return [...this.deleted].find(([, digest]) => digest === authDigest(content))?.[0] ?? null; } catch { return null; }
  }

  async add(sourcePath: string, confirmedBase?: string | null, upload: (task: () => Promise<unknown>) => Promise<unknown> = (task) => task()): Promise<UploadResult> {
    if (!sourcePath.trim()) {
      throw new Error('请输入 auth.json 文件路径。');
    }
    const content = await readFile(expandPath(this.userHome, sourcePath), 'utf8');
    return await this.uploadAuth(content, expandPath(this.userHome, sourcePath) === this.codexAuthPath, confirmedBase, upload);
  }

  async addAuth(content: string, upload: (task: () => Promise<unknown>) => Promise<unknown> = (task) => task()): Promise<UploadResult> {
    return await this.uploadAuth(content, false, undefined, upload);
  }

  private async uploadAuth(content: string, currentFile: boolean, confirmedBase: string | null | undefined, upload: (task: () => Promise<unknown>) => Promise<unknown>): Promise<UploadResult> {
    const auth = parseAuth(content);
    const restoring = this.deletedEmail(content);
    const unknownRestoration = this.deleted.size > 0 && idTokenEmail(content) === null;
    if ((restoring !== null || unknownRestoration) && !await this.confirmRestore?.(restoring)) {
      throw new UploadCancelled('已取消，账号未重新保存。');
    }
    const baseline = (await this.owner?.config())?.baseline;
    const email = idTokenEmail(content);
    let base = confirmedBase === undefined ? currentFile && baseline?.server === this.server && baseline.email === email ? baseline.digest : null : confirmedBase;
    if (confirmedBase === undefined && base !== null && email !== null) {
      await this.list();
      if (this.digests.get(email) === base && authDigest(content) !== base && newerRefresh(auth.last_refresh, this.refreshes.get(email)) !== 'local') base = null;
    }
    let result: unknown;
    for (;;) {
      try { result = await upload(() => this.request('/v1/credentials', { auth, base })); break; } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 409 || error.details.code !== 'conflict' || !this.confirmUpload) throw error;
        if (!await this.confirmUpload({ ...error.details, localRefresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : null })) {
          throw new UploadCancelled();
        }
        base = String(error.details.digest);
      }
    }
    if (!isRecord(result) || typeof result.changed !== 'boolean') {
      throw new Error('服务端凭证响应格式无效。');
    }
    const credential = parseCredential(result.credential);
    this.deleted.delete(credential.email);
    if (currentFile) await this.baseline(credential.email, content);
    return { credential, changed: result.changed };
  }

  private async baseline(email: string, content: string): Promise<void> {
    if (this.owner) await this.owner.setBaseline({ server: this.server, email, digest: authDigest(content) });
  }

  async delete(credential: Credential): Promise<void> {
    const base = this.digests.get(credential.email);
    if (base === undefined) throw new Error('账号列表已变化，请刷新后重新选择。');
    await this.request('/v1/credentials/delete', { ...credential, base });
    this.deleted.set(credential.email, base);
  }

  async switch(credential: Credential): Promise<void> {
    const selected = parseCredential(credential);
    const result = await this.request('/v1/credentials/download', selected);
    if (!isRecord(result)) {
      throw new Error('服务端凭证响应格式无效，当前登录未更改。');
    }
    const auth = parseAuth(JSON.stringify(result.auth));
    await writeAtomic(this.codexAuthPath, `${JSON.stringify(auth, null, 2)}\n`);
    await this.baseline(selected.email, JSON.stringify(auth));
    if (this.server === 'local') {
      try {
        const credentials = (await this.list()).filter(({ email }) => this.snapshotDigest(email) !== null);
        await syncCodexBar({ userHome: this.userHome, home: this.home, credentials, currentEmail: selected.email });
      } catch (error) {
        this.log(`账号已切换，但 CodexBar 同步失败：${error instanceof Error ? error.message : '请检查配置文件和权限。'}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.stop();
  }
}

export class CredentialClient {
  readonly configPath: string;
  readonly codexAuthPath: string;
  readonly home: string;
  private readonly userHome: string;
  private readonly startLocal: StartLocal;

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus'), codexHome = process.env.CODEX_HOME?.trim() || join(userHome, '.codex'), startLocal = startServer }:
    { home?: string; userHome?: string; codexHome?: string; startLocal?: StartLocal } = {}) {
    this.home = home;
    this.userHome = userHome;
    this.startLocal = startLocal;
    this.configPath = join(home, 'client.json');
    this.codexAuthPath = join(expandPath(userHome, codexHome), 'auth.json');
  }

  async config(): Promise<ClientConfig> {
    const content = await readOptional(this.configPath);
    if (content === null) return { version: 3, baseline: null };
    try {
      const value: unknown = JSON.parse(content);
      if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) throw new Error();
      if (value.version !== 3 && (typeof value.current !== 'string' || !isRecord(value.servers))) throw new Error();
      let baseline: ClientConfig['baseline'] = null;
      if (isRecord(value.baseline) && typeof value.baseline.server === 'string' && typeof value.baseline.email === 'string' && typeof value.baseline.digest === 'string') {
        const { server, email, digest } = value.baseline;
        if (server === 'local' || value.version === 3 && /^http:\/\/127\.0\.0\.1:\d+$/u.test(server) && parsePort(server.slice('http://127.0.0.1:'.length))) {
          baseline = { server, email, digest };
        }
      }
      return { version: 3, baseline };
    } catch {
      throw new Error(`${this.configPath} 格式无效，请修复或删除该文件；已有文件未被覆盖。`);
    }
  }

  async setBaseline(baseline: ClientConfig['baseline']): Promise<void> {
    await withLock(this.home, async () => {
      const config = await this.config();
      await writeAtomic(this.configPath, `${JSON.stringify({ ...config, baseline }, null, 2)}\n`);
    });
  }

  private async checkService(url: string): Promise<void> {
    let result: unknown;
    try { result = await requestService(url, '/v1/health'); } catch (error) {
      if (error instanceof ServiceError) throw new Error(`${url} 上运行的不是 codexplus 服务端。`, { cause: error });
      throw error;
    }
    if (!isRecord(result) || result.service !== 'codexplus') throw new Error(`${url} 上运行的不是 codexplus 服务端。`);
    if (result.version !== protocolVersion) throw new Error('版本不兼容，请把两端升级到同一版本。');
  }

  async connect({ port, log = console.log }: ConnectOptions = {}): Promise<Session> {
    await this.config();
    if (port !== undefined) parsePort(String(port));
    const sessionToken = port === undefined ? randomBytes(32).toString('base64url') : undefined;
    const embedded = sessionToken === undefined ? null : await this.startLocal({ home: this.home, port: 0, sessionToken });
    const url = embedded?.url ?? `http://127.0.0.1:${port}`;
    try {
      await this.checkService(url);
      await withLock(this.home, async () => {
        await writeAtomic(this.configPath, `${JSON.stringify(await this.config(), null, 2)}\n`);
      });
      return new Session(url, this.userHome, this.codexAuthPath, async () => { await embedded?.close(); }, this, embedded ? 'local' : url, log, sessionToken);
    } catch (error) {
      await embedded?.close();
      throw error;
    }
  }
}
