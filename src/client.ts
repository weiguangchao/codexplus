import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localKeyPath } from './access.js';
import { isRecord, parseAuth } from './auth.js';
import { expandPath, readOptional, writeAtomic } from './files.js';
import { defaultServerUrl, parseCredential, requestService, serverUrl } from './protocol.js';
import type { Credential } from './protocol.js';

type Connection = { version: 1; mode: 'local'; url: string } |
  { version: 1; mode: 'remote'; url: string; token: string; clientId: string };

export class CredentialClient {
  readonly configPath: string;
  readonly codexAuthPath: string;
  private readonly home: string;
  private readonly userHome: string;

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus') }:
    { home?: string; userHome?: string } = {}) {
    this.home = home;
    this.userHome = userHome;
    this.configPath = join(home, 'client.json');
    this.codexAuthPath = join(userHome, '.codex', 'auth.json');
  }

  async connection(): Promise<Connection> {
    const content = await readOptional(this.configPath);
    if (content === null) {
      return { version: 1, mode: 'local', url: defaultServerUrl };
    }
    try {
      const value: unknown = JSON.parse(content);
      if (!isRecord(value) || value.version !== 1 || typeof value.url !== 'string') {
        throw new Error();
      }
      if (value.mode === 'local') {
        return { version: 1, mode: 'local', url: serverUrl(value.url, true) };
      }
      if (value.mode === 'remote' && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value.token) &&
        typeof value.clientId === 'string' && value.clientId) {
        return { version: 1, mode: 'remote', url: serverUrl(value.url), token: value.token, clientId: value.clientId };
      }
      throw new Error();
    } catch {
      throw new Error('客户端连接配置格式无效，请重新配对或选择本地服务端；已有文件未被覆盖。');
    }
  }

  private async save(connection: Connection): Promise<void> {
    await writeAtomic(this.configPath, `${JSON.stringify(connection, null, 2)}\n`);
  }

  private async request(path: string, body?: unknown, connection?: Connection): Promise<unknown> {
    const target = connection ?? await this.connection();
    const token = target.mode === 'remote' ? target.token : await readOptional(localKeyPath(this.home));
    if (!token) {
      throw new Error('本地服务端尚未初始化，请先以同一用户运行 codexplus-server；跨机器使用请先配对。');
    }
    return await requestService(target.url, path, token, body);
  }

  async useLocal(url = defaultServerUrl): Promise<void> {
    const connection: Connection = { version: 1, mode: 'local', url: serverUrl(url, true) };
    await this.request('/v1/credentials', undefined, connection);
    await this.save(connection);
  }

  async pair(url: string, code: string, name: string): Promise<void> {
    const target = serverUrl(url);
    const result = await requestService(target, '/v1/pair', undefined, { code: code.trim(), name: name.trim() });
    if (!isRecord(result) || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(result.token) ||
      !isRecord(result.client) || typeof result.client.id !== 'string' || !result.client.id) {
      throw new Error('服务端配对响应格式无效，未保存客户端配置。');
    }
    await this.save({ version: 1, mode: 'remote', url: target, token: result.token, clientId: result.client.id });
  }

  async list(): Promise<Credential[]> {
    const result = await this.request('/v1/credentials');
    if (!isRecord(result) || !Array.isArray(result.credentials)) {
      throw new Error('服务端凭证列表格式无效。');
    }
    return result.credentials.map(parseCredential);
  }

  async add(sourcePath: string): Promise<Credential> {
    const content = await readFile(expandPath(sourcePath, this.userHome), 'utf8');
    const auth = parseAuth(content);
    const result = await this.request('/v1/credentials', { auth });
    if (!isRecord(result)) {
      throw new Error('服务端凭证响应格式无效。');
    }
    return parseCredential(result.credential);
  }

  async switch(credential: Credential): Promise<void> {
    const selected = parseCredential(credential);
    const result = await this.request('/v1/credentials/download', selected);
    if (!isRecord(result)) {
      throw new Error('服务端凭证响应格式无效，当前登录未更改。');
    }
    const auth = parseAuth(JSON.stringify(result.auth));
    await writeAtomic(this.codexAuthPath, `${JSON.stringify(auth, null, 2)}\n`);
  }
}
