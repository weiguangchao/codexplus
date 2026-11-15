import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestService } from '@weiguangchao/codexplus-shared';
import { standalone, temporaryHome } from './helpers.js';

test('同目录双服务端并发上传保留索引，慢查询不阻塞健康接口', async (context) => {
  const home = await temporaryHome(context);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = await standalone(context, home, 0, async () => { entered(); await gate; return Response.json({ email: 'one@example.com' }); });
  const second = await standalone(context, home, 0, async () => Response.json({ email: 'two@example.com' }));

  const upload = requestService(first.url, 'credentials.upload', { auth: { tokens: { access_token: 'one' } }, base: null });
  await started;
  try {
    const health = await requestService(first.url, 'health', undefined, undefined, 1_000);
    assert.equal((health as { service: string }).service, 'codexplus');
    await requestService(second.url, 'credentials.upload', { auth: { tokens: { access_token: 'two' } }, base: null });
  } finally { release(); }
  await upload;
  const result = await requestService(first.url, 'credentials.list') as { credentials: unknown[] };
  assert.equal(result.credentials.length, 2);
});
