import { parseServiceHealth, parseCredentialSnapshots, parseEmail, requestService } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { standalone, temporaryHome } from './helpers.js';

test('同目录双服务端并发上传保留索引，慢查询不阻塞健康接口', async (context) => {
  const home = await temporaryHome(context);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const first = await standalone({ context, home, port: 0, accountRequest: async () => { entered(); await gate; return Response.json({ email: parseEmail('one@example.com') }); } });
  const second = await standalone({ context, home, port: 0, accountRequest: async () => Response.json({ email: parseEmail('two@example.com') }) });

  const upload = requestService({ url: first.url, method: 'credentials.upload', params: { auth: { tokens: { access_token: 'one' } }, base: null } });
  await started;
  try {
    const health = await requestService({ url: first.url, method: 'health', params: undefined, sessionToken: undefined, timeoutMs: 1_000 });
    assert.equal((parseServiceHealth(health)).service, 'codexplus');
    await requestService({ url: second.url, method: 'credentials.upload', params: { auth: { tokens: { access_token: 'two' } }, base: null } });
  } finally { release(); }
  await upload;
  const result = parseCredentialSnapshots(await requestService({ url: first.url, method: 'credentials.list' }));
  assert.equal(result.length, 2);
});
