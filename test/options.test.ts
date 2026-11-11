import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseCommand } from '../src/options.js';

function parseHome(args: string[]): string {
  const command = parseCommand(args);
  assert.ok(command.kind === 'client');
  return command.home;
}

test('HOME 默认使用系统用户主目录下的 .codexplus', () => {
  assert.equal(parseHome([]), join(homedir(), '.codexplus'));
});

test('--home 支持绝对路径、相对路径、空格路径和 ~/，直接使用指定目录', () => {
  const absolute = join(homedir(), 'custom home');
  assert.equal(parseHome(['--home', absolute]), absolute);
  assert.equal(parseHome(['--home', '.codexplus']), resolve('.codexplus'));
  assert.equal(parseHome(['--home=./custom home']), resolve('custom home'));
  assert.equal(parseHome(['--home', '~/custom home']), join(homedir(), 'custom home'));
  assert.equal(parseHome(['--home', '~']), homedir());
});

test('后面的 --home 可以覆盖开发命令中预设的目录', () => {
  assert.equal(parseHome(['--home', '.codexplus', '--home', './other']), resolve('other'));
});

test('拒绝缺少或为空的 HOME 路径、未知选项和位置参数', () => {
  for (const args of [['--home'], ['--home='], ['--home', '   '], ['--unknown'], ['add']]) {
    assert.throws(() => parseHome(args));
  }
});

test('客户端默认使用已记住的服务端，--local / --port 指向本机，--server 指定远程服务端', () => {
  assert.deepEqual(parseCommand([]), { kind: 'client', home: join(homedir(), '.codexplus') });
  assert.deepEqual(parseCommand(['--local']), { kind: 'client', home: join(homedir(), '.codexplus'), target: 'http://127.0.0.1:47831' });
  assert.deepEqual(parseCommand(['--port', '5000', '--home', '~/c']), { kind: 'client', home: join(homedir(), 'c'), target: 'http://127.0.0.1:5000' });
  assert.deepEqual(parseCommand(['--server', 'https://vault.example/']), { kind: 'client', home: join(homedir(), '.codexplus'), target: 'https://vault.example' });
});

test('serve 启动服务端，默认固定端口，管理命令默认连接本机端口', () => {
  const home = join(homedir(), '.codexplus');
  assert.deepEqual(parseCommand(['serve']), { kind: 'serve', home, host: '127.0.0.1', port: 47831 });
  assert.deepEqual(parseCommand(['serve', '--host', '0.0.0.0', '--port', '8443', '--tls-cert', 'c.pem', '--tls-key', 'k.pem']),
    { kind: 'serve', home, host: '0.0.0.0', port: 8443, tlsCert: 'c.pem', tlsKey: 'k.pem' });
  assert.deepEqual(parseCommand(['serve', 'pair', '--port', '5000']), { kind: 'admin', home, url: 'http://127.0.0.1:5000', action: 'pair' });
  assert.deepEqual(parseCommand(['serve', 'revoke', 'abc', '--server', 'https://localhost:8443']),
    { kind: 'admin', home, url: 'https://localhost:8443', action: 'revoke', id: 'abc' });
  assert.deepEqual(parseCommand(['-h']), { kind: 'help' });
});

test('拒绝冲突、无效或不适用于该命令的参数', () => {
  for (const args of [
    ['--server', 'https://a.example', '--local'], ['--server', 'https://a.example', '--port', '1'], ['--server', 'http://192.168.1.5'],
    ['--port', '0'], ['--port', '65536'], ['--port', '12ab'], ['--host', '0.0.0.0'], ['add'], ['serve', '--server', 'https://a.example'],
    ['serve', '--local'], ['serve', '--tls-cert', 'c.pem'], ['serve', 'revoke'], ['serve', 'pair', 'extra'], ['serve', 'clients', '--host', 'x'],
    ['serve', 'pair', '--server', 'https://remote.example'], ['serve', 'unknown'], ['--home', ''],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(' '));
  }
});
