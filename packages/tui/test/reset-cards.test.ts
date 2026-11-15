import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResetCard, ResetCardOutcome } from '@weiguangchao/codexplus-shared';
import { BACK } from '../src/prompts.js';
import { resetCardDetails, resetCardFlow, resetCardName } from '../src/reset-cards.js';
import { mainChoices } from '../src/ui.js';

const alice = { type: 'codex' as const, email: 'alice@example.com' };
const bob = { type: 'codex' as const, email: 'bobby@example.com' };
const current = { status: 'saved' as const, email: bob.email };
const first: ResetCard = { id: 'first', resetType: 'codex_rate_limits', title: null, description: null, grantedAt: '2026-01-01T00:00:00Z', expiresAt: null };
const second: ResetCard = { ...first, id: 'second' };
type Prompts = NonNullable<Parameters<typeof resetCardFlow>[3]>;
const prompts: Prompts = { account: async () => null, card: async () => null, confirm: async () => false };

test('主菜单在查看账户信息之后显示使用 Codex 重置卡，有账号才可进入', () => {
  const choices = mainChoices([alice], { status: 'saved', email: alice.email }).choices;
  const index = choices.findIndex((choice) => 'value' in choice && choice.value === 'info');
  const reset = choices[index + 1];
  assert.ok(reset && 'value' in reset && reset.value === 'reset');
  assert.equal(reset.name, '使用 Codex 重置卡');
  assert.equal(reset.disabled, false);
  const empty = mainChoices([], { status: 'none' }).choices.find((choice) => 'value' in choice && choice.value === 'reset');
  assert.ok(empty && 'disabled' in empty && empty.disabled);
});

test('先选账号才查询卡片，选卡和确认取消均不使用卡，只有明确确认后使用所选卡', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  context.mock.method(console, 'log', () => {});
  const calls: string[] = [];
  let selections = 0;
  let confirmations = 0;
  await resetCardFlow({
    resetCards: async (account) => { calls.push(`list:${account.email}`); return [first, second]; },
    useResetCard: async (account, id) => { calls.push(`use:${account.email}:${id}`); return 'reset'; },
  }, [alice, bob], current, {
    account: async (credentials, login) => { assert.deepEqual(credentials, [alice, bob]); assert.equal(login, current); calls.push('account'); return bob; },
    card: async (account, cards) => { assert.equal(account, bob); assert.deepEqual(cards, [first, second]); return selections++ === 0 ? first : second; },
    confirm: async (account, card) => {
      assert.equal(account, bob);
      confirmations++;
      if (confirmations === 1) { assert.equal(card, first); return false; }
      if (confirmations === 2) return BACK;
      assert.equal(card, second);
      return true;
    },
  });
  assert.equal(confirmations, 3);
  assert.deepEqual(calls, ['account', `list:${bob.email}`, `use:${bob.email}:second`]);
});

test('卡片列表返回后可重新选账号，只显示新账号的卡片', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  context.mock.method(console, 'log', () => {});
  let accounts = 0;
  const queried: string[] = [];
  await resetCardFlow({
    resetCards: async (account) => { queried.push(account.email); return account === alice ? [first] : [second]; },
    useResetCard: async (account, id) => { assert.equal(account, bob); assert.equal(id, second.id); return 'reset'; },
  }, [alice, bob], current, {
    account: async () => accounts++ === 0 ? alice : bob,
    card: async (account, cards) => { assert.deepEqual(cards, account === alice ? [first] : [second]); return account === alice ? BACK : second; },
    confirm: async () => true,
  });
  assert.deepEqual(queried, [alice.email, bob.email]);
});

test('没有卡片时可返回或改选账号；退出和空账号列表都不调用使用接口', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  const logs = context.mock.method(console, 'log', () => {});
  let queries = 0;
  let accounts = 0;
  const store = { resetCards: async () => { queries++; return []; }, useResetCard: async (): Promise<ResetCardOutcome> => { assert.fail('不应使用卡片'); } };
  await resetCardFlow(store, [alice], current, { ...prompts, account: async () => accounts++ === 0 ? alice : null,
    card: async () => assert.fail('无卡时不应选卡') });
  assert.equal(queries, 1);
  assert.match(logs.mock.calls.map(({ arguments: args }) => args.join('')).join(''), /暂无可用/u);
  await resetCardFlow(store, [alice], current, { ...prompts, account: async () => BACK });
  await resetCardFlow(store, [], current, { ...prompts, account: async () => assert.fail('无账号时不应选账号') });
  assert.equal(queries, 1);
});

for (const [outcome, message] of [['reset', /已为/u], ['nothing_to_reset', /未消耗/u], ['no_credit', /无可用次数/u], ['already_redeemed', /此前已成功/u]] as const) {
  test(`使用结果 ${outcome} 提示准确且只请求一次`, async (context) => {
    context.mock.method(process.stdout, 'write', () => true);
    const logs = context.mock.method(console, 'log', () => {});
    let used = 0;
    await resetCardFlow({ resetCards: async () => [first], useResetCard: async () => { used++; return outcome; } }, [alice], current, {
      account: async () => alice, card: async () => first, confirm: async () => true,
    });
    assert.equal(used, 1);
    assert.match(logs.mock.calls.map(({ arguments: args }) => args.join('')).join(''), message);
  });
}

test('查询或使用失败立即退出流程，不自动重试或更换卡片', async (context) => {
  context.mock.method(process.stdout, 'write', () => true);
  let queries = 0;
  let used = 0;
  const ask: Prompts = { account: async () => alice, card: async () => first, confirm: async () => true };
  await assert.rejects(resetCardFlow({ resetCards: async () => { queries++; throw new Error('query failed'); },
    useResetCard: async () => assert.fail('查询失败不使用卡') }, [alice], current, ask), /query failed/u);
  await assert.rejects(resetCardFlow({ resetCards: async () => [first],
    useResetCard: async () => { used++; throw new Error('result unknown'); } }, [alice], current, ask), /result unknown/u);
  assert.equal(queries, 1);
  assert.equal(used, 1);
});

test('卡片标签展示获得时间、到期时间和说明，过滤控制字符', () => {
  const card = { ...first, title: '\x1b[31mFull reset\n', description: 'Weekly + 5 hr\x07', expiresAt: '2099-01-01T00:00:00Z' };
  assert.match(resetCardName(card, 1), /^2\. Full reset · 过期时间：.*2099/u);
  for (const control of ['\x1b', '\n']) assert.ok(!resetCardName(card, 1).includes(control));
  const details = resetCardDetails(card);
  assert.match(details, /Weekly \+ 5 hr.*获得时间：.*2026.*到期时间：.*2099/u);
  for (const control of ['\x07', '\x1b', '\n']) assert.ok(!details.includes(control));
  assert.equal(resetCardName(first), 'Codex 额度重置');
  assert.equal(resetCardName(first, 0), '1. Codex 额度重置 · 过期时间：未提供');
  assert.match(resetCardDetails(first), /到期时间：未提供/u);
});
