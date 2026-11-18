import {
  antigravityAccountSchema,
  antigravityStatusSchema,
  writeOutput,
  isRecord,
  parseAccountInfo,
  parseCredentialSnapshots,
  parseUploadResult,
  parseCurrentLogin,
  parseProcesses,
  parseRefreshTimes,
  parseBrowserSession,
  parseBrowserStatus,
  parseUploadFailure,
  parseLoginInfo,
  parseResetRequestId,
  parseResetCard,
  parseResetCardOutcome,
  requestService,
  protocolVersion,
  ServiceError,
} from '@weiguangchao/codexplus-shared';
import type { AntigravityAccount } from '@weiguangchao/codexplus-shared';
import type { AccountInfo, AuthDigest, BrowserLoginId, Credential, CurrentLogin, Email, ResetCard, ResetCardId, ResetCardOutcome, ResetRequestId, SaveRequest, UploadConflict, UploadResult, RpcRequest } from '@weiguangchao/codexplus-shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startServer } from '@weiguangchao/codexplus-server';

export interface ConnectOptions {
  log?: (message: string) => void;
}

type StartLocal = typeof startServer;

export class UploadCancelled extends Error {
  constructor(message = '已取消，服务端保存的版本未更改。') { super(message); }
}

export class Session {
  confirmUpload?: (details: UploadConflict) => Promise<boolean>;
  confirmRestore?: (email: Email | null) => Promise<boolean>;
  private digests = new Map<Email, AuthDigest | null>();
  private resetRequests = new Map<string, ResetRequestId>();

  readonly url: string;
  readonly userHome: string;
  readonly codexAuthPath: string;
  private readonly stop: () => Promise<void>;
  readonly home: string;
  private readonly log: (message: string) => void;
  private readonly sessionToken: string | undefined;
  constructor({ url, userHome, codexAuthPath, stop, home = userHome, log = writeOutput, sessionToken }: {
    url: string;
    userHome: string;
    codexAuthPath: string;
    stop: () => Promise<void>;
    home?: string | undefined;
    log?: ((message: string) => void) | undefined;
    sessionToken?: string | undefined;
  }) {
    this.url = url;
    this.userHome = userHome;
    this.codexAuthPath = codexAuthPath;
    this.stop = stop;
    this.home = home;
    this.log = log;
    this.sessionToken = sessionToken;
  }

  private async request({ method, params, timeoutMs }: { method: string; params?: RpcRequest['params']; timeoutMs?: number | undefined }): Promise<unknown> {
    return await requestService({ url: this.url, method, params, sessionToken: this.sessionToken, timeoutMs });
  }

  async list(): Promise<Credential[]> {
    const credentials = parseCredentialSnapshots(await this.request({ method: 'credentials.list' }));
    this.digests = new Map(credentials.map(({ email, digest }) => [email, digest]));
    return credentials.map(({ type, email }) => ({ type, email })).toSorted((left, right) => left.email.localeCompare(right.email));
  }

  async current(): Promise<CurrentLogin> {
    return parseCurrentLogin(await this.request({ method: 'login.current' }));
  }

  snapshotDigest(email: Email): AuthDigest | null { return this.digests.get(email) ?? null; }

  async accountInfo(): Promise<AccountInfo> {
    return parseAccountInfo(await this.request({ method: 'login.accountInfo', params: undefined, timeoutMs: 35_000 }));
  }

  async refreshTimes(email: Email) {
    return parseRefreshTimes(await this.request({ method: 'login.refreshTimes', params: { type: 'codex', email } }));
  }

  async processes() {
    return parseProcesses(await this.request({ method: 'login.processes' }));
  }

  async validateSource(path: string): Promise<void> { await this.request({ method: 'credentials.validate', params: { path } }); }

  async antigravityStatus() {
    return antigravityStatusSchema.parse(await this.request({ method: 'antigravity.status' }));
  }

  async inspectAntigravity(path: string): Promise<AntigravityAccount> {
    return antigravityAccountSchema.parse(await this.request({ method: 'antigravity.inspect', params: { path } }));
  }

  async saveAntigravity(params: { path?: string | undefined; sourceDigest: AuthDigest; base: AuthDigest | null }): Promise<void> {
    await this.request({ method: 'antigravity.save', params });
  }

  async switchAntigravity(params: { account: AntigravityAccount; currentDigest: AuthDigest | null }): Promise<void> {
    await this.request({ method: 'antigravity.switch', params });
  }

  async add({ path, base, upload = (task) => task() }: { path: string; base?: AuthDigest | null | undefined; upload?: ((task: () => Promise<unknown>) => Promise<unknown>) | undefined }): Promise<UploadResult> {
    return await this.save({ request: { kind: 'credentials.import', path, ...(base === undefined ? {} : { base }) }, upload });
  }

  async saveCurrent({ base, upload = (task) => task() }: { base?: AuthDigest | null | undefined; upload?: ((task: () => Promise<unknown>) => Promise<unknown>) | undefined } = {}): Promise<UploadResult> {
    return await this.save({ request: { kind: 'login.save', ...(base === undefined ? {} : { base }) }, upload });
  }

  async saveBrowserLogin({ id, upload = (task) => task() }: { id: BrowserLoginId; upload?: ((task: () => Promise<unknown>) => Promise<unknown>) | undefined }): Promise<UploadResult> {
    return await this.save({ request: { kind: 'login.browser.save', id }, upload });
  }

