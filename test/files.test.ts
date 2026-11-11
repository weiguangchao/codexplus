import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandPath } from '../src/files.js';

test('路径支持去掉外层引号和反斜杠转义的空格', () => {
  const home = join(tmpdir(), 'home');
  assert.equal(expandPath(home, "'~/a b.json'"), join(home, 'a b.json'));
  assert.equal(expandPath(home, ' "~/a b.json" '), join(home, 'a b.json'));
  assert.equal(expandPath(home, '~'), home);
  if (process.platform !== 'win32') {
    assert.equal(expandPath(home, '~/a\\ b.json'), join(home, 'a b.json'));
  }
});
