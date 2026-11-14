import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
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
  const server = await startServer({ home, userHome: home, codexHome: join(home, '.codex'), port, accountRequest });
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
