import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand } from '../src/options.js';

test('不带参数时打开 TUI，--help 和 -h 显示帮助', () => {
  assert.deepEqual(parseCommand([]), { kind: 'client' });
  for (const flag of ['--help', '-h']) {
    assert.deepEqual(parseCommand([flag]), { kind: 'help' });
  }
});

test('拒绝旧子命令、目录和端口参数，以及其他未知参数', () => {
  for (const args of [
    ['status'], ['list'], ['switch'], ['switch', 'person@example.com'], ['serve'],
    ['--home', './data'], ['--home=./data'], ['--port', '47831'], ['--port=47831'],
    ['--server', 'http://127.0.0.1:47831'], ['--local'], ['--version'], ['-v'],
    ['--help', 'status'], ['status', '-h'], ['--', 'list'],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(' '));
  }
});
