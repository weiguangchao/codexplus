import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { CredentialClient } from '../src/client.js';
import { requestLocalProof } from '../src/local-codes.js';
import { requestService } from '../src/protocol.js';
import { startServer } from '../src/server.js';

export const original = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', extra: 'discard' }, extra: 'discard' };
export const filtered = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh' } };
export const account: typeof fetch = async () => Response.json({ email: 'person@example.com' });

export async function temporaryHome(context: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-cs-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('无法分配端口。');
  }
  return address.port;
}

export async function standalone(context: TestContext, home: string, port = 0, accountRequest = account) {
  const server = await startServer({ home, port, accountRequest });
  let open = true;
  context.after(async () => {
    if (open) {
      open = false;
      await server.close();
    }
  });
  return {
    url: server.url,
    async close() {
      open = false;
      await server.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

export function makeClient(context: TestContext, userHome: string, home = join(userHome, '.codexplus')) {
  const started: string[] = [];
  const client = new CredentialClient({
    home,
    userHome,
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
      return { async close() { if (open) { open = false; await server.close(); } } };
    },
  });
  return { client, started };
}

export async function admin(url: string, home: string, action: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const proof = await requestLocalProof(url, home, 'admin');
  if (proof === null) {
    throw new Error('无法读取本机验证文件。');
  }
  return await requestService(url, `/v1/admin/${action}`, undefined, { proof, ...body });
}

export async function pairCode(url: string, home: string): Promise<string> {
  return (await admin(url, home, 'pair') as { code: string }).code;
}
