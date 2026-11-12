import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseServerCommand, serverUsage } from '../src/options.js';

test('不带子命令时启动服务端，默认固定端口，管理命令只接受 --home', () => {
  const home = join(homedir(), '.codexplus');
  assert.deepEqual(parseServerCommand([]), { kind: 'serve', home, host: '127.0.0.1', port: 47831 });
  assert.deepEqual(parseServerCommand(['--host', '0.0.0.0', '--port', '8443', '--tls-cert', 'c.pem', '--tls-key', 'k.pem']),
    { kind: 'serve', home, host: '0.0.0.0', port: 8443, tlsCert: 'c.pem', tlsKey: 'k.pem' });
  assert.deepEqual(parseServerCommand(['pair']), { kind: 'admin', home, action: 'pair' });
  assert.deepEqual(parseServerCommand(['revoke', 'abc', '--home', '~/data']), { kind: 'admin', home: join(homedir(), 'data'), action: 'revoke', id: 'abc' });
  assert.deepEqual(parseServerCommand(['clients', '--home=./data']), { kind: 'admin', home: resolve('data'), action: 'clients' });
  assert.throws(() => parseServerCommand(['pair', '--port', '5000']), /--port 不能用于此命令，请运行 codexplus-server --help/u);
  assert.deepEqual(parseServerCommand(['-h']), { kind: 'help' });
});

test('log 的 --limit 只接受正整数，其他管理命令不接受', () => {
  assert.deepEqual(parseServerCommand(['log', '--limit', '2']), { kind: 'admin', home: join(homedir(), '.codexplus'), action: 'log', limit: 2 });
  for (const value of ['0', '-1', '1.5', 'abc']) assert.throws(() => parseServerCommand(['log', '--limit', value]));
  assert.throws(() => parseServerCommand(['pair', '--limit', '2']));
});

test('拒绝无效、冲突或属于客户端的参数', () => {
  for (const args of [
    ['--port', '0'], ['--port', '65536'], ['--port', '12ab'], ['--server', 'https://a.example'], ['--local'], ['--tls-cert', 'c.pem'],
    ['revoke'], ['pair', 'extra'], ['clients', '--host', 'x'], ['pair', '--server', 'https://remote.example'], ['unknown'], ['serve'],
    ['--home', ''], ['--home'],
  ]) {
    assert.throws(() => parseServerCommand(args), Error, args.join(' '));
  }
});

test('帮助只列出 codexplus-server 的用法', () => {
  assert.match(serverUsage, /^codexplus-server \[--host/u);
  assert.match(serverUsage, /codexplus-server pair\|clients\|revoke <客户端ID>\|log/u);
  assert.doesNotMatch(serverUsage, /codexplus serve/u);
});
