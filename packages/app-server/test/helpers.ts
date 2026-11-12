import { createServer } from 'node:net';
import type { TestContext } from 'node:test';
import { AccessStore } from '../src/access.js';
import { startServer } from '../src/server.js';

export { temporaryHome } from '../../shared/test/helpers.js';

export const account: typeof fetch = async () => Response.json({ email: 'person@example.com' });

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

export async function admin(_url: string, home: string, action: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const store = new AccessStore(home);
  if (action === 'pair') return await store.createPair();
  if (action === 'clients') return { clients: await store.list() };
  await store.revoke(String(body.id));
  return { ok: true };
}

export async function pairCode(_url: string, home: string): Promise<string> {
  return (await new AccessStore(home).createPair()).code;
}
