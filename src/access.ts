import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { withLock } from './lock.js';
import { isRecord } from './auth.js';
import { readOptional, writeAtomic } from './files.js';

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PairedClient {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
}

interface AccessState {
  version: 1;
  id?: string;
  pair: { digest: string; expiresAt: number } | null;
  clients: (PairedClient & { digest: string })[];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseState(content: string): AccessState {
  const state: unknown = JSON.parse(content);
  if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.clients) || (state.id !== undefined && typeof state.id !== 'string') ||
    !(state.pair === null || (isRecord(state.pair) && typeof state.pair.digest === 'string' &&
      typeof state.pair.expiresAt === 'number')) ||
    !state.clients.every((client: unknown) => isRecord(client) && typeof client.id === 'string' &&
      typeof client.name === 'string' && typeof client.createdAt === 'string' && typeof client.digest === 'string')) {
    throw new Error();
  }
  return state as unknown as AccessState;
}

export class AccessStore {
  readonly path: string;

  constructor(private readonly home: string, private readonly now = Date.now) {
    this.path = join(home, 'server-access.json');
  }

  private async read(): Promise<AccessState> {
    const content = await readOptional(this.path);
    if (content === null) {
      return { version: 1, pair: null, clients: [] };
    }
    try {
      return parseState(content);
    } catch {
      throw new Error('服务端授权文件格式无效，已有文件未被覆盖。');
    }
  }

  private async save(state: AccessState): Promise<void> {
    await writeAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }

  async instanceId(): Promise<string> {
    return await withLock(this.home, async () => {
      const state = await this.read();
      if (!state.id) { state.id = randomUUID(); await this.save(state); }
      return state.id;
    });
  }

  async check(): Promise<void> { return await withLock(this.home, () => this.checkUnlocked()); }
  async authorize(token: string): Promise<PairedClient | null> { return await withLock(this.home, () => this.authorizeUnlocked(token)); }
  async createPair() { return await withLock(this.home, () => this.createPairUnlocked()); }
  async redeem(code: string, name: string) { return await withLock(this.home, () => this.redeemUnlocked(code, name)); }
  async addClient(name: string) { return await withLock(this.home, () => this.addClientUnlocked(name)); }
  async list(): Promise<PairedClient[]> { return await withLock(this.home, () => this.listUnlocked()); }
  async revoke(id: string): Promise<PairedClient> { return await withLock(this.home, () => this.revokeUnlocked(id)); }

  private async checkUnlocked(): Promise<void> {
    await this.read();
  }

  private async authorizeUnlocked(token: string): Promise<PairedClient | null> {
    const hash = digest(token);
    const state = await this.read();
    const client = state.clients.find((entry) => secretsMatch(hash, entry.digest));
    if (client && (!client.lastSeenAt || this.now() - Date.parse(client.lastSeenAt) >= 60_000)) {
      client.lastSeenAt = new Date(this.now()).toISOString();
      await this.save(state);
    }
    return client ? { id: client.id, name: client.name, createdAt: client.createdAt, ...(client.lastSeenAt ? { lastSeenAt: client.lastSeenAt } : {}) } : null;
  }

  private async createPairUnlocked(): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + 5 * 60_000;
    await this.save({ ...await this.read(), pair: { digest: digest(code), expiresAt } });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private async redeemUnlocked(code: string, name: string): Promise<{ token: string; client: PairedClient }> {
    const state = await this.read();
    if (!state.pair || state.pair.expiresAt <= this.now() || !secretsMatch(digest(code), state.pair.digest)) {
      throw new Error('配对码无效、已过期或已使用，请在服务端重新生成。');
    }
    return await this.addClientUnlocked(name, { ...state, pair: null });
  }

  private async addClientUnlocked(name: string, current?: AccessState): Promise<{ token: string; client: PairedClient }> {
    const state = current ?? await this.read();
    const token = randomBytes(32).toString('base64url');
    const client: PairedClient = { id: randomUUID(), name, createdAt: new Date(this.now()).toISOString() };
    await this.save({ ...state, clients: [...state.clients, { ...client, digest: digest(token) }] });
    return { token, client };
  }

  private async listUnlocked(): Promise<PairedClient[]> {
    return (await this.read()).clients.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, ...(lastSeenAt ? { lastSeenAt } : {}) }));
  }

  private async revokeUnlocked(id: string): Promise<PairedClient> {
    const state = await this.read();
    const revoked = state.clients.find((client) => client.id === id);
    if (!revoked) {
      throw new Error('未找到该客户端。');
    }
    await this.save({ ...state, clients: state.clients.filter((client) => client.id !== id) });
    return { id: revoked.id, name: revoked.name, createdAt: revoked.createdAt };
  }
}
