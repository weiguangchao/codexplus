import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '../src/client.js';
import { confirmRunningCodex, switchCredential } from '../src/switch.js';

test('有运行中的进程时显示 PID，默认取消且不修改当前凭证', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-switch-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const store = new Session('http://127.0.0.1:1', home, join(home, '.codex', 'auth.json'), async () => {});
  const credential = { type: 'codex', email: 'person@example.com' } as const;
  await mkdir(join(home, '.codex'));
  const current = '{"tokens":{"access_token":"fake-current-access"}}';
  await writeFile(store.codexAuthPath, current);
  const messages: string[] = [];
  let asked = false;

  await switchCredential(store, credential, {
    findProcesses: async () => [{ pid: 4401, command: 'codex' }, { pid: 4402, command: 'Codex' }],
    ask: async (options) => {
      asked = true;
      assert.equal(options.default, false);
      assert.ok(messages.some((message) => message.includes('4401')));
      assert.ok(messages.some((message) => message.includes('4402')));
      return options.default;
    },
    log: (message) => messages.push(message),
  });

  assert.equal(asked, true);
  assert.equal(await readFile(store.codexAuthPath, 'utf8'), current);
  assert.match(messages.at(-1) ?? '', /已取消切换/u);
  assert.ok(messages.some((message) => message.includes('不代表任务正忙')));
});

test('明确确认后才执行切换', async () => {
  const events: string[] = [];
  const credential = { type: 'codex', email: 'person@example.com' } as const;
  await switchCredential({ switch: async (selected) => {
    assert.equal(selected, credential);
    events.push('switch');
  }, restartCodexServer: async () => assert.fail('普通切换不应重启') }, credential, {
    findProcesses: async () => [{ pid: 4501, command: 'codex' }],
    ask: async () => {
      events.push('confirm');
      return true;
    },
    log: (message) => events.push(message),
  });
  assert.ok(events.indexOf('confirm') < events.indexOf('switch'));
  assert.equal(events.at(-1), '已切换到：person@example.com');
});

test('没有运行中的进程时直接切换，不显示额外确认', async () => {
  let switched = false;
  await switchCredential({ switch: async () => { switched = true; }, restartCodexServer: async () => assert.fail('没有进程时不应重启') }, { type: 'codex', email: 'person@example.com' }, {
    findProcesses: async () => [],
    ask: async () => assert.fail('没有进程时不应再次确认'),
    log: () => {},
  });
  assert.equal(switched, true);
});

test('检测失败或 Ctrl+C 取消确认时不执行切换', async () => {
  const credential = { type: 'codex', email: 'person@example.com' } as const;
  const store = { switch: async () => assert.fail('不应修改凭证'), restartCodexServer: async () => assert.fail('不应重启') };
  await assert.rejects(switchCredential(store, credential, {
    findProcesses: async () => { throw new Error('检测失败'); },
    ask: async () => assert.fail('检测失败时不应确认'),
    log: () => {},
  }), /检测失败/u);
  await assert.rejects(switchCredential(store, credential, {
    findProcesses: async () => [{ pid: 4601, command: 'codex' }],
    ask: async () => { throw new Error('ExitPromptError'); },
    log: () => {},
  }), /ExitPromptError/u);
});

test('选择重启时先切换，切换失败不重启，重启失败保留已完成的切换', async () => {
  const events: string[] = [];
  const credential = { type: 'codex', email: 'person@example.com' } as const;
  const options = { findProcesses: async () => [{ pid: 4501, command: 'codex' }], ask: async () => 'restart' as const, log: () => {} };
  await switchCredential({
    switch: async () => { events.push('switch'); },
    restartCodexServer: async () => { events.push('restart'); },
  }, credential, options);
  assert.deepEqual(events, ['switch', 'restart']);
  await assert.rejects(switchCredential({
    switch: async () => { throw new Error('切换失败'); },
    restartCodexServer: async () => assert.fail('切换失败不应重启'),
  }, credential, options), /切换失败/u);
  await assert.rejects(switchCredential({
    switch: async () => { events.push('switched-again'); },
    restartCodexServer: async () => { throw new Error('重启失败'); },
  }, credential, options), /重启失败/u);
  assert.deepEqual(events, ['switch', 'restart', 'switched-again']);
});

test('更新本机登录时，进程确认使用更新文案并说明会改写本机凭证', async () => {
  const messages: string[] = [];
  assert.equal(await confirmRunningCodex({
    action: 'update',
    findProcesses: async () => [{ pid: 4601, command: 'codex' }],
    ask: async ({ message, action, default: answer }) => {
      assert.equal(message, '仍要更新本机登录吗？');
      assert.equal(action, 'update');
      return answer;
    },
    log: (message) => messages.push(message),
  }), false);
  assert.ok(messages.includes('现在更新会改写本机登录文件：'));
  assert.ok(messages.includes('  ~/.codex/auth.json'));
  assert.ok(messages.includes('建议先退出 Codex。'));
  assert.match(messages.at(-1)!, /已取消更新/u);
  assert.ok(messages.every((message) => !message.includes('切换')));
});
