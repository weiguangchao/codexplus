import { z } from 'zod';
import { join } from 'node:path';
import { isRecord, authDigestSchema, loginBaselineSchema, parseEmail, readOptional, ServiceError, withLock, writeAtomic } from '@weiguangchao/codexplus-shared';

const stateSchema = z.object({
  version: z.literal(1),
  authPath: z.string(),
  baseline: loginBaselineSchema,
  deleted: z.record(z.string(), authDigestSchema.nullable()).transform((value) =>
    new Map(Object.entries(value).map(([email, digest]) => [parseEmail(email), digest]))),
});

type State = z.infer<typeof stateSchema>;

function serialize(state: State): string {
  return `${JSON.stringify({ ...state, deleted: Object.fromEntries(state.deleted) }, null, 2)}\n`;
}

export class LoginState {
  private readonly home: string;
  private readonly authPath: string;
  constructor({ home, authPath }: { home: string; authPath: string }) {
    this.home = home;
    this.authPath = authPath;
  }

  private async read(): Promise<State> {
    const path = join(this.home, 'login.json');
    const content = await readOptional(path);
    const empty: State = { version: 1, authPath: this.authPath, baseline: null, deleted: new Map() };
    if (content === null) {
      const legacyPath = join(this.home, 'client.json');
      const legacy = await readOptional(legacyPath);
      if (legacy === null) return empty;
      try {
        const value: unknown = JSON.parse(legacy);
        if (!isRecord(value) || ![1, 2, 3, 4].some((version) => value.version === version)) throw new Error();
        if ((value.version === 1 || value.version === 2) && (typeof value.current !== 'string' || !isRecord(value.servers))) throw new Error();
        if (isRecord(value.baseline) && value.baseline.server === 'local' && typeof value.baseline.email === 'string' && typeof value.baseline.digest === 'string') {
          empty.baseline = stateSchema.shape.baseline.parse(value.baseline);
        }
      } catch { throw new ServiceError({ status: 400, message: `${legacyPath} 格式无效，请修复或删除该文件；已有文件未被覆盖。` }); }
      await writeAtomic({ path, content: serialize(empty) });
      await writeAtomic({ path: legacyPath, content: `${JSON.stringify({ version: 4 })}\n` });
      return empty;
    }
    try {
      const value: unknown = JSON.parse(content);
      const state = stateSchema.parse(value);
      return state.authPath === this.authPath ? state : empty;
    } catch { throw new ServiceError({ status: 400, message: `${path} 格式无效，请修复或删除该文件；已有文件未被覆盖。` }); }
  }

  async get(): Promise<State> { return await withLock({ home: this.home, fn: () => this.read() }); }

  async update(change: (state: State) => void | Promise<void>): Promise<void> {
    await withLock({ home: this.home, fn: async () => {
      const state = await this.read();
      await change(state);
      await writeAtomic({ path: join(this.home, 'login.json'), content: serialize(state) });
    } });
  }
}
