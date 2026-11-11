import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { authDigest, idTokenEmail, isRecord, parseAuth } from './auth.js';
import { expandPath, readOptional, writeAtomic } from './files.js';
import { requestLocalProof } from './local-codes.js';
import { defaultServerUrl, isLoopbackUrl, parseCredential, requestService, serverUrl, ServiceError } from './protocol.js';
import type { Credential, CurrentLogin } from './protocol.js';
import { startServer } from './server.js';

export interface ServerEntry {
  token: string;
  clientId: string;
  pairing: 'local' | 'code';
}

export interface ClientConfig {
  version: 1;
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
  askPairing?: (url: string) => Promise<Pairing>;
  log?: (message: string) => void;
  name?: string;
}

type StartLocal = (options: { home: string; host: string; port: number }) => Promise<{ close(): Promise<void> }>;

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function parseEntry(value: unknown): ServerEntry {
  if (!isRecord(value) || typeof value.token !== 'string' || !tokenPattern.test(value.token) ||
    typeof value.clientId !== 'string' || !value.clientId || (value.pairing !== 'local' && value.pairing !== 'code')) {
    throw new Error();
  }
  return { token: value.token, clientId: value.clientId, pairing: value.pairing };
}

function parsePairResult(result: unknown, pairing: ServerEntry['pairing']): ServerEntry {
  if (!isRecord(result) || typeof result.token !== 'string' || !tokenPattern.test(result.token) ||
    !isRecord(result.client) || typeof result.client.id !== 'string' || !result.client.id) {
    throw new Error('服务端配对响应格式无效，未保存客户端配置。');
  }
  return { token: result.token, clientId: result.client.id, pairing };
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
    private readonly verify: () => Promise<void> = async () => {},
    private readonly owner?: CredentialClient,
    readonly server = url,
  ) {}

  private async request(path: string, body?: unknown): Promise<unknown> {
    await this.verify();
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

  async add(sourcePath: string): Promise<Credential> {
    if (!sourcePath.trim()) {
      throw new Error('请输入 auth.json 文件路径。');
    }
    const content = await readFile(expandPath(this.userHome, sourcePath), 'utf8');
    const auth = parseAuth(content);
    const currentFile = expandPath(this.userHome, sourcePath) === this.codexAuthPath;
    const baseline = (await this.owner?.config())?.baseline;
    let base = currentFile && baseline?.server === this.server ? baseline.digest : null;
    let result: unknown;
    for (;;) {
      try { result = await this.request('/v1/credentials', { auth, base }); break; } catch (error) {
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
    if (content === null) {
      return { version: 1, current: defaultServerUrl, servers: {}, baseline: null };
    }
    try {
      const value: unknown = JSON.parse(content);
      if (!isRecord(value) || value.version !== 1 || typeof value.current !== 'string' || !isRecord(value.servers)) {
        throw new Error();
      }
      const servers: Record<string, ServerEntry> = {};
      for (const [url, entry] of Object.entries(value.servers)) {
        servers[serverUrl(url)] = parseEntry(entry);
      }
      return { version: 1, current: serverUrl(value.current), servers, baseline: isRecord(value.baseline) && typeof value.baseline.server === 'string' && typeof value.baseline.email === 'string' && typeof value.baseline.digest === 'string' ? value.baseline as unknown as ClientConfig['baseline'] : null };
    } catch {
      throw new Error(`${this.configPath} 格式无效，请修复或删除该文件后重新配对；已有文件未被覆盖。`);
    }
  }

  async setBaseline(baseline: ClientConfig['baseline']): Promise<void> {
    const config = await this.config();
    await writeAtomic(this.configPath, `${JSON.stringify({ ...config, baseline }, null, 2)}\n`);
  }

  private async startEmbedded(url: string): Promise<{ close(): Promise<void> } | null> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') {
      return null;
    }
    try {
      return await this.startLocal({
        home: this.home,
        host: parsed.hostname === '[::1]' ? '::1' : parsed.hostname,
        port: Number(parsed.port || 80),
      });
    } catch (error) {
      if (isRecord(error) && error.code === 'EADDRINUSE') {
        return null;
      }
      throw error;
    }
  }

  private async checkService(url: string): Promise<void> {
    const result = await requestService(url, '/v1/health');
    if (!isRecord(result) || result.service !== 'codexplus') throw new Error(`${url} 上运行的不是 codexplus 服务端。`);
    if (result.version !== 2) throw new Error('版本不兼容，请把两端升级到同一版本。');
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

  private async localPair(url: string, name: string, log: (message: string) => void, embedded: boolean): Promise<ServerEntry | null> {
    const proof = await requestLocalProof(url, this.home, 'pair');
    if (proof === null) {
      log(`无法读取 ${url} 的本机配对文件：客户端与服务端的系统用户或 --home 目录不同，需要手动输入配对码。`);
      return null;
    }
    const entry = parsePairResult(await requestService(url, '/v1/local/pair', undefined, { proof, name }), 'local');
    log(embedded
      ? `已启动本地服务端（${url}，目录 ${this.home}）并自动完成配对。`
      : `检测到本机已运行的 codexplus 服务端（${url}，目录 ${this.home}），已通过本机文件自动配对。`);
    return entry;
  }

  private async manualPair(url: string, askPairing: ConnectOptions['askPairing']): Promise<ServerEntry> {
    if (!askPairing) {
      throw new Error(`${url} 需要配对码，请在服务端运行 codexplus serve pair 生成。`);
    }
    const { code, name } = await askPairing(url);
    return parsePairResult(await requestService(url, '/v1/pair', undefined, { code: code.trim(), name: name.trim() }), 'code');
  }

  async connect({ target, askPairing, log = console.log, name = hostname() }: ConnectOptions = {}): Promise<Session> {
    const config = await this.config();
    const url = target ?? config.current;
    const local = isLoopbackUrl(url);
    const embedded = local ? await this.startEmbedded(url) : null;
    try {
      if (!embedded) {
        await this.checkService(url);
      }
      let entry = config.servers[url];
      const verify = async (): Promise<void> => {
        if (await requestLocalProof(url, this.home, 'verify') === null) {
          throw new Error(`${url} 上的服务端无法证明它使用当前系统用户和 --home 目录，已停止连接，未发送令牌或凭证。`);
        }
      };
      if (entry?.pairing === 'local' && !embedded) {
        await verify();
      }
      if (entry && !await this.valid(url, entry.token)) {
        log(`${url} 的授权已失效或已被撤销，需要重新配对。`);
        entry = undefined;
      }
      entry ??= (local ? await this.localPair(url, name, log, embedded !== null) : null) ??
        await this.manualPair(url, askPairing);
      if (config.current !== url || config.servers[url] !== entry) {
        const latest = await this.config();
        const next: ClientConfig = { version: 1, current: url, servers: { ...latest.servers, [url]: entry }, baseline: latest.baseline };
        await writeAtomic(this.configPath, `${JSON.stringify(next, null, 2)}\n`);
      }
      return new Session(url, entry.token, this.userHome, this.codexAuthPath, async () => { await embedded?.close(); },
        entry.pairing === 'local' && !embedded ? verify : undefined, this);
    } catch (error) {
      await embedded?.close();
      throw error;
    }
  }
}
