import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { authDigest, expandPath, isRecord, newerRefresh, parseAuth, UploadConflictError, readOptional, ServiceError, writeAtomic } from '@weiguangchao/codexplus-shared';
import type { Auth, AuthDigest, Credential, CurrentLogin, Email, SaveOptions, UploadResult } from '@weiguangchao/codexplus-shared';
import { CredentialStore } from './store.js';
import { idTokenEmail } from './login.js';
import { LoginState } from './login-state.js';
import { syncCodexBar } from './codexbar.js';
import { recordCommitted } from './audit.js';

export class CurrentLoginStore {
  readonly authPath: string;
  readonly state: LoginState;

  readonly store: CredentialStore;
  readonly home: string;
  readonly userHome: string;
  constructor({ store, home, userHome, codexHome }: { store: CredentialStore; home: string; userHome: string; codexHome: string }) {
    this.store = store;
    this.home = home;
    this.userHome = userHome;

    this.authPath = join(expandPath({ home: userHome, path: codexHome }), 'auth.json');
    this.state = new LoginState({ home, authPath: this.authPath });
  }

  async info() {
    await this.state.get();
    return { home: this.home, userHome: this.userHome, authPath: this.authPath };
  }

  async current(): Promise<CurrentLogin> {
    let content: string | null;
    try { content = await readOptional(this.authPath); } catch {
      return { status: 'invalid', reason: '无法读取登录文件，请检查路径和文件权限。' };
    }
    if (content === null) return { status: 'none' };
    let auth;
    try { auth = parseAuth(content); } catch (error) {
      return { status: 'invalid', reason: error instanceof Error ? error.message : '登录文件格式无效。' };
    }
    const saved = await this.store.snapshots();
    const digest = authDigest(auth);
    const match = saved.find((credential) => credential.digest === digest);
    if (match) return { status: 'saved', email: match.email };
    const email = idTokenEmail(auth);
    const state = await this.state.get();
    const deleted = email !== null && state.deleted.has(email) ? email : [...state.deleted].find(([, value]) => value === digest)?.[0];
    if (deleted !== undefined) return { status: 'deleted', email: deleted };
    const snapshot = saved.find((credential) => credential.email === email && credential.digest !== null);
    if (email === null || !snapshot) return { status: 'unsaved', email };
    const base = state.baseline?.email === email ? state.baseline.digest : null;
    if (base === null) return { status: 'diverged', email };
    const newer = newerRefresh(auth.last_refresh, snapshot.lastRefresh);
    return { status: snapshot.digest === base && newer === 'local' ? 'ahead' : digest === base && newer === 'server' ? 'behind' : 'diverged', email };
  }

  async refreshTimes(email: Email) {
    let local: string | null;
    try {
      const refresh = parseAuth(await readFile(this.authPath, 'utf8')).last_refresh;
      local = typeof refresh === 'string' ? refresh : null;
    } catch { local = null; }
    const snapshot = (await this.store.snapshots()).find((entry) => entry.email === email);
    return { local, server: snapshot?.lastRefresh ?? null };
  }

  async readSource(sourcePath: string): Promise<{ path: string; auth: Auth }> {
    if (!sourcePath.trim()) throw new ServiceError({ status: 400, message: '请输入 auth.json 文件路径。' });
    const path = expandPath({ home: this.userHome, path: sourcePath });
    try {
      if (!(await stat(path)).isFile()) throw new ServiceError({ status: 400, message: `这是目录，请输入文件路径：${path}`, details: { code: 'EISDIR', path } });
      const auth = parseAuth(await readFile(path, 'utf8'));
      return { path, auth };
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string') {
        const message = ['ENOENT', 'ENOTDIR'].includes(error.code) ? '找不到文件' : ['EACCES', 'EPERM'].includes(error.code) ? '没有权限访问' : '无法读取文件';
        throw new ServiceError({ status: 400, message: `${message}：${path}`, details: { code: error.code, path } });
      }
      throw error;
    }
  }

  async import({ sourcePath, options }: { sourcePath: string; options: SaveOptions }): Promise<UploadResult> {
    const { path, auth } = await this.readSource(sourcePath);
    return await this.save({ auth, currentFile: path === this.authPath, options });
  }

  async saveCurrent(options: SaveOptions): Promise<UploadResult> {
    return await this.import({ sourcePath: this.authPath, options });
  }

  async save({ auth, currentFile, options }: { auth: Auth; currentFile: boolean; options: SaveOptions }): Promise<UploadResult> {
    const email = idTokenEmail(auth);
    const state = await this.state.get();
    const restoring = email !== null && state.deleted.has(email) ? email : [...state.deleted].find(([, digest]) => digest === authDigest(auth))?.[0] ?? null;
    if (!options.restore && (restoring !== null || state.deleted.size > 0 && email === null)) {
      throw new ServiceError({ status: 409, message: '账号已删除，需要确认后重新保存。', details: { code: 'restore_required', email: restoring } });
    }
    let base = options.base === undefined ? currentFile && state.baseline?.email === email ? state.baseline.digest : null : options.base;
    if (options.base === undefined && base !== null && email !== null) {
      const snapshot = (await this.store.snapshots()).find((entry) => entry.email === email);
      if (snapshot?.digest === base && authDigest(auth) !== base && newerRefresh(auth.last_refresh, snapshot.lastRefresh) !== 'local') base = null;
    }
    let result: UploadResult;
    try { result = await this.store.add({ auth, base }); } catch (error) {
      if (error instanceof UploadConflictError) {
        throw new UploadConflictError({ ...error.details, localRefresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : null });
      }
      throw error;
    }
    if (result.changed) await recordCommitted({ home: this.home, event: '上传', client: { id: 'local', name: '本机' }, subject: { email: result.credential.email } });
    if (currentFile || state.deleted.has(result.credential.email)) {
      await this.state.update((next) => {
        next.deleted.delete(result.credential.email);
        if (currentFile) next.baseline = { email: result.credential.email, digest: authDigest(auth) };
      });
    }
    return result;
  }

  async delete({ credential, base }: { credential: Credential; base: AuthDigest | null }): Promise<void> {
    await this.state.get();
    await this.store.delete({ credential, base });
    await recordCommitted({ home: this.home, event: '删除', client: { id: 'local', name: '本机' }, subject: { email: credential.email } });
    await this.state.update((state) => { state.deleted.set(credential.email, base); });
  }

  async switch(credential: Credential): Promise<{ ok: true; warning?: string }> {
    const auth = await this.store.get(credential);
    await this.state.update(async (state) => {
      await writeAtomic({ path: this.authPath, content: `${JSON.stringify(auth, null, 2)}\n` });
      state.baseline = { email: credential.email, digest: authDigest(auth) };
    });
    await recordCommitted({ home: this.home, event: '切换', client: { id: 'local', name: '本机' }, subject: { email: credential.email } });
    try {
      const credentials = (await this.store.snapshots()).filter((entry) => entry.digest !== null);
      await syncCodexBar({ userHome: this.userHome, home: this.home, credentials, currentEmail: credential.email });
      return { ok: true };
    } catch (error) {
      return { ok: true, warning: `账号已切换，但 CodexBar 同步失败：${error instanceof Error ? error.message : '请检查配置文件和权限。'}` };
    }
  }
}
