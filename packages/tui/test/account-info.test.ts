import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { AccountInfo } from '@weiguangchao/codexplus-shared';
import { accountInfoFlow, renderAccountInfo } from '../src/account-info.js';
import { BACK } from '../src/prompts.js';
import { displayWidth, mainChoices } from '../src/ui.js';

const now = Date.parse('2026-11-15T08:00:00Z');
const info: AccountInfo = { email: 'developer@example.com', planType: 'plus', expiresAt: '2030-12-15T15:59:00Z',
  fiveHour: { remainingPercent: 68, resetsAt: new Date(now + 138 * 60_000).toISOString() },
  weekly: { remainingPercent: 42, resetsAt: '2026-11-19T01:00:00Z' } };

test('删除账号后显示查看账户信息，按当前登录状态而非凭证库是否为空决定可用性', () => {
  const choices = mainChoices([], { status: 'unsaved', email: null }).choices;
  const index = choices.findIndex((choice) => 'value' in choice && choice.value === 'delete');
  const choice = choices[index + 1];
  assert.ok(choice && 'value' in choice && choice.value === 'info');
  assert.equal(choice.name, '查看账户信息');
  assert.equal(choice.disabled, false);
  for (const status of ['saved', 'ahead', 'behind', 'diverged', 'deleted', 'unsaved'] as const) {
    const item = mainChoices([], { status, email: info.email! }).choices.find((choice) => 'value' in choice && choice.value === 'info');
    assert.ok(item && 'disabled' in item && item.disabled === false);
  }
  for (const current of [{ status: 'none' }, { status: 'invalid', reason: 'bad' }] as const) {
    const item = mainChoices([], current).choices.find((choice) => 'value' in choice && choice.value === 'info');
    assert.ok(item && 'disabled' in item && item.disabled);
  }
});

test('展示脱敏邮箱、当前套餐、带年和时区的到期时间、剩余额度及独立重置时间', () => {
  const text = stripVTControlCharacters(renderAccountInfo(info, now));
  assert.match(text, /de\*\*\*er@e\*\*\* ● 当前/u);
  assert.doesNotMatch(text, /developer@example/u);
  assert.match(text, /当前套餐 {2}ChatGPT Plus/u);
  assert.match(text, /到期时间 {2}2030-12-\d{2} \d{2}:\d{2} \S+/u);
  assert.match(text, /五小时额度 +剩余 68%\n {2}█{14}░{6}/u);
  assert.match(text, /2 小时 18 分后重置/u);
  assert.match(text, /每周额度 +剩余 42%\n {2}█{8}░{12}/u);
  assert.match(text, /2026-11-\d{2} .*重置/u);
  for (const line of stripVTControlCharacters(renderAccountInfo(info, now, 32)).split('\n')) assert.ok(displayWidth(line) <= 32, line);
});

test('缺失数据明确显示未提供，不伪造满额；过期重置时间不显示负数', () => {
  const text = stripVTControlCharacters(renderAccountInfo({ ...info, email: null, expiresAt: null, fiveHour: null, weekly: null }, now));
  assert.match(text, /无法识别邮箱/u);
  assert.match(text, /到期时间 {2}未提供/u);
  assert.match(text, /五小时额度 {2}未提供/u);
  assert.match(text, /每周额度 {2}未提供/u);
  assert.doesNotMatch(text, /100%|█/u);
  assert.match(stripVTControlCharacters(renderAccountInfo({ ...info, fiveHour: { remainingPercent: 0, resetsAt: '2026-01-01T00:00:00Z' } }, now)), /等待重置/u);
});

test('只在进入和明确刷新时查询；返回和 Esc 都结束详情页', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  let calls = 0;
  const snapshots: number[] = [];
  const store = { accountInfo: async () => ({ ...info, fiveHour: { ...info.fiveHour!, remainingPercent: ++calls } }) };
  await accountInfoFlow(store, async (current) => { snapshots.push(current.fiveHour!.remainingPercent); return calls === 1 ? 'refresh' : BACK; });
  assert.deepEqual(snapshots, [1, 2]);
  await accountInfoFlow(store, async () => 'back');
  assert.equal(calls, 3);
});

test('查询失败交回主菜单的错误处理，不自动重复请求', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  let calls = 0;
  await assert.rejects(accountInfoFlow({ accountInfo: async () => { calls++; throw new Error('expired'); } }, async () => assert.fail('不显示旧数据')), /expired/u);
  assert.equal(calls, 1);
});
