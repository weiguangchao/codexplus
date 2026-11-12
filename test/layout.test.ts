import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { pathWindow } from '../src/path-input.js';
import { displayWidth, fitPath, line as renderLine, pathLabel, wrapWords } from '../src/ui.js';

test('长路径保留首尾，文件名可容纳时完整显示，兼容中文和 Windows 分隔符', () => {
  for (const path of ['/tmp/a/very/long/directory/auth.json', 'C:\\Users\\someone\\a-long-directory\\auth.json', '/目录/很长的目录/另一个目录/auth.json']) {
    for (const columns of [12, 24, 38, 60]) {
      const shown = fitPath(path, columns);
      assert.ok(displayWidth(shown) <= columns, shown);
      assert.ok(shown.endsWith('auth.json'));
      assert.ok(shown.startsWith(path[0]!));
      assert.equal(shown.includes('…'), displayWidth(path) > columns);
    }
  }
  assert.equal(fitPath('/short/auth.json', 40), '/short/auth.json');
  const filename = fitPath('auth-json-with-an-extremely-long-name.json', 20);
  assert.ok(filename.startsWith('auth'));
  assert.ok(filename.endsWith('.json'));
});

test('目录单独一行，长文件名明确省略，每行不超出终端显示宽度', () => {
  const shown = pathLabel('数据目录', '/tmp/codexplus/a/very/long/directory/with/another/component', 40);
  assert.ok(shown.startsWith('数据目录\n'));
  assert.ok(shown.includes('…'));
  for (const line of shown.split('\n')) assert.ok(displayWidth(line) <= 40);
  assert.equal(pathLabel('登录文件', '~/auth.json', 40), '登录文件  ~/auth.json');
});

test('中文在词边界分行，退出和英文单词保持完整，标点不单独落到下一行', () => {
  const source = '可能影响这些会话的后续请求，建议先退出 Codex。';
  for (const columns of [16, 24, 38, 98]) {
    const shown = wrapWords(source, columns);
    assert.equal(shown.replaceAll('\n', '').replaceAll(' ', ''), source.replaceAll(' ', ''));
    assert.doesNotMatch(shown, /退\n出|Co\ndex|Cod\nex/u);
    for (const line of shown.split('\n')) {
      assert.ok(displayWidth(line) <= columns);
      assert.doesNotMatch(line, /^[，。；：！？]/u);
    }
  }
});

test('路径输入窗口按光标滚动，首中尾及中文光标均留在单行内', () => {
  const value = '/tmp/含有中文和空格的目录/another long directory/auth.json';
  for (const columns of [16, 32, 40, 60, 100]) {
    for (const cursor of [0, 5, 20, Array.from(value).length]) {
      const view = pathWindow(value, cursor, columns);
      assert.ok(displayWidth(view.text) < columns);
      assert.ok(displayWidth(view.text.slice(0, view.cursor)) < columns);
      assert.ok(view.cursor >= 0 && view.cursor <= view.text.length);
      if (displayWidth(value) < columns) assert.equal(view.text, value);
      if (cursor === 0) assert.ok(view.text.startsWith('/tmp/'));
      if (cursor === Array.from(value).length) assert.ok(view.text.endsWith('auth.json'));
    }
  }
});

test('普通详情换行保留完整配对命令，不按路径省略', () => {
  const previous = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
  try {
    const detail = '请在服务端运行 codexplus serve pair 获取配对码';
    const shown = stripVTControlCharacters(renderLine('i', '需要配对', detail));
    assert.ok(shown.includes('codexplus serve pair'));
    assert.ok(shown.replaceAll(/\s/gu, '').includes(detail.replaceAll(/\s/gu, '')));
    assert.ok(!shown.includes('…'));
  } finally {
    if (previous) Object.defineProperty(process.stdout, 'columns', previous);
    else Reflect.deleteProperty(process.stdout, 'columns');
  }
});

test('含 emoji 的路径窗口宽度与 readline 相符，光标不进入下一行', () => {
  const value = '/tmp/工作📁/backup credentials/auth.json';
  const output = Object.assign(new PassThrough(), { columns: 40 });
  const rl = createInterface({ input: new PassThrough(), output, terminal: true });
  try {
    const view = pathWindow(value, Array.from(value).length, 40);
    rl.setPrompt('');
    rl.write(view.text);
    const cursor = rl.getCursorPos();
    assert.equal(cursor.rows, 0);
    assert.equal(cursor.cols, displayWidth(view.text));
    assert.ok(displayWidth(view.text) < 40);
  } finally { rl.close(); }
});
