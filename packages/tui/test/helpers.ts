import { join } from 'node:path';
import { readOptional } from '@codexplus/shared';
import type { TestContext } from 'node:test';
import { startServer } from '@codexplus/app-server';
import { CredentialClient } from '../src/client.js';
import { account } from '../../app-server/test/helpers.js';

export { account, standalone, temporaryHome } from '../../app-server/test/helpers.js';

export const original = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', extra: 'discard' }, extra: 'discard' };
export const filtered = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh' } };

export function makeClient(context: TestContext, userHome: string, home = join(userHome, '.codexplus')) {
  const started: string[] = [];
  const client = new CredentialClient({
    home,
    userHome,
    codexHome: join(userHome, '.codex'),
    startLocal: async (options) => {
      const server = await startServer({ ...options, accountRequest: account });
      started.push(server.url);
      let open = true;
      context.after(async () => {
        if (open) {
          open = false;
          await server.close();
        }
      });
      return { url: server.url, async close() { if (open) { open = false; await server.close(); } } };
    },
  });
  return { client, started };
}

export async function loginState(home: string): Promise<{ baseline: { email: string; digest: string } | null }> {
  return JSON.parse(await readOptional(join(home, 'login.json')) ?? '{"baseline":null}');
}
