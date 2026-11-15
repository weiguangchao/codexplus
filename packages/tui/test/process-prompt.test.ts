import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { runningCodexConfig } from '../src/process-prompt.js';
import { confirmRunningCodex } from '../src/switch.js';
import { renderSelect, selectLayout } from '../src/select-layout.js';
import { displayWidth } from '../src/text-layout.js';

test('进程确认把 PID、完整路径和警告交给同一个界面和详情，默认取消', async () => {
  const authPath = '/tmp/synthetic/' + 'long-directory/'.repeat(12) + 'auth.json';
  const logged: string[] = [];
  const result = await confirmRunningCodex({ authPath,
    findProcesses: async () => [{ pid: 4401, command: 'codex' }, { pid: 4402, command: 'Codex' }, { pid: 4403, command: 'codex app-server' }],
    log: (message) => logged.push(message),
    ask: async (options) => {
      assert.equal(logged.length, 0);
      assert.equal(options.default, false);
      assert.ok(options.detail.includes(authPath));
      const config = runningCodexConfig(options);
      for (const columns of [24, 30, 40, 60, 80]) for (const rows of [8, 10, 12, 14, 16, 24]) {
        const state = { active: 0, query: '', error: '' };
        const layout = selectLayout(config, state, columns, rows);
        assert.equal(layout.page.length, 3);
        const text = stripVTControlCharacters(renderSelect(config, state, columns, rows));
        assert.ok(text.split('\n').length < rows, `${columns}×${rows}\n${text}`);
        for (const line of text.split('\n')) assert.ok(displayWidth(line) < columns, line);
        assert.ok(text.includes('取消') && text.includes('仍然切换'));
        const full = layout.fullText.join('\n');
        for (const value of ['4401', '4402', '4403', '建议先退出', '可能影响']) assert.ok(full.includes(value));
        assert.ok(full.replaceAll(/\s/gu, '').includes(authPath));
      }
      return false;
    },
  });
  assert.equal(result, false);
  assert.match(logged[0]!, /已取消切换/u);
});

test('更新登录的进程确认只提供取消和更新，更新选项保持危险标记', () => {
  const config = runningCodexConfig({ action: 'update', message: '仍要更新本机登录吗？', detail: 'PID 4501 codex', count: 1, default: false });
  const choices = config.choices.filter((item) => 'value' in item);
  assert.deepEqual(choices.map(({ value }) => value), [false, true]);
  assert.equal(choices[1]!.tone, 'danger');
  assert.ok(String(config.message).includes('更新本机登录'));
});
