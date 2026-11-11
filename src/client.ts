import { withLock } from './lock.js';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { authDigest, idTokenEmail, isRecord, parseAuth } from './auth.js';
import { expandPath, readOptional, writeAtomic } from './files.js';
import { isLoopbackUrl, parseCredential, requestService, serverUrl, ServiceError } from './protocol.js';
import type { Credential, CurrentLogin } from './protocol.js';
import { startServer } from './server.js';

export interface ServerEntry {
  token: string;
  clientId: string;
  serverId?: string;
}

export interface ClientConfig {
  version: 2;
  current: string;
  servers: Record<string, ServerEntry>;
  baseline: { server: string; email: string; digest: string } | null;
}

export interface Pairing {
  code: string;
  name: string;
}

export interface ConnectOptions {
  target?: string;
  askRepair?: (message: string) => Promise<boolean>;
  askPairing?: (url: string) => Promise<Pairing>;
  log?: (message: string) => void;
}

type StartLocal = (options: { home: string; host: string; port: number; sessionToken: string }) => Promise<{ url: string; close(): Promise<void> }>;

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function parseEntry(value: unknown): ServerEntry {
  if (!isRecord(value) || typeof value.token !== 'string' || !tokenPattern.test(value.token) ||
    typeof value.clientId !== 'string' || !value.clientId) {
    throw new Error();
  }
  return { token: value.token, clientId: value.clientId, ...(typeof value.serverId === 'string' ? { serverId: value.serverId } : {}) };
}

function parsePairResult(result: unknown): ServerEntry {
  if (!isRecord(result) || typeof result.token !== 'string' || !tokenPattern.test(result.token) ||
    !isRecord(result.client) || typeof result.client.id !== 'string' || !result.client.id) {
    throw new Error('服务端配对响应格式无效，未保存客户端配置。');
  }
  return { token: result.token, clientId: result.client.id };
}

export class Session {
  private refreshes = new Map<string, unknown>();
  confirmUpload?: (details: Record<string, unknown>) => Promise<boolean>;
  private digests = new Map<string, string>();

  constructor(
    readonly url: string,
    private readonly token: string,
    readonly userHome: string,
    readonly codexAuthPath: string,
    private readonly stop: () => Promise<void>,
    private readonly owner?: CredentialClient,
    readonly server = url,
  ) {}

  get home(): string { return this.owner?.home ?? this.userHome; }

  private async request(path: string, body?: unknown): Promise<unknown> {
    return await requestService(this.url, path, this.token, body);
  }

