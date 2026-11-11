import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { Separator } from '@inquirer/prompts';
import { addChoices, displayWidth, fit, line, mainChoices, renderStatus, selectTheme, switchChoices } from '../src/ui.js';

const alice = { type: 'codex' as const, email: 'alice@example.com' };
const bob = { type: 'codex' as const, email: 'bob@example.com' };
const plain = (text: string) => stripVTControlCharacters(text);

test('状态栏区分已保存、未保存和未登录', () => {
  assert.match(plain(renderStatus({ status: 'saved', email: 'alice@example.com' }, 2)), /当前账号 {2}● alice@example\.com\n已保存 {4}2 个/u);
  assert.match(plain(renderStatus({ status: 'unsaved', email: 'carol@example.com' }, 0)), /carol@example\.com 未保存[\s\S]*暂无/u);
  assert.match(plain(renderStatus({ status: 'unsaved', email: null }, 1)), /无法识别/u);
  assert.match(plain(renderStatus({ status: 'none' }, 1)), /未登录/u);
  assert.match(plain(renderStatus({ status: 'stale', email: 'alice@example.com' }, 1)), /alice@example\.com 有更新未保存/u);
});

test('主菜单在没有可切换账号或当前登录需要保存时默认添加', () => {
  const empty = mainChoices([], { status: 'none' });
  assert.equal(empty.default, 'add');
  const switchChoice = empty.choices[0];
  assert.ok(switchChoice && !(switchChoice instanceof Separator) && switchChoice.disabled);
  const onlyCurrent = mainChoices([alice], { status: 'saved', email: 'alice@example.com' });
  assert.equal(onlyCurrent.default, 'add');
  const onlyChoice = onlyCurrent.choices[0];
  assert.ok(onlyChoice && !(onlyChoice instanceof Separator) && onlyChoice.disabled);
  assert.equal(mainChoices([alice, bob], { status: 'unsaved', email: null }).default, 'add');
  assert.equal(mainChoices([alice, bob], { status: 'stale', email: 'alice@example.com' }).default, 'add');
  assert.equal(mainChoices([alice, bob], { status: 'saved', email: 'alice@example.com' }).default, 'switch');
  const describe = (menu: ReturnType<typeof mainChoices>) => {
    const choice = menu.choices[0];
    return choice && !(choice instanceof Separator) ? choice.description : '';
  };
  assert.equal(describe(mainChoices([alice, bob], { status: 'none' })), '从 2 个已保存的账号中选择一个');
  assert.equal(describe(mainChoices([alice, bob], { status: 'saved', email: 'alice@example.com' })), '从 1 个其他账号中选择一个');
});

test('切换列表禁用当前账号并默认选中其他账号', () => {
  const menu = switchChoices([alice, bob], { status: 'saved', email: 'alice@example.com' });
  assert.deepEqual(menu.default, bob);
  const first = menu.choices[0];
  assert.ok(first && !(first instanceof Separator) && 'disabled' in first && first.disabled);
  assert.equal(switchChoices([alice], { status: 'saved', email: 'alice@example.com' }).default, null);
  assert.deepEqual(switchChoices([alice, bob], { status: 'none' }).default, alice);
});

test('添加来源在找不到 Codex 登录时禁用', () => {
  const [codex] = addChoices({ status: 'none' });
  assert.ok(codex && !(codex instanceof Separator) && codex.disabled);
  const [saved] = addChoices({ status: 'saved', email: 'alice@example.com' });
  assert.ok(saved && !(saved instanceof Separator) && !saved.disabled && /无需更新/u.test(saved.description));
});

test('按键提示使用中文并包含 esc', () => {
  const tip = plain(selectTheme('返回').style.keysHelpTip([['↑↓', 'navigate'], ['⏎', 'select']]));
  assert.equal(tip, '↑↓ 移动 · ⏎ 确认 · esc 返回');
});

test('按显示宽度截断中文', () => {
  assert.equal(fit('正在查询账号', 20), '正在查询账号');
  assert.equal(fit('正在查询账号', 7), '正在查…');
  assert.equal(fit('abcdef', 4), 'abc…');
});

test('结果行过宽时把路径放到下一行', () => {
  assert.equal(displayWidth('中文ab'), 6);
  const columns = process.stdout.columns || 80;
  assert.equal(plain(line('x', 'ok', '~/a.json')), 'x ok  ~/a.json');
  assert.equal(plain(line('x', '错'.repeat(columns), '~/a.json')), `x ${'错'.repeat(columns)}\n  ~/a.json`);
});
