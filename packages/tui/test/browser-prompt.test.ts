import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { browserLayout, browserLoginPrompt, renderBrowserLogin } from '../src/browser-prompt.js';
import { displayWidth } from '../src/ui.js';

const url = 'https://auth.openai.com/authorize?state=' + 'a'.repeat(550) + '&last=complete';
const view = { url, manual: true, cancelling: false, prefix: '◌', reading: false, scroll: 0 };

test('长登录链接不会挤掉状态与取消操作，完整链接逐页无损保留', () => {
  for (const columns of [24, 32, 40, 80]) for (const rows of [10, 12, 16, 24]) {
    for (const reading of [false, true]) {
      const state = { ...view, reading };
      const layout = browserLayout(state, columns, rows);
      const screen = stripVTControlCharacters(renderBrowserLogin(state, columns, rows));
      assert.ok(screen.split('\n').length < rows, `${columns}×${rows}: ${screen}`);
      assert.match(screen, /等待浏览器登录/u);
      assert.match(screen, reading ? /Esc 返回登录/u : /Esc 取消登录/u);
      for (const line of screen.split('\n')) assert.ok(displayWidth(line) < columns, line);
      if (!reading && layout.end > 0) {
        assert.equal(screen.match(/Ctrl\+O/gu)?.length, 1);
        assert.ok(!screen.includes('https://'));
        assert.match(screen, /链接较长/u);
      }
      if (reading) {
        const parts: string[] = [];
        for (let scroll = 0; scroll <= layout.end; scroll++) {
          const current = browserLayout({ ...state, scroll }, columns, rows);
          parts.push(scroll === 0 ? current.body.join('') : current.body.at(-1)!);
        }
        assert.equal(parts.join(''), url);
      }
    }
  }
});

test('浏览器等待可打开完整链接、跳到末尾、回到状态并取消，清理 resize 监听', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const listeners = process.stdout.listenerCount('resize');
  let screen = '';
  let cancelled = false;
  output.on('data', (chunk) => { screen += String(chunk); });
  const answer = browserLoginPrompt({ store: {
    browserLogin: async ({ signal, onUrl, onBrowserError }) => {
      onUrl(url);
      onBrowserError();
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
      });
    },
    cancelBrowserLogin: async () => {},
  } }, { input, output, clearPromptOnDone: true });
  const key = async (value: string) => { input.write(value); await new Promise<void>((resolve) => setImmediate(resolve)); };
  await key('\x1bOP');
  await key('\x1b[F');
  assert.ok(stripVTControlCharacters(screen).includes('last=complete'));
  await key('\n');
  await key('\x1b');
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(await answer, null);
  assert.equal(cancelled, true);
  assert.equal(process.stdout.listenerCount('resize'), listeners);
});
