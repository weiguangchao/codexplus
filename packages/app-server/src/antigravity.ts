import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  emailSchema, expandPath, isRecord, parseAuthDigest, ServiceError, UploadConflictError, withLock, writeAtomic,
} from '@weiguangchao/codexplus-shared';
import type { AntigravityAccount, AntigravityStatus, AuthDigest, Email } from '@weiguangchao/codexplus-shared';
import { recordCommitted } from './audit.js';
import { emailFromIdToken } from './login.js';

const fileName = 'antigravity-oauth-token';
const fileSchema = z.object({
  token: z.object({
    access_token: z.string().trim().min(1),
    refresh_token: z.string().optional(),
    token_type: z.string().optional(),
    expiry: z.iso.datetime({ offset: true }).optional(),
  }),
  auth_method: z.string().optional(),
  id_token_email: z.string().optional(),
  id_token: z.string().optional(),
});

function digest(content: Buffer): AuthDigest {
  return parseAuthDigest(createHash('sha256').update(content).digest('hex'));
}

function identify(content: Buffer): Email | null {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(content.toString('utf8')));
    if (!parsed.success) return null;
    const email = emailSchema.safeParse((parsed.data.id_token_email?.trim() || emailFromIdToken(parsed.data.id_token))?.toLowerCase());
    return email.success ? email.data : null;
  } catch { return null; }
}

function regularFileError(): ServiceError {
  return new ServiceError({ status: 400, message: 'Antigravity CLI 凭据必须是普通文件。' });
}

async function readCredential({ path, followSymlink = false }: { path: string; followSymlink?: boolean }): Promise<Buffer | null> {
  try {
    const info = await (followSymlink ? stat(path) : lstat(path));
    if (!info.isFile()) throw regularFileError();
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (followSymlink ? 0 : (constants.O_NOFOLLOW ?? 0));
    const handle = await open(path, flags);
    try {
      if (!(await handle.stat()).isFile()) throw regularFileError();
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

export class AntigravityLogins {
  private readonly authPath: string;
  private readonly vault: string;
  private readonly home: string;
  private readonly userHome: string;

  constructor({ home, userHome }: { home: string; userHome: string }) {
    this.home = home;
    this.userHome = userHome;
    this.authPath = join(userHome, '.gemini', 'antigravity-cli', fileName);
    this.vault = join(home, 'credentials', 'antigravity');
  }

  private path(email: Email): string { return join(this.vault, `agy-${email}`, fileName); }

  private async readSaved(email: Email): Promise<Buffer | null> {
    return await readCredential({ path: this.path(email) }).catch(() => null);
  }

  private async accounts(): Promise<AntigravityAccount[]> {
    const entries = await readdir(this.vault, { withFileTypes: true }).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return [];
      throw error;
    });
    const accounts: AntigravityAccount[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('agy-')) continue;
      const email = emailSchema.safeParse(entry.name.slice(4));
      if (!email.success) continue;
      const content = await this.readSaved(email.data);
      if (content !== null && identify(content) === email.data) accounts.push({ email: email.data, digest: digest(content) });
    }
    return accounts.toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async status(): Promise<AntigravityStatus> {
    return await withLock({ home: this.home, fn: async () => {
      const content = await readCredential({ path: this.authPath });
      const email = content === null ? null : identify(content);
      const current: AntigravityStatus['current'] = content === null ? { status: 'none', digest: null }
        : email === null ? { status: 'invalid', digest: digest(content) } : { status: 'valid', email, digest: digest(content) };
      return { authPath: this.authPath, current, accounts: await this.accounts() };
    } });
  }

  private async source(path?: string): Promise<{ account: AntigravityAccount; content: Buffer }> {
    const source = path === undefined ? this.authPath : expandPath({ home: this.userHome, path });
    const content = await readCredential({ path: source, followSymlink: path !== undefined });
    if (content === null) throw new ServiceError({ status: 400, message: '找不到 Antigravity CLI 凭据文件，请检查文件路径。' });
    const email = identify(content);
    if (email === null) {
      throw new ServiceError({ status: 400, message: 'Antigravity CLI 凭据文件缺少有效的 token 或账号邮箱。' });
    }
    return { account: { email, digest: digest(content) }, content };
  }

  async inspect(path: string): Promise<AntigravityAccount> { return (await this.source(path)).account; }

  async save({ path, sourceDigest, base }: { path?: string | undefined; sourceDigest: AuthDigest; base: AuthDigest | null }): Promise<void> {
    const saved = await withLock({ home: this.home, fn: async () => {
      const { account, content } = await this.source(path);
      if (account.digest !== sourceDigest) throw new ServiceError({ status: 409, message: '来源凭据已变化，请重新选择后保存。' });
      const destination = this.path(account.email);
      const previous = await readCredential({ path: destination });
      if (previous?.equals(content)) return null;
      const previousDigest = previous === null ? null : digest(previous);
      if (previousDigest !== base) {
        throw new UploadConflictError({ code: 'conflict', email: account.email, digest: previousDigest, lastRefresh: null, localRefresh: null });
      }
      await writeAtomic({ path: destination, content });
      return account.email;
    } });
    if (saved !== null) await recordCommitted({ home: this.home, event: '上传', client: { id: 'local', name: '本机' }, subject: { email: saved } });
  }

  async switch({ account, currentDigest }: { account: AntigravityAccount; currentDigest: AuthDigest | null }): Promise<void> {
    await withLock({ home: this.home, fn: async () => {
      const target = await this.readSaved(account.email);
      if (target === null || digest(target) !== account.digest || identify(target) !== account.email) {
        throw new ServiceError({ status: 409, message: '所选 Antigravity CLI 凭据已变化或不可用，请刷新后重新选择。' });
      }
      await withLock({ home: dirname(this.authPath), name: `.${fileName}.codexplus.lock`, fn: async () => {
        const current = await readCredential({ path: this.authPath });
        if ((current === null ? null : digest(current)) !== currentDigest) {
          throw new ServiceError({ status: 409, message: '当前 Antigravity CLI 凭据已变化，请刷新后重新选择。' });
        }
        await writeAtomic({ path: this.authPath, content: target });
      } });
    } });
    await recordCommitted({ home: this.home, event: '切换', client: { id: 'local', name: '本机' }, subject: { email: account.email } });
  }
}
