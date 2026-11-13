import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseServerCommand, serverUsage } from '../src/options.js';

test('服务端保留本机端口、目录和日志命令', () => {
  const home = join(homedir(), '.codexplus');
  assert.deepEqual(parseServerCommand([]), { kind: 'serve', home, port: 47831 });
  assert.deepEqual(parseServerCommand(['--port', '8443', '--home', '~/data']), { kind: 'serve', home: join(homedir(), 'data'), port: 8443 });
  assert.deepEqual(parseServerCommand(['log', '--home=./data']), { kind: 'admin', home: resolve('data'), action: 'log' });
  assert.deepEqual(parseServerCommand(['-h']), { kind: 'help' });
});

test('日志 --limit 只接受正整数，启动命令不接受', () => {
  assert.deepEqual(parseServerCommand(['log', '--limit', '2']), { kind: 'admin', home: join(homedir(), '.codexplus'), action: 'log', limit: 2 });
  for (const value of ['0', '-1', '1.5', 'abc']) assert.throws(() => parseServerCommand(['log', '--limit', value]));
  assert.throws(() => parseServerCommand(['--limit', '2']));
  assert.throws(() => parseServerCommand(['log', '--port', '5000']));
});

test('拒绝旧远程监听、TLS、配对、授权和无效参数', () => {
  for (const args of [
    ['--host', '0.0.0.0'], ['--host', '127.0.0.1'], ['--tls-cert', 'c.pem'], ['--tls-key', 'k.pem'],
    ['pair'], ['clients'], ['revoke', 'abc'], ['--port', '0'], ['--port', '65536'], ['--port', '12ab'],
    ['--server', 'https://a.example'], ['--local'], ['log', 'extra'], ['unknown'], ['serve'], ['--home', ''], ['--home'],
  ]) {
    assert.throws(() => parseServerCommand(args), Error, args.join(' '));
  }
});

test('帮助只列出本机服务端和日志用法', () => {
  assert.match(serverUsage, /^codexplus-server \[--port/u);
  assert.match(serverUsage, /codexplus-server log/u);
  assert.match(serverUsage, /仅监听 127\.0\.0\.1/u);
  assert.doesNotMatch(serverUsage, /--host|--tls|pair|clients|revoke|codexplus serve/u);
});
