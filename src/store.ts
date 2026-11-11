import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { credentialFilename, idTokenEmail, isRecord, lookupAccount, parseAuth } from './auth.js';

export interface Credential {
  type: 'codex';
  email: string;
}

export type CurrentLogin =
  | { status: 'none' }
  | { status: 'saved'; email: string }
  | { status: 'stale'; email: string }
  | { status: 'unsaved'; email: string | null };

interface Config {
  version: 1;
  credentials: Credential[];
}

interface StoreOptions {
  home?: string;
  userHome?: string;
  request?: typeof fetch;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function normalizeAuth(content: string): string | null {
  try {
    return JSON.stringify(parseAuth(content));
  } catch {
    return null;
  }
}

export function expandPath(home: string, path: string): string {
  let trimmed = path.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    trimmed = trimmed.slice(1, -1);
  } else if (process.platform !== 'win32') {
    trimmed = trimmed.replaceAll('\\ ', ' ');
  }
  return trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : resolve(trimmed);
}

export class CredentialStore {
  readonly configPath: string;
  readonly credentialsPath: string;
  readonly codexAuthPath: string;
  readonly userHome: string;
  private readonly request: typeof fetch;

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus'), request = fetch }: StoreOptions = {}) {
    this.userHome = userHome;
    this.request = request;
    this.configPath = join(home, 'config.json');
    this.credentialsPath = join(home, 'credentials');
    this.codexAuthPath = join(userHome, '.codex', 'auth.json');
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
      const credentials: Credential[] = config.credentials.map((entry: unknown) => {
        if (!isRecord(entry) || entry.type !== 'codex' || typeof entry.email !== 'string') {
          throw new Error();
        }
        credentialFilename(entry.email);
        return { type: 'codex', email: entry.email };
      });
      return { version: 1, credentials };
    } catch {
      throw new Error(`${this.configPath} 格式无效，请检查配置；已有文件未被覆盖。`);
    }
  }

  async list(): Promise<Credential[]> {
    const config = await this.readConfig();
    return config.credentials.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async current(credentials?: Credential[]): Promise<CurrentLogin> {
    const content = await readOptional(this.codexAuthPath).catch(() => '');
    if (content === null) {
      return { status: 'none' };
    }
    const saved = credentials ?? (await this.list());
    const login = normalizeAuth(content);
    const backups = new Map<string, string>();
    for (const credential of saved) {
      const snapshot = await readOptional(join(this.credentialsPath, credentialFilename(credential.email))).catch(() => null);
      const normalized = snapshot === null ? null : normalizeAuth(snapshot);
      if (normalized !== null) {
        backups.set(credential.email, normalized);
      }
    }
    for (const [email, snapshot] of backups) {
      if (login !== null && snapshot === login) {
        return { status: 'saved', email };
      }
    }
    const email = idTokenEmail(content);
    return email !== null && backups.has(email) ? { status: 'stale', email } : { status: 'unsaved', email };
  }

  async add(sourcePath: string): Promise<Credential> {
    const path = sourcePath.trim();
    if (!path) {
      throw new Error('请输入 auth.json 文件路径。');
    }
    const content = await readFile(expandPath(this.userHome, path), 'utf8');
    const auth = parseAuth(content);
    const config = await this.readConfig();
    const { email } = await lookupAccount(auth.tokens, this.request);
    const credential: Credential = { type: 'codex', email };
    const destination = join(this.credentialsPath, credentialFilename(email));
    const previous = await readOptional(destination);

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
  }

  async switch(credential: Credential): Promise<void> {
    const credentials = await this.list();
    if (!credentials.some((entry) => entry.type === credential.type && entry.email === credential.email)) {
      throw new Error('未找到所选凭证，请先添加。');
    }
    const path = join(this.credentialsPath, credentialFilename(credential.email));
    const content = await readFile(path, 'utf8');
    parseAuth(content);
    await writeAtomic(this.codexAuthPath, content);
  }
}
