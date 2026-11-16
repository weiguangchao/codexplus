import { z } from 'zod';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { authDigest, credentialDirectory, isRecord, parseAuth, withLock, readOptional, writeAtomic, conflict, credentialSchema } from '@weiguangchao/codexplus-shared';
import { lookupAccount } from './account.js';
import type { Auth, AuthDigest, Credential, CredentialSnapshot, Email, UploadResult } from '@weiguangchao/codexplus-shared';

const configSchema = z.object({ version: z.literal(1), credentials: z.array(credentialSchema) });
type Config = z.infer<typeof configSchema>;

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

  private async credentialPath(email: Email): Promise<string> {
    const directory = credentialDirectory(email);
    const destination = join(this.credentialsPath, directory, 'auth.json');
    const legacyName = `${directory}.json`;
    if (Buffer.byteLength(legacyName) <= 255) {
      const legacy = join(this.credentialsPath, legacyName);
      const content = await readOptional(legacy);
      if (content !== null) {
        if (await readOptional(destination) === null) await writeAtomic({ path: destination, content });
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
      return configSchema.parse(JSON.parse(content));
    } catch {
      throw new Error(`${this.configPath} 格式无效，请检查配置；已有文件未被覆盖。`);
    }
  }

  async snapshots(): Promise<CredentialSnapshot[]> {
    return await withLock({ home: this.home, fn: async () => await Promise.all((await this.listUnlocked()).map(async (credential) => {
      try {
        const auth = await this.getUnlocked(credential);
        const value = auth.last_refresh;
        return { ...credential, digest: authDigest(auth), lastRefresh: typeof value === 'string' ? value : null };
      } catch { return { ...credential, digest: null, lastRefresh: null }; }
    })) });
  }

  async delete({ credential, base }: { credential: Credential; base: AuthDigest | null }): Promise<void> {
    await withLock({ home: this.home, fn: async () => {
      const selected = credential;
      const config = await this.readConfig();
      if (!config.credentials.some((entry) => entry.email === selected.email)) throw new Error('未找到所选凭证。');
      const path = await this.credentialPath(selected.email);
      let auth: Auth | null;
      let digest: AuthDigest | null = null;
      try {
        auth = parseAuth(await readFile(path, 'utf8'));
        digest = authDigest(auth);
      } catch { auth = null; }
      if (digest !== base) throw conflict({ email: selected.email, auth });
      await writeAtomic({ path: this.configPath, content: `${JSON.stringify({ ...config, credentials: config.credentials.filter((entry) => entry.email !== selected.email) }, null, 2)}\n` });
      await this.removeAuth(path);
    } });
  }

  async list(): Promise<Credential[]> { return await withLock({ home: this.home, fn: () => this.listUnlocked() }); }
  async get(credential: Credential): Promise<Auth> { return await withLock({ home: this.home, fn: () => this.getUnlocked(credential) }); }
  async digest(credential: Credential): Promise<AuthDigest | null> { return await withLock({ home: this.home, fn: () => this.digestUnlocked(credential) }); }

  private async listUnlocked(): Promise<Credential[]> {
    const config = await this.readConfig();
    return config.credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async add({ auth, base = null }: { auth: Auth; base?: AuthDigest | null | undefined }): Promise<UploadResult> {
    const { email } = await lookupAccount({ tokens: auth.tokens, request: this.request });
    return await withLock({ home: this.home, fn: async () => {
      const config = await this.readConfig();
      const credential: Credential = { type: 'codex', email };
      const destination = await this.credentialPath(email);
      const previous = await readOptional(destination);

      if (config.credentials.some((entry) => entry.email === email) && previous !== null) {
        let digest: AuthDigest | null;
        try { digest = authDigest(parseAuth(previous)); } catch { digest = null; }
        if (digest !== null && digest === authDigest(auth)) return { credential, changed: false };
        if (digest !== null && digest !== base) throw conflict({ email, auth: parseAuth(previous) });
      }
      await writeAtomic({ path: destination, content: `${JSON.stringify(auth, null, 2)}\n` });
      try {
        const credentials = config.credentials.filter((entry) => entry.email !== email);
        credentials.push(credential);
        await writeAtomic({ path: this.configPath, content: `${JSON.stringify({ version: 1, credentials }, null, 2)}\n` });
      } catch (error) {
        if (previous === null) {
          await this.removeAuth(destination);
        } else {
          await writeAtomic({ path: destination, content: previous });
        }
        throw error;
      }

      return { credential, changed: true };
    } });
  }

  private async getUnlocked(credential: Credential): Promise<Auth> {
    const credentials = await this.listUnlocked();
    if (!credentials.some((entry) => entry.type === credential.type && entry.email === credential.email)) {
      throw new Error('未找到所选凭证，请先添加。');
    }
    const path = await this.credentialPath(credential.email);
    const content = await readFile(path, 'utf8');
    return parseAuth(content);
  }

  private async digestUnlocked(credential: Credential): Promise<AuthDigest | null> {
    try {
      const content = await readFile(await this.credentialPath(credential.email), 'utf8');
      return authDigest(parseAuth(content));
    } catch {
      return null;
    }
  }
}
