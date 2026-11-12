import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { CredentialClient } from '../src/client.js';
import { temporaryHome } from './helpers.js';

test('服务名、版本或实例不匹配时不发送令牌', async (context) => {
  const userHome = await temporaryHome(context);
  let health = { service: 'other', version: 2, id: 'new' };
  const tokens: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization) tokens.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(health));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const client = new CredentialClient({ userHome });
  await mkdir(client.home);
  await writeFile(client.configPath, JSON.stringify({ version: 2, current: url, servers: { [url]: { token: 'a'.repeat(43), clientId: 'old', serverId: 'old' } }, baseline: null }));
  await assert.rejects(client.connect(), /不是 codexplus/u);
  health = { service: 'codexplus', version: 1, id: 'new' };
  await assert.rejects(client.connect(), /版本不兼容/u);
  health.version = 2;
  await assert.rejects(client.connect(), /不是之前配对/u);
  assert.deepEqual(tokens, []);
});
