import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from './auth.js';
import { readOptional, writeAtomic } from './files.js';

export interface PairedClient {
  id: string;
  name: string;
  createdAt: string;
}

interface AccessState {
  version: 1;
  pair: { digest: string; expiresAt: number } | null;
  clients: (PairedClient & { digest: string })[];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matches(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function localKeyPath(home: string): string {
  return join(home, 'server-key');
}

export class AccessStore {
  private state: AccessState = { version: 1, pair: null, clients: [] };
  private key = '';
  readonly path: string;

  constructor(private readonly home: string, private readonly now = Date.now) {
    this.path = join(home, 'server-access.json');
  }

  async initialize(): Promise<void> {
    const content = await readOptional(this.path);
    if (content !== null) {
      try {
        const state: unknown = JSON.parse(content);
        if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.clients) ||
          !(state.pair === null || (isRecord(state.pair) && typeof state.pair.digest === 'string' &&
            typeof state.pair.expiresAt === 'number')) ||
          !state.clients.every((client: unknown) => isRecord(client) && typeof client.id === 'string' &&
            typeof client.name === 'string' && typeof client.createdAt === 'string' && typeof client.digest === 'string')) {
          throw new Error();
        }
        this.state = state as unknown as AccessState;
      } catch {
        throw new Error('服务端授权文件格式无效，已有文件未被覆盖。');
      }
    }
    const key = await readOptional(localKeyPath(this.home));
    if (key !== null && !/^[A-Za-z0-9_-]{43}$/u.test(key)) {
      throw new Error('服务端本地认证文件格式无效，已有文件未被覆盖。');
    }
    this.key = key ?? randomBytes(32).toString('base64url');
    if (key === null) {
      await writeAtomic(localKeyPath(this.home), this.key);
    }
  }

  private async save(state: AccessState): Promise<void> {
    await writeAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
    this.state = state;
  }

  authorize(token: string, loopback: boolean): 'local' | 'client' | null {
    if (loopback && matches(token, this.key)) {
      return 'local';
    }
    const hash = digest(token);
    return this.state.clients.some((client) => matches(hash, client.digest)) ? 'client' : null;
  }

  async createPair(): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + 5 * 60_000;
    await this.save({ ...this.state, pair: { digest: digest(code), expiresAt } });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async redeem(code: string, name: string): Promise<{ token: string; client: PairedClient }> {
    if (!this.state.pair || this.state.pair.expiresAt <= this.now() || !matches(digest(code), this.state.pair.digest)) {
      throw new Error('配对码无效、已过期或已使用，请在服务端重新生成。');
    }
    const token = randomBytes(32).toString('base64url');
    const client: PairedClient = { id: randomUUID(), name, createdAt: new Date(this.now()).toISOString() };
    await this.save({ version: 1, pair: null, clients: [...this.state.clients, { ...client, digest: digest(token) }] });
    return { token, client };
  }

  list(): PairedClient[] {
    return this.state.clients.map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  async revoke(id: string): Promise<void> {
    if (!this.state.clients.some((client) => client.id === id)) {
      throw new Error('未找到该客户端。');
    }
    await this.save({ ...this.state, clients: this.state.clients.filter((client) => client.id !== id) });
  }
}
