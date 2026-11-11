import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { authDigest, credentialFilename, isRecord, lookupAccount, parseAuth } from './auth.js';
import { withLock } from './lock.js';
import { readOptional, writeAtomic } from './files.js';
import { conflict, parseCredential } from './protocol.js';
import type { Credential } from './protocol.js';

interface Config {
  version: 1;
  credentials: Credential[];
}

export class CredentialStore {
  private readonly home: string;
  readonly configPath: string;
  readonly credentialsPath: string;

  private readonly request: typeof fetch;

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus'), request = fetch }:
    { home?: string; userHome?: string; request?: typeof fetch } = {}) {
    this.home = home;
    this.request = request;
    this.configPath = join(home, 'config.json');
    this.credentialsPath = join(home, 'credentials');
  }

  private async readConfig(): Promise<Config> {
    const content = await readOptional(this.configPath);
    if (content === null) {
      return { version: 1, credentials: [] };
    }

    try {
      const config: unknown = JSON.parse(content);
      if (!isRecord(config) || config.version !== 1 || !Array.isArray(config.credentials)) {
        throw new Error();
      }
      const credentials = config.credentials.map(parseCredential);
      return { version: 1, credentials };
    } catch {
      throw new Error(`${this.configPath} 格式无效，请检查配置；已有文件未被覆盖。`);
    }
  }

  async list(): Promise<Credential[]> { return await withLock(this.home, () => this.listUnlocked()); }
  async get(credential: Credential): Promise<string> { return await withLock(this.home, () => this.getUnlocked(credential)); }
  async digest(credential: Credential): Promise<string | null> { return await withLock(this.home, () => this.digestUnlocked(credential)); }

  private async listUnlocked(): Promise<Credential[]> {
    const config = await this.readConfig();
    return config.credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async add(content: string, base: string | null = null): Promise<Credential> {
    const auth = parseAuth(content);
    const { email } = await lookupAccount(auth.tokens, this.request);
    return await withLock(this.home, async () => {
    const config = await this.readConfig();
    const credential: Credential = { type: 'codex', email };
    const destination = join(this.credentialsPath, credentialFilename(email));
    const previous = await readOptional(destination);

    if (config.credentials.some((entry) => entry.email === email) && previous !== null) {
      const digest = authDigest(previous);
      if (digest === authDigest(content)) return credential;
      if (digest !== base) throw conflict(email, previous);
    }
    await writeAtomic(destination, `${JSON.stringify(auth, null, 2)}\n`);
    try {
      const credentials = config.credentials.filter((entry) => entry.email !== email);
      credentials.push(credential);
      await writeAtomic(this.configPath, `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`);
    } catch (error) {
      if (previous === null) {
        await rm(destination, { force: true });
      } else {
        await writeAtomic(destination, previous);
      }
      throw error;
    }

    return credential;
    });
  }

  private async getUnlocked(credential: Credential): Promise<string> {
    const credentials = await this.listUnlocked();
    if (!credentials.some((entry) => entry.type === credential.type && entry.email === credential.email)) {
      throw new Error('未找到所选凭证，请先添加。');
    }
    const path = join(this.credentialsPath, credentialFilename(credential.email));
    const content = await readFile(path, 'utf8');
    parseAuth(content);
    return content;
  }

  private async digestUnlocked(credential: Credential): Promise<string | null> {
    try {
      const content = await readFile(join(this.credentialsPath, credentialFilename(credential.email)), 'utf8');
      return authDigest(content);
    } catch {
      return null;
    }
  }
}
