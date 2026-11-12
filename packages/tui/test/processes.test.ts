import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCodexProcesses } from '../src/processes.js';

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform} 检测可执行文件名，支持空格路径，不误判 codexplus 和辅助进程`, async () => {
    const processes = await findCodexProcesses(platform, async (command, args) => {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-A', '-o', 'pid=', '-o', 'comm=']);
      return [
        '  4103 /Users/person/Codex Tools/bin/codex',
        '  4101 codex',
        '  4102 /Applications/Codex.app/Contents/MacOS/Codex',
        '  4104 /usr/local/bin/codexplus',
        '  4105 codex-code-mode-host',
        '  4106 node',
        '  4107 /Users/person/codex-project/node',
        '  4108 ps',
        `  ${process.pid} codex`,
        '',
      ].join('\n');
    });
    assert.deepEqual(processes, [
      { pid: 4101, command: 'codex' },
      { pid: 4102, command: 'Codex' },
      { pid: 4103, command: 'codex' },
    ].filter(({ pid }) => pid !== process.pid));
  });
}

test('Windows 解析 tasklist 的 CSV 输出，大小写不影响匹配', async () => {
  const processes = await findCodexProcesses('win32', async (command, args) => {
    assert.equal(command, 'tasklist.exe');
    assert.deepEqual(args, ['/FI', 'IMAGENAME eq codex.exe', '/FO', 'CSV', '/NH']);
    return [
      '"codex.exe","4201","Console","1","20,000 K"',
      '"Codex.exe","4202","控制台","1","30,000 K"',
      '"codexplus.exe","4203","Console","1","10,000 K"',
      '"codex-code-mode-host.exe","4204","Console","1","10,000 K"',
      '',
    ].join('\r\n');
  });
  assert.deepEqual(processes, [
    { pid: 4201, command: 'codex.exe' },
    { pid: 4202, command: 'Codex.exe' },
  ].filter(({ pid }) => pid !== process.pid));
});

test('没有 Codex 进程时返回空列表，兼容 Windows 的本地化提示', async () => {
  assert.deepEqual(await findCodexProcesses('linux', async () => '  4301 node\n  4302 ps\n'), []);
  for (const output of ['', 'INFO: No tasks are running which match the specified criteria.\r\n', '信息: 没有运行的任务匹配指定标准。\r\n']) {
    assert.deepEqual(await findCodexProcesses('win32', async () => output), []);
  }
});

test('查询失败不会被视为没有 Codex 进程，也不泄漏底层输出', async () => {
  await assert.rejects(findCodexProcesses('linux', async () => {
    throw new Error('private command output');
  }), { message: '无法检测 Codex 进程，未切换账号。请确认系统允许查询进程后重试。' });
});
