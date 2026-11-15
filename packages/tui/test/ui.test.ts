import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { Separator } from '@inquirer/prompts';
import { addChoices, deleteChoices, displayWidth, fit, line, mainChoices, maskEmail, maskHomePath, renderStatus, resetCardChoices, selectTheme, switchChoices } from '../src/ui.js';
import { renderSelect } from '../src/select.js';

const alice = { type: 'codex' as const, email: 'alice@example.com' };
const bob = { type: 'codex' as const, email: 'bob@example.com' };
const plain = (text: string) => stripVTControlCharacters(text);

test('邮箱脱敏保留账号前后各两位及服务商首字符，隐藏短账号和域名后缀', () => {
  for (const [email, masked] of [
    ['guest66@163.example', 'gu***66@1***'],
    ['taylorigma@icloud.example', 'ta***ma@i***'],
    ['taylorigma@outlook.example', 'ta***ma@o***'],
    ['weston1029@gmail.example', 'we***29@g***'],
    ['a@example.com', '***@e***'],
    ['abcd@example.com', '***@e***'],
    ['用户测试账号@example.com', '用户***账号@e***'],
  ] as const) {
    assert.equal(maskEmail(email), masked);
  }
});

test('切换和删除列表只脱敏显示名称，保留完整账号作为操作值', () => {
  const credentials = ['taylorigma@icloud.example', 'taylorigma@outlook.example']
    .map((email) => ({ type: 'codex' as const, email }));
  const menu = switchChoices(credentials, { status: 'saved', email: credentials[0]!.email });
  assert.equal(menu.default, credentials[1]);
  const queried: string[] = [];
  const deleted = deleteChoices(credentials, (email) => { queried.push(email); return null; });
  for (const choices of [menu.choices, deleted]) {
    const [first, second] = choices;
    assert.ok(first && second && !(first instanceof Separator) && !(second instanceof Separator));
    assert.equal(first.name, 'ta***ma@i***');
    assert.equal(second.name, 'ta***ma@o***');
    assert.equal(first.value, credentials[0]);
    assert.equal(second.value, credentials[1]);
  }
  assert.deepEqual(queried, credentials.map(({ email }) => email));
});

test('路径只隐藏所属用户目录的账户名', () => {
  const users = resolve('synthetic-users');
  const userHome = join(users, 'syntheticuser');
  assert.equal(maskHomePath(join(userHome, '.codexplus'), userHome), join(users, 'sy***er', '.codexplus'));
  assert.equal(maskHomePath(userHome, userHome), join(users, 'sy***er'));
  const outside = join(users, 'syntheticuser-other', 'data');
  assert.equal(maskHomePath(outside, userHome), outside);
  assert.equal(maskHomePath('./data', userHome), './data');
});

test('状态栏区分已保存、未保存和未登录', () => {
  assert.match(plain(renderStatus({ status: 'saved', email: 'alice@example.com' }, 2)), /当前账号 {2}● al\*{3}ce@e\*{3}\n已保存 {4}2 个/u);
  assert.match(plain(renderStatus({ status: 'unsaved', email: 'carol@example.com' }, 0)), /ca\*{3}ol@e\*{3} 未保存[\s\S]*暂无/u);
  assert.match(plain(renderStatus({ status: 'unsaved', email: null }, 1)), /无法识别/u);
  assert.match(plain(renderStatus({ status: 'none' }, 1)), /未登录/u);
  assert.match(plain(renderStatus({ status: 'ahead', email: 'alice@example.com' }, 1)), /al\*{3}ce@e\*{3} 有更新未保存/u);
});

test('各同步状态、添加来源和更新说明都使用脱敏邮箱', () => {
  for (const status of ['saved', 'ahead', 'behind', 'diverged', 'deleted', 'unsaved'] as const) {
    const current = { status, email: alice.email };
    const text = plain([
      renderStatus(current, 2),
      ...mainChoices([alice, bob], current).choices.map((choice) => 'description' in choice ? choice.description : ''),
      ...addChoices(current).map((choice) => 'description' in choice ? choice.description : ''),
    ].join('\n'));
    assert.ok(text.includes('al***ce@e***'));
    assert.ok(!text.includes(alice.email));
  }
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
  assert.equal(mainChoices([alice, bob], { status: 'ahead', email: 'alice@example.com' }).default, 'add');
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

test('重置卡列表标记当前账号但仍可选择，并在返回前保留分隔线', () => {
  for (const status of ['saved', 'ahead', 'behind', 'diverged', 'unsaved'] as const) {
    const choices = resetCardChoices([alice, bob], { status, email: alice.email });
    const [current, other, divider, back] = choices;
    assert.ok(current && other && back && !(current instanceof Separator) && !(other instanceof Separator) && !(back instanceof Separator));
    assert.equal(plain(current.name), 'al***ce@e*** ● 当前');
    assert.equal(current.value, alice);
    assert.ok(!('disabled' in current && current.disabled));
    assert.equal(other.name, '***@e***');
    assert.equal(other.value, bob);
    assert.ok(divider instanceof Separator);
    assert.equal(back.value, null);
  }
  for (const current of [{ status: 'none' }, { status: 'saved', email: 'other@example.com' }] as const) {
    assert.ok(resetCardChoices([alice, bob], current).every((choice) => choice instanceof Separator || !choice.name.includes('当前')));
  }
});

test('添加来源在找不到 Codex 登录时禁用', () => {
  const [codex] = addChoices({ status: 'none' });
  assert.ok(codex && !(codex instanceof Separator) && codex.disabled);
  const [saved] = addChoices({ status: 'saved', email: 'alice@example.com' });
  assert.ok(saved && !(saved instanceof Separator) && !saved.disabled && /无需更新/u.test(saved.description));
  const browser = addChoices({ status: 'none' }).find((choice) => !(choice instanceof Separator) && choice.value === 'browser');
  assert.ok(browser && !(browser instanceof Separator) && !('disabled' in browser && browser.disabled));
});

test('按键提示使用中文并包含 esc', () => {
  const tip = plain(renderSelect({ message: '选择', choices: [{ value: false, name: '返回' }, { value: true, name: '继续' }], theme: selectTheme('返回') },
    { active: 0, query: '', error: '' }, 80, 24));
  assert.match(tip, /↑↓ 移动.*Enter 确认.*Esc 返回/u);
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

test('服务端更新默认下载，删除菜单随账号列表启用', () => {
  assert.equal(mainChoices([alice], { status: 'behind', email: alice.email }).default, 'update');
  for (const status of ['behind', 'diverged'] as const) assert.match(plain(renderStatus({ status, email: alice.email }, 1)), status === 'behind' ? /账号库有更新版本/u : /与账号库版本不一致/u);
  const findDelete = (credentials: typeof alice[]) => mainChoices(credentials, { status: 'none' }).choices.find((choice) => !(choice instanceof Separator) && choice.value === 'delete');
  const empty = findDelete([]);
  const filled = findDelete([alice]);
  assert.ok(empty && !(empty instanceof Separator) && empty.disabled);
  assert.ok(filled && !(filled instanceof Separator) && !filled.disabled);
});
