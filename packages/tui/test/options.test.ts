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

test('客户端默认使用已记住的服务端，--local 指向本机，--server 指定远程服务端，不接受 --port', () => {
  assert.deepEqual(parseCommand([]), { kind: 'client', home: join(homedir(), '.codexplus') });
  assert.deepEqual(parseCommand(['--local']), { kind: 'client', home: join(homedir(), '.codexplus'), target: 'local' });
  assert.throws(() => parseCommand(['--port', '5000']), /--port 不能用于此命令，请运行 codexplus --help/u);
  assert.deepEqual(parseCommand(['--server', 'https://vault.example/']), { kind: 'client', home: join(homedir(), '.codexplus'), target: 'https://vault.example' });
  assert.deepEqual(parseCommand(['-h']), { kind: 'help' });
});

test('status、list 和 switch 接受公共参数，switch 可以指定邮箱', () => {
  const home = join(homedir(), '.codexplus');
  for (const kind of ['status', 'list', 'switch']) {
    assert.deepEqual(parseCommand([kind]), { kind, home });
    assert.deepEqual(parseCommand(['--local', kind, '--home', './data']), { kind, home: resolve('data'), target: 'local' });
    assert.deepEqual(parseCommand([kind, '--server', 'https://vault.example']), { kind, home, target: 'https://vault.example' });
    assert.deepEqual(parseCommand([kind, '--help']), { kind: 'help' });
  }
  assert.deepEqual(parseCommand(['switch', 'person@example.com']), { kind: 'switch', home, email: 'person@example.com' });
  for (const args of [['status', 'extra'], ['list', 'extra'], ['switch', 'a@example.com', 'b@example.com'], ['switch', ''], ['add']]) {
    assert.throws(() => parseCommand(args));
  }
});

test('serve 已移到 codexplus-server，提示改用新命令', () => {
  for (const args of [['serve'], ['serve', 'pair'], ['serve', '--port', '8443']]) {
    assert.throws(() => parseCommand(args), /codexplus-server/u, args.join(' '));
  }
});

test('拒绝冲突、无效或不适用于该命令的参数', () => {
  for (const args of [
    ['--server', 'https://a.example', '--local'], ['--server', 'https://a.example', '--port', '1'], ['--server', 'http://192.168.1.5'],
    ['--port', '0'], ['--host', '0.0.0.0'], ['--tls-cert', 'c.pem'], ['--limit', '2'], ['add'], ['pair'], ['--home', ''],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(' '));
  }
});
