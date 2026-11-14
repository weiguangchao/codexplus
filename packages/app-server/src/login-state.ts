import { join } from 'node:path';
import { isRecord, readOptional, ServiceError, withLock, writeAtomic } from '@weiguangchao/codexplus-shared';

interface State {
  version: 1;
  authPath: string;
  baseline: { email: string; digest: string } | null;
  deleted: Record<string, string | null>;
}

export class LoginState {
  constructor(private readonly home: string, private readonly authPath: string) {}

  private async read(): Promise<State> {
    const path = join(this.home, 'login.json');
    const content = await readOptional(path);
    const empty: State = { version: 1, authPath: this.authPath, baseline: null, deleted: {} };
    if (content === null) {
      const legacyPath = join(this.home, 'client.json');
      const legacy = await readOptional(legacyPath);
      if (legacy === null) return empty;
      try {
        const value: unknown = JSON.parse(legacy);
        if (!isRecord(value) || ![1, 2, 3, 4].some((version) => value.version === version)) throw new Error();
        if ((value.version === 1 || value.version === 2) && (typeof value.current !== 'string' || !isRecord(value.servers))) throw new Error();
        if (isRecord(value.baseline) && value.baseline.server === 'local' && typeof value.baseline.email === 'string' && typeof value.baseline.digest === 'string') {
          empty.baseline = { email: value.baseline.email, digest: value.baseline.digest };
        }
      } catch { throw new ServiceError(400, `${legacyPath} 格式无效，请修复或删除该文件；已有文件未被覆盖。`); }
      await writeAtomic(path, `${JSON.stringify(empty, null, 2)}\n`);
      await writeAtomic(legacyPath, `${JSON.stringify({ version: 4 })}\n`);
      return empty;
    }
    try {
      const value: unknown = JSON.parse(content);
      if (!isRecord(value) || value.version !== 1 || typeof value.authPath !== 'string' || !isRecord(value.deleted) ||
        value.baseline !== null && (!isRecord(value.baseline) || typeof value.baseline.email !== 'string' || typeof value.baseline.digest !== 'string') ||
        !Object.values(value.deleted).every((digest) => digest === null || typeof digest === 'string')) throw new Error();
      return value.authPath === this.authPath ? value as unknown as State : empty;
    } catch { throw new ServiceError(400, `${path} 格式无效，请修复或删除该文件；已有文件未被覆盖。`); }
  }

  async get(): Promise<State> { return await withLock(this.home, () => this.read()); }

  async update(change: (state: State) => void | Promise<void>): Promise<void> {
    await withLock(this.home, async () => {
      const state = await this.read();
      await change(state);
      await writeAtomic(join(this.home, 'login.json'), `${JSON.stringify(state, null, 2)}\n`);
    });
  }
}
