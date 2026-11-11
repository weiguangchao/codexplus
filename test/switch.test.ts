import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStore } from '../src/store.js';
import { switchCredential } from '../src/switch.js';

test('有运行中的进程时显示 PID，默认取消且不修改当前凭证', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'codexplus-switch-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const store = new CredentialStore(home, async () => Response.json({ email: 'person@example.com' }));
  const source = join(home, 'input.json');
  await writeFile(source, '{"tokens":{"access_token":"fake-new-access"}}');
  const credential = await store.add(source);
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
  } }, credential, {
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
  await switchCredential({ switch: async () => { switched = true; } }, { type: 'codex', email: 'person@example.com' }, {
    findProcesses: async () => [],
    ask: async () => assert.fail('没有进程时不应再次确认'),
    log: () => {},
  });
  assert.equal(switched, true);
});

test('检测失败或 Ctrl+C 取消确认时不执行切换', async () => {
  const credential = { type: 'codex', email: 'person@example.com' } as const;
  const store = { switch: async () => assert.fail('不应修改凭证') };
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
