import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from './auth.js';
import { readOptional, writeAtomic } from './files.js';
import { secretsMatch } from './local-codes.js';

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

function parseState(content: string): AccessState {
  const state: unknown = JSON.parse(content);
  if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.clients) ||
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

  constructor(home: string, private readonly now = Date.now) {
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

  async check(): Promise<void> {
    await this.read();
  }

  async authorize(token: string): Promise<PairedClient | null> {
    const hash = digest(token);
    const client = (await this.read()).clients.find((entry) => secretsMatch(hash, entry.digest));
    return client ? { id: client.id, name: client.name, createdAt: client.createdAt } : null;
  }

  async createPair(): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + 5 * 60_000;
    await this.save({ ...await this.read(), pair: { digest: digest(code), expiresAt } });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async redeem(code: string, name: string): Promise<{ token: string; client: PairedClient }> {
    const state = await this.read();
    if (!state.pair || state.pair.expiresAt <= this.now() || !secretsMatch(digest(code), state.pair.digest)) {
      throw new Error('配对码无效、已过期或已使用，请在服务端重新生成。');
    }
    return await this.addClient(name, { ...state, pair: null });
  }

  async addClient(name: string, current?: AccessState): Promise<{ token: string; client: PairedClient }> {
    const state = current ?? await this.read();
    const token = randomBytes(32).toString('base64url');
    const client: PairedClient = { id: randomUUID(), name, createdAt: new Date(this.now()).toISOString() };
    await this.save({ ...state, clients: [...state.clients, { ...client, digest: digest(token) }] });
    return { token, client };
  }

  async list(): Promise<PairedClient[]> {
    return (await this.read()).clients.map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  async revoke(id: string): Promise<void> {
    const state = await this.read();
    if (!state.clients.some((client) => client.id === id)) {
      throw new Error('未找到该客户端。');
    }
    await this.save({ ...state, clients: state.clients.filter((client) => client.id !== id) });
  }
}
