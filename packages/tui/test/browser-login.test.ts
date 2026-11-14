import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '@codexplus/app-server';
import { requestService, writeAtomic } from '@codexplus/shared';
import { CredentialClient } from '../src/client.js';
import { loginState, temporaryHome } from './helpers.js';

test('浏览器凭证保留在服务端，TUI 使用登录标识保存、确认冲突和重试', async (context) => {
  const root = await temporaryHome(context);
  let unavailable = false;
  const server = await startServer({ home: root, userHome: root, codexHome: join(root, 'codex'), port: 0,
    accountRequest: async () => unavailable ? new Response('', { status: 503 }) : Response.json({ email: 'person@example.com' }),
    login: async ({ onUrl, onBrowserError } = {}) => {
      onUrl?.('https://auth.openai.com/fixture');
      onBrowserError?.();
      return JSON.stringify({ tokens: { access_token: 'browser-secret', refresh_token: 'refresh-secret' } });
    },
  });
  context.after(() => server.close());
  const session = await new CredentialClient().connect({ port: Number(new URL(server.url).port) });
  await writeAtomic(join(root, 'source.json'), '{"tokens":{"access_token":"original-secret"}}');
  const { credential } = await session.add(join(root, 'source.json'));
  await session.switch(credential);
  const current = await readFile(session.codexAuthPath, 'utf8');
  const baseline = (await loginState(root)).baseline;
  const replies: string[] = [];
  const fetchService = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await fetchService(...args);
    replies.push(await response.clone().text());
    assert.doesNotMatch(String(args[1]?.body ?? ''), /browser-secret|refresh-secret|access_token/u);
    return response;
  });
  const urls: string[] = [];
  let manual = false;
  const id = await session.browserLogin({ signal: new AbortController().signal, onUrl: (url) => urls.push(url), onBrowserError: () => { manual = true; } });
  assert.deepEqual(urls, ['https://auth.openai.com/fixture']);
  assert.ok(manual);
  await assert.rejects(requestService(server.url, '/v1/login/browser/start', {}), /已有浏览器登录/u);
  let confirmations = 0;
  session.confirmUpload = async () => { confirmations++; return false; };
  await assert.rejects(session.saveBrowserLogin(id), /已取消/u);
  unavailable = true;
  await assert.rejects(session.saveBrowserLogin(id), /HTTP 503/u);
  unavailable = false;
  session.confirmUpload = async () => { confirmations++; return true; };
  assert.equal((await session.saveBrowserLogin(id)).changed, true);
  assert.equal(confirmations, 2);
  assert.equal(await readFile(session.codexAuthPath, 'utf8'), current);
  assert.deepEqual((await loginState(root)).baseline, baseline);
  assert.ok(replies.every((reply) => !/browser-secret|refresh-secret|access_token|refresh_token/u.test(reply)));
  await session.cancelBrowserLogin(id);
  await assert.rejects(session.saveBrowserLogin(id), /已结束/u);
});

test('TUI 取消浏览器等待时通知服务端清理，可立即重新登录，关闭服务端也会取消', async (context) => {
  const root = await temporaryHome(context);
  let cancelled = 0;
  const server = await startServer({ home: root, userHome: root, port: 0,
    login: async ({ signal, onUrl } = {}) => {
      onUrl?.('https://auth.openai.com/fixture');
      return await new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { cancelled++; reject(signal!.reason); }, { once: true });
      });
    },
  });
  let closed = false;
  context.after(async () => { if (!closed) await server.close(); });
  const session = await new CredentialClient().connect({ port: Number(new URL(server.url).port) });
  const controller = new AbortController();
  await assert.rejects(session.browserLogin({ signal: controller.signal, onUrl: () => controller.abort(new Error('cancelled')), onBrowserError: () => {} }), /aborted|cancelled/u);
  assert.equal(cancelled, 1);
  const started = await requestService(server.url, '/v1/login/browser/start', {}) as { id: string };
  assert.ok(started.id);
  await server.close();
  closed = true;
  assert.equal(cancelled, 2);
});
