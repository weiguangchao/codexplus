import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseHome } from '../src/options.js';

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
