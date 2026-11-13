import { readFile, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { authDigest, credentialDirectory, isRecord, parseAuth, withLock, readOptional, writeAtomic, conflict, parseCredential } from '@codexplus/shared';
import { lookupAccount } from './account.js';
import type { Credential, UploadResult } from '@codexplus/shared';

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

  private async credentialPath(email: string): Promise<string> {
    const directory = credentialDirectory(email);
    const destination = join(this.credentialsPath, directory, 'auth.json');
    const legacyName = `${directory}.json`;
    if (Buffer.byteLength(legacyName) <= 255) {
      const legacy = join(this.credentialsPath, legacyName);
      const content = await readOptional(legacy);
      if (content !== null) {
        if (await readOptional(destination) === null) await writeAtomic(destination, content);
        await rm(legacy);
      }
    }
    return destination;
  }

  private async removeAuth(path: string): Promise<void> {
    await rm(path, { force: true });
    try { await rmdir(dirname(path)); } catch (error) {
      if (!isRecord(error) || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))) throw error;
    }
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

  async snapshots(): Promise<(Credential & { digest: string | null; lastRefresh: string | null })[]> {
    return await withLock(this.home, async () => await Promise.all((await this.listUnlocked()).map(async (credential) => {
      try {
        const content = await this.getUnlocked(credential);
        const value = parseAuth(content).last_refresh;
        return { ...credential, digest: authDigest(content), lastRefresh: typeof value === 'string' ? value : null };
      } catch { return { ...credential, digest: null, lastRefresh: null }; }
    })));
  }

  async delete(credential: Credential, base: string | null): Promise<void> {
    await withLock(this.home, async () => {
      const selected = parseCredential(credential);
      const config = await this.readConfig();
      if (!config.credentials.some((entry) => entry.email === selected.email)) throw new Error('未找到所选凭证。');
      const path = await this.credentialPath(selected.email);
      let content: string | null;
      let digest: string | null = null;
      try {
        content = await readFile(path, 'utf8');
        digest = authDigest(content);
      } catch { content = null; }
      if (digest !== base) throw conflict(selected.email, content);
      await writeAtomic(this.configPath, `${JSON.stringify({ ...config, credentials: config.credentials.filter((entry) => entry.email !== selected.email) }, null, 2)}\n`);
      await this.removeAuth(path);
    });
  }

  async list(): Promise<Credential[]> { return await withLock(this.home, () => this.listUnlocked()); }
  async get(credential: Credential): Promise<string> { return await withLock(this.home, () => this.getUnlocked(credential)); }
  async digest(credential: Credential): Promise<string | null> { return await withLock(this.home, () => this.digestUnlocked(credential)); }

  private async listUnlocked(): Promise<Credential[]> {
    const config = await this.readConfig();
    return config.credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async add(content: string, base: string | null = null): Promise<UploadResult> {
    const auth = parseAuth(content);
    const { email } = await lookupAccount(auth.tokens, this.request);
    return await withLock(this.home, async () => {
      const config = await this.readConfig();
      const credential: Credential = { type: 'codex', email };
      const destination = await this.credentialPath(email);
      const previous = await readOptional(destination);

      if (config.credentials.some((entry) => entry.email === email) && previous !== null) {
        let digest: string | null;
        try { digest = authDigest(previous); } catch { digest = null; }
        if (digest !== null && digest === authDigest(content)) return { credential, changed: false };
        if (digest !== null && digest !== base) throw conflict(email, previous);
      }
      await writeAtomic(destination, `${JSON.stringify(auth, null, 2)}\n`);
      try {
        const credentials = config.credentials.filter((entry) => entry.email !== email);
        credentials.push(credential);
        await writeAtomic(this.configPath, `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`);
      } catch (error) {
        if (previous === null) {
          await this.removeAuth(destination);
        } else {
          await writeAtomic(destination, previous);
        }
        throw error;
      }

      return { credential, changed: true };
    });
  }

  private async getUnlocked(credential: Credential): Promise<string> {
    const credentials = await this.listUnlocked();
    if (!credentials.some((entry) => entry.type === credential.type && entry.email === credential.email)) {
      throw new Error('未找到所选凭证，请先添加。');
    }
    const path = await this.credentialPath(credential.email);
    const content = await readFile(path, 'utf8');
    parseAuth(content);
    return content;
  }

  private async digestUnlocked(credential: Credential): Promise<string | null> {
    try {
      const content = await readFile(await this.credentialPath(credential.email), 'utf8');
      return authDigest(content);
    } catch {
      return null;
    }
  }
}
