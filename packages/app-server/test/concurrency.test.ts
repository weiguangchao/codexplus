import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestService } from '@codexplus/shared';
import { standalone, temporaryHome } from './helpers.js';

test('同目录双服务端并发上传保留索引，慢查询不阻塞健康接口', async (context) => {
  const home = await temporaryHome(context);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = await standalone(context, home, 0, async () => { entered(); await gate; return Response.json({ email: 'one@example.com' }); });
  const second = await standalone(context, home, 0, async () => Response.json({ email: 'two@example.com' }));

  const upload = requestService(first.url, '/v1/credentials', { auth: { tokens: { access_token: 'one' } }, base: null });
  await started;
  try {
    const health = await fetch(`${first.url}/v1/health`, { signal: AbortSignal.timeout(1_000) });
    assert.equal(health.status, 200);
    await requestService(second.url, '/v1/credentials', { auth: { tokens: { access_token: 'two' } }, base: null });
  } finally { release(); }
  await upload;
  const result = await requestService(first.url, '/v1/credentials') as { credentials: unknown[] };
  assert.equal(result.credentials.length, 2);
});