  private async save({ request, upload }: { request: SaveRequest; upload: (task: () => Promise<unknown>) => Promise<unknown> }): Promise<UploadResult> {
    for (;;) {
      try {
        const { kind, ...params } = request;
        const result = await upload(() => this.request({ method: kind, params }));
        return parseUploadResult(result);
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 409) throw error;
        const details = parseUploadFailure(error.details);
        if (details.code === 'restore_required') {
          if (!await this.confirmRestore?.(details.email)) {
            throw new UploadCancelled('已取消，账号未重新保存。');
          }
          request.restore = true;
        } else if (details.code === 'conflict' && this.confirmUpload) {
          if (!await this.confirmUpload(details)) throw new UploadCancelled();
          request.base = details.digest;
        } else throw error;
      }
    }
  }

  async browserLogin({ signal, onUrl, onBrowserError }: { signal: AbortSignal; onUrl: (url: string) => void; onBrowserError: () => void }): Promise<BrowserLoginId> {
    signal.throwIfAborted();
    const { id } = parseBrowserSession(await this.request({ method: 'login.browser.start', params: {} }));
    try {
      for (;;) {
        signal.throwIfAborted();
        const status = parseBrowserStatus(await this.request({ method: 'login.browser.status', params: { id } }));
        if (status.url) onUrl(status.url);
        if (status.manual === true) onBrowserError();
        if (status.status === 'complete') { signal.throwIfAborted(); return id; }
        if (status.status === 'error') throw new Error(status.error);
        await setTimeout(200, undefined, { signal });
      }
    } catch (error) {
      await this.cancelBrowserLogin(id);
      throw error;
    }
  }

  async cancelBrowserLogin(id: BrowserLoginId): Promise<void> { await this.request({ method: 'login.browser.cancel', params: { id } }); }

  async delete(credential: Credential): Promise<void> {
    const base = this.digests.get(credential.email);
    if (base === undefined) throw new Error('账号列表已变化，请刷新后重新选择。');
    await this.request({ method: 'credentials.delete', params: { ...credential, base } });
    this.digests.delete(credential.email);
  }

  async resetCards(credential: Credential): Promise<ResetCard[]> {
    const result = await this.request({ method: 'resetCards.list', params: credential });
    if (!isRecord(result) || !Array.isArray(result.cards)) throw new Error('服务端重置卡列表格式无效。');
    return result.cards.map(parseResetCard);
  }

  async useResetCard({ credential, cardId }: { credential: Credential; cardId: ResetCardId }): Promise<ResetCardOutcome> {
    const selected = credential;
    const key = JSON.stringify([selected.email, cardId]);
    const requestId = this.resetRequests.get(key) ?? parseResetRequestId(randomUUID());
    this.resetRequests.set(key, requestId);
    const result = await this.request({ method: 'resetCards.use', params: { ...selected, cardId, requestId } });
    const outcome = parseResetCardOutcome(isRecord(result) ? result.outcome : undefined);
    this.resetRequests.delete(key);
    return outcome;
  }

  async switch(credential: Credential): Promise<void> {
    const result = await this.request({ method: 'login.switch', params: credential });
    if (!isRecord(result) || result.ok !== true) throw new Error('服务端切换响应格式无效。');
    if (typeof result.warning === 'string') this.log(result.warning);
  }

  async restartCodexServer(): Promise<void> {
    const result = await this.request({ method: 'login.restartServer', params: {}, timeoutMs: 360_000 });
    if (!isRecord(result) || result.ok !== true) throw new Error('服务端重启响应格式无效。');
  }

  async close(): Promise<void> { await this.stop(); }
}

export class CredentialClient {
  readonly home: string;
  private readonly userHome: string;
  private readonly codexHome: string | undefined;
  private readonly startLocal: StartLocal;

  constructor({ userHome = homedir(), home = join(userHome, '.codexplus'), codexHome, startLocal = startServer }:
    { home?: string; userHome?: string; codexHome?: string; startLocal?: StartLocal } = {}) {
    this.home = home;
    this.userHome = userHome;
    this.codexHome = codexHome;
    this.startLocal = startLocal;
  }

  async connect({ log = writeOutput }: ConnectOptions = {}): Promise<Session> {
    const sessionToken = randomBytes(32).toString('base64url');
    const embedded = await this.startLocal({ home: this.home, userHome: this.userHome,
      ...(this.codexHome === undefined ? {} : { codexHome: this.codexHome }), port: 0, sessionToken });
    const url = embedded.url;
    try {
      const health = await requestService({ url, method: 'health' });
      if (!isRecord(health) || health.service !== 'codexplus') throw new Error(`${url} 上运行的不是 codexplus 服务端。`);
      if (health.version !== protocolVersion) throw new Error('版本不兼容，请把两端升级到同一版本。');
      const info = parseLoginInfo(await requestService({ url, method: 'login.info', params: undefined, sessionToken }));
      return new Session({ url, userHome: info.userHome, codexAuthPath: info.authPath, stop: async () => { await embedded.close(); }, home: info.home, log, sessionToken });
    } catch (error) {
      await embedded.close();
      throw error;
    }
  }
}