  async list(): Promise<Credential[]> {
    const result = await this.request('/v1/credentials');
    if (!isRecord(result) || !Array.isArray(result.credentials)) {
      throw new Error('服务端凭证列表格式无效。');
    }
    const digests = new Map<string, string>();
    const credentials = result.credentials.map((entry: unknown) => {
      const credential = parseCredential(entry);
      if (isRecord(entry) && typeof entry.digest === 'string') {
        this.refreshes.set(credential.email, entry.lastRefresh);
        digests.set(credential.email, entry.digest);
      }
      return credential;
    });
    this.digests = digests;
    return credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async current(): Promise<CurrentLogin> {
    const content = await readOptional(this.codexAuthPath).catch(() => '');
    if (content === null) {
      return { status: 'none' };
    }
    const saved = await this.list();
    let login: string | null = null;
    try {
      login = authDigest(content);
    } catch {
      login = null;
    }
    const match = saved.find((credential) => login !== null && this.digests.get(credential.email) === login);
    if (match) {
      return { status: 'saved', email: match.email };
    }
    const email = idTokenEmail(content);
    const baseline = (await this.owner?.config())?.baseline;
    const base = baseline?.server === this.server && baseline.email === email ? baseline.digest : null;
    return email !== null && saved.some((credential) => credential.email === email && this.digests.has(email))
      ? { status: this.digests.get(email) === base ? 'ahead' : login === base ? 'behind' : 'diverged', email } : { status: 'unsaved', email };
  }

  snapshotDigest(email: string): string | null { return this.digests.get(email) ?? null; }

  async refreshTimes(email: string): Promise<string> {
    const auth = parseAuth(await readFile(this.codexAuthPath, 'utf8'));
    return `本机刷新时间：${typeof auth.last_refresh === 'string' ? auth.last_refresh : '未知'}，服务端刷新时间：${String(this.refreshes.get(email) ?? '未知')}`;
  }

  async add(sourcePath: string, confirmedBase?: string | null, upload: (task: () => Promise<unknown>) => Promise<unknown> = (task) => task()): Promise<Credential> {
    if (!sourcePath.trim()) {
      throw new Error('请输入 auth.json 文件路径。');
    }
    const content = await readFile(expandPath(this.userHome, sourcePath), 'utf8');
    const auth = parseAuth(content);
    const currentFile = expandPath(this.userHome, sourcePath) === this.codexAuthPath;
    const baseline = (await this.owner?.config())?.baseline;
    let base = confirmedBase === undefined ? currentFile && baseline?.server === this.server && baseline.email === idTokenEmail(content) ? baseline.digest : null : confirmedBase;
    let result: unknown;
    for (;;) {
      try { result = await upload(() => this.request('/v1/credentials', { auth, base })); break; } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 409 || error.details.code !== 'conflict' ||
          !await this.confirmUpload?.({ ...error.details, localRefresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : null })) throw error;
        base = String(error.details.digest);
      }
    }
    if (!isRecord(result)) {
      throw new Error('服务端凭证响应格式无效。');
    }
    const credential = parseCredential(result.credential);
    if (currentFile) await this.baseline(credential.email, content);
    return credential;
  }

  private async baseline(email: string, content: string): Promise<void> {
    if (this.owner) await this.owner.setBaseline({ server: this.server, email, digest: authDigest(content) });
  }

  async delete(credential: Credential): Promise<void> {
    const base = this.digests.get(credential.email);
    if (!base) throw new Error('账号列表已变化，请刷新后重新选择。');
    await this.request('/v1/credentials/delete', { ...credential, base });
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

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus'), startLocal = startServer }:
    { home?: string; userHome?: string; startLocal?: StartLocal } = {}) {
    this.home = home;
    this.userHome = userHome;
    this.startLocal = startLocal;
    this.configPath = join(home, 'client.json');
    this.codexAuthPath = join(userHome, '.codex', 'auth.json');
  }

  async config(): Promise<ClientConfig> {
    const content = await readOptional(this.configPath);
    if (content === null) return { version: 2, current: 'local', servers: {}, baseline: null };
    try {
      const value: unknown = JSON.parse(content);
      if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || typeof value.current !== 'string' || !isRecord(value.servers)) throw new Error();
      const servers: Record<string, ServerEntry> = {};
      const discarded = new Set<string>();
      for (const [url, entry] of Object.entries(value.servers)) {
        if (value.version === 1 && isRecord(entry) && entry.pairing === 'local') { discarded.add(url); continue; }
        servers[serverUrl(url)] = parseEntry(entry);
      }
      const current = value.current === 'local' || discarded.has(value.current) || value.version === 1 && !servers[value.current] && isLoopbackUrl(value.current) ? 'local' : serverUrl(value.current);
      let baseline: ClientConfig['baseline'] = isRecord(value.baseline) && typeof value.baseline.server === 'string' && typeof value.baseline.email === 'string' && typeof value.baseline.digest === 'string' ? value.baseline as unknown as ClientConfig['baseline'] : null;
      if (value.version === 1 && baseline && !servers[baseline.server]) baseline = null;
      return { version: 2, current, servers, baseline };
    } catch {
      throw new Error(`${this.configPath} 格式无效，请修复或删除该文件后重新配对；已有文件未被覆盖。`);
    }
  }

  async setBaseline(baseline: ClientConfig['baseline']): Promise<void> {
    await withLock(this.home, async () => {
      const config = await this.config();
      await writeAtomic(this.configPath, `${JSON.stringify({ ...config, baseline }, null, 2)}\n`);
    });
  }

  private async checkService(url: string): Promise<string> {
    let result: unknown;
    try { result = await requestService(url, '/v1/health'); } catch (error) {
      if (error instanceof ServiceError) throw new Error(`${url} 上运行的不是 codexplus 服务端。`, { cause: error });
      throw error;
    }
    if (!isRecord(result) || result.service !== 'codexplus') throw new Error(`${url} 上运行的不是 codexplus 服务端。`);
    if (result.version !== 2) throw new Error('版本不兼容，请把两端升级到同一版本。');
    if (typeof result.id !== 'string' || !result.id) throw new Error('服务端实例信息无效。');
    return result.id;
  }

  private async valid(url: string, token: string): Promise<boolean> {
    try {
      await requestService(url, '/v1/session', token);
      return true;
    } catch (error) {
      if (error instanceof ServiceError && error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  private async manualPair(url: string, askPairing: ConnectOptions['askPairing']): Promise<ServerEntry> {
    if (!askPairing) {
      throw new Error(`${url} 需要配对码，请在服务端运行 codexplus serve pair 生成。`);
    }
    const { code, name } = await askPairing(url);
    return parsePairResult(await requestService(url, '/v1/pair', undefined, { code: code.trim(), name: name.trim() }));
  }

  async connect({ target, askPairing, askRepair, log = console.log }: ConnectOptions = {}): Promise<Session> {
    const config = await this.config();
    const server = target ?? config.current;
    if (server === 'local') {
      const token = randomBytes(32).toString('base64url');
      const embedded = await this.startLocal({ home: this.home, host: '127.0.0.1', port: 0, sessionToken: token });
      try {
        await withLock(this.home, async () => {
          const latest = await this.config();
          await writeAtomic(this.configPath, `${JSON.stringify({ ...latest, current: 'local' }, null, 2)}\n`);
        });
        return new Session(embedded.url, token, this.userHome, this.codexAuthPath, () => embedded.close(), this, server);
      } catch (error) { await embedded.close(); throw error; }
    }
    const url = serverUrl(server);
    const id = await this.checkService(url);
    let replaced = false;
    let entry = config.servers[url];
    if (entry?.serverId && entry.serverId !== id) {
      const message = '该地址上的服务端不是之前配对的那个';
      if (!await askRepair?.(`${message}，是否重新配对？`)) throw new Error(message);
      entry = undefined;
      replaced = true;
    }
    if (entry && !await this.valid(url, entry.token)) {
      log(`${url} 的授权已失效或已被撤销，需要重新配对。`);
      entry = undefined;
    }
    entry ??= await this.manualPair(url, askPairing);
    entry = { ...entry, serverId: id };
    await withLock(this.home, async () => {
      const latest = await this.config();
      await writeAtomic(this.configPath, `${JSON.stringify({ ...latest, current: url, baseline: replaced ? null : latest.baseline, servers: { ...latest.servers, [url]: entry } }, null, 2)}\n`);
    });
    return new Session(url, entry.token, this.userHome, this.codexAuthPath, async () => {}, this, server);
  }
}
