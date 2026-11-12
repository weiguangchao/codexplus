import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export async function temporaryHome(context: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-cs-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
