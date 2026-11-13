import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestService } from '../src/protocol.js';

test('请求在发出网络访问前拒绝远程地址、TLS 和带凭据的地址', async (context) => {
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  for (const url of [
    'https://remote.example', 'http://192.168.1.5:47831', 'http://0.0.0.0:47831',
    'https://127.0.0.1:47831', 'http://localhost:47831', 'http://user:secret@127.0.0.1:47831',
    'http://127.0.0.1:47831/path', 'http://127.0.0.1:47831?token=secret', 'http://127.0.0.1:47831#fragment',
  ]) {
    await assert.rejects(requestService(url, '/v1/health'), /仅支持连接 127\.0\.0\.1/u);
  }
  await assert.rejects(requestService('http://127.0.0.1:47831', '@remote.example/'), /接口路径/u);
  assert.equal(request.mock.callCount(), 0);
});
