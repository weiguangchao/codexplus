import { expectValue } from '../../shared/test/helpers.js';
import { parseEmail } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { AccountInfo } from '@weiguangchao/codexplus-shared';
import { accountInfoConfig, accountInfoFlow, renderAccountInfo } from '../src/account-info.js';
import { BACK } from '../src/prompts.js';
import { displayWidth, mainChoices } from '../src/ui.js';
import { renderSelect } from '../src/select-layout.js';

const now = Date.parse('2026-11-15T08:00:00Z');
const info = { email: parseEmail('developer@example.com'), planType: 'plus', expiresAt: '2030-12-15T15:59:00Z',
  fiveHour: { remainingPercent: 68, resetsAt: new Date(now + 138 * 60_000).toISOString() },
  weekly: { remainingPercent: 42, resetsAt: '2026-11-19T01:00:00Z' } } satisfies AccountInfo;

test('中等高度保留到期和重置时间，最小视口仍保留两种额度并保持告警颜色', (context) => {
  const previous = { force: process.env.FORCE_COLOR, noColor: process.env.NO_COLOR };
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  context.after(() => {
    if (previous.force === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previous.force;
    if (previous.noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous.noColor;
  });
  const low = { ...info, fiveHour: { ...expectValue(info.fiveHour), remainingPercent: 8 }, weekly: { ...expectValue(info.weekly), remainingPercent: 18 } };
  const config = accountInfoConfig({ info: low, now });
  for (const [columns, rows] of [[120, 17], [80, 17], [40, 16], [24, 8]] as const) {
    const raw = renderSelect(config, { active: 0, query: '', error: '' }, columns, rows);
    const text = stripVTControlCharacters(raw);
    assert.ok(text.includes('8%') && text.includes('18%'));
    assert.ok(raw.includes('\x1b[31m8%\x1b[39m'));
    assert.ok(raw.includes('\x1b[33m18%\x1b[39m'));
    assert.ok(text.includes('刷新') && text.includes('返回'));
    assert.ok(text.split('\n').length < rows);
    if (rows > 8) {
      assert.ok(text.includes('到期时间'));
      assert.match(text, /2 小时 18 分后重置/u);
      assert.match(text, /2026-11-\d{2} .*重置/u);
    }
  }
});

test('账户信息优先于账号管理，按当前登录状态而非凭证库是否为空决定可用性', () => {
  const choices = mainChoices({ credentials: [], current: { status: 'unsaved', email: null } }).choices;
  const index = choices.findIndex((choice) => 'value' in choice && choice.value === 'info');
  assert.ok(index < choices.findIndex((choice) => 'value' in choice && choice.value === 'delete'));
  const choice = choices[index];
  assert.ok(choice && 'value' in choice && choice.value === 'info');
  assert.equal(choice.name, '查看账户信息');
  assert.equal(choice.disabled, false);
  for (const status of ['saved', 'ahead', 'behind', 'diverged', 'deleted', 'unsaved'] as const) {
    const item = mainChoices({ credentials: [], current: { status, email: expectValue(info.email) } }).choices.find((choice) => 'value' in choice && choice.value === 'info');
    assert.ok(item && 'disabled' in item && item.disabled === false);
  }
  for (const current of [{ status: 'none' }, { status: 'invalid', reason: 'bad' }] as const) {
    const item = mainChoices({ credentials: [], current }).choices.find((choice) => 'value' in choice && choice.value === 'info');
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
  const store = { accountInfo: async () => ({ ...info, fiveHour: { ...expectValue(info.fiveHour), remainingPercent: ++calls } }) };
  await accountInfoFlow({ store, ask: async (current) => { snapshots.push(expectValue(current.fiveHour).remainingPercent); return calls === 1 ? 'refresh' : BACK; } });
  assert.deepEqual(snapshots, [1, 2]);
  await accountInfoFlow({ store, ask: async () => 'back' });
  assert.equal(calls, 3);
});

test('查询失败交回主菜单的错误处理，不自动重复请求', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  let calls = 0;
  await assert.rejects(accountInfoFlow({ store: { accountInfo: async () => { calls++; throw new Error('expired'); } }, ask: async () => assert.fail('不显示旧数据') }), /expired/u);
  assert.equal(calls, 1);
});
