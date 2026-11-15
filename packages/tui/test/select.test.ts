import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { Separator } from '@inquirer/core';
import { renderSelect, select } from '../src/select.js';
import { homeSummary, locationSummary, renderHome, renderLocations } from '../src/screens.js';
import { accountSummary, renderAccountInfo } from '../src/account-info.js';
import { pageTarget, selectLayout } from '../src/select-layout.js';
import { BACK, escapable } from '../src/prompts.js';
import { displayWidth, mainChoices, switchChoices } from '../src/ui.js';
import { clipHeader } from '../src/select-budget.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const alice = { type: 'codex' as const, email: 'alice@example.com' };
const bob = { type: 'codex' as const, email: 'bobby@icloud.com' };

function harness<T>(config: Parameters<typeof select<T>>[0]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (chunk) => { screen += String(chunk); });
  const answer = select(config, { input, output, clearPromptOnDone: true });
  return { answer, screen: () => stripVTControlCharacters(screen), async key(value: string) { input.write(value); await tick(); } };
}

test('首页在标准与窄终端内保留账号状态、当前焦点和返回提示', () => {
  for (const columns of [24, 32, 40, 80, 120]) for (const rows of [8, 9, 10, 12, 15, 16, 24, 40]) {
    for (const status of ['saved', 'ahead', 'behind', 'diverged', 'deleted', 'unsaved'] as const) {
      const current = { status, email: alice.email };
      const menu = mainChoices([alice, bob], current);
      const active = menu.choices.findIndex((item) => !Separator.isSeparator(item) && item.value === menu.default);
      const text = stripVTControlCharacters(renderSelect({ message: renderHome(current, 2, '0.1.0', columns), compactMessage: homeSummary(current, 2), choices: menu.choices,
        theme: { escapeLabel: '退出' } }, { active, query: '', error: '' }, columns, rows));
      assert.ok(text.includes('al***ce@e***'));
      assert.ok(text.includes('› '));
      assert.match(text, rows < 12 ? /Esc/u : /Esc 退出/u);
      const lines = text.split('\n');
      assert.ok(lines.length < rows, `${columns}×${rows}: ${lines.length}\n${text}`);
      for (const line of lines) assert.ok(displayWidth(line) < columns, line);
      assert.ok(!text.includes(alice.email));
    }
  }
});

test('快捷键只移动焦点，Enter 才提交；禁用选项不能提交', async () => {
  const prompt = harness({ message: '选择操作', choices: [{ value: 'safe', name: '返回', key: 'q' },
    { value: 'disabled', name: '删除', key: 'd', disabled: '(暂无账号)' }, { value: 'add', name: '添加', key: 'a' }] });
  let settled = false;
  void prompt.answer.then(() => { settled = true; });
  await prompt.key('d');
  await prompt.key('\r');
  assert.equal(settled, false);
  assert.match(prompt.screen(), /暂无账号/u);
  await prompt.key('a');
  assert.equal(settled, false);
  await prompt.key('\r');
  assert.equal(await prompt.answer, 'add');
});

test('账号筛选保持完整操作值，支持无结果、退格、清空和返回', async () => {
  const menu = switchChoices([alice, bob], { status: 'saved', email: alice.email });
  const prompt = harness({ message: '切换账号', choices: menu.choices, default: menu.default, searchable: true });
  await prompt.key('xyz');
  assert.match(prompt.screen(), /无匹配账号/u);
  await prompt.key('\x15');
  await prompt.key('br');
  await prompt.key('\x7f');
  await prompt.key('o');
  await prompt.key('\r');
  assert.equal(await prompt.answer, bob);
  assert.ok(!prompt.screen().includes(bob.email));
  const empty = harness({ message: '选择账号', choices: menu.choices, searchable: true });
  await empty.key('xyz');
  await empty.key('\r');
  assert.equal(await empty.answer, null);
});

test('长列表支持首尾和翻页，并在可视区域显示当前焦点', async () => {
  const choices = Array.from({ length: 30 }, (_, value) => ({ value, name: `账号 ${value + 1}` }));
  const prompt = harness({ message: '选择账号', choices, default: 0 });
  await prompt.key('\x1b[F');
  assert.match(prompt.screen(), /› 账号 30/u);
  await prompt.key('\x1b[5~');
  await prompt.key('\r');
  assert.equal(await prompt.answer, 20);
});

test('中止会清理选择器的终端 resize 监听', async () => {
  const listeners = process.stdout.listenerCount('resize');
  const controller = new AbortController();
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answer = select({ message: '确认', choices: [{ value: false, name: '取消' }] }, { input, output, signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(answer, { name: 'AbortPromptError' });
  assert.equal(process.stdout.listenerCount('resize'), listeners);
});

test('长确认说明保持在屏幕内，可完整查看后返回，Enter 不会直接确认', async () => {
  const message = ['确认使用重置卡？', ...Array.from({ length: 30 }, (_, index) => `说明第 ${index + 1} 行`), '消耗后无法撤销。'].join('\n');
  const config = { message, choices: [{ value: false, name: '取消' }, { value: true, name: '使用' }], default: false };
  const screen = stripVTControlCharacters(renderSelect(config, { active: 0, query: '', error: '' }, 40, 16));
  assert.ok(screen.split('\n').length < 16, screen);
  assert.match(screen, /Ctrl\+O 说明/u);
  assert.match(screen, /消耗后无法撤销/u);
  const prompt = harness(config);
  let settled = false;
  void prompt.answer.then(() => { settled = true; });
  await prompt.key('\x1bOP');
  await prompt.key('\x1b[F');
  assert.match(prompt.screen(), /说明第 30 行/u);
  await prompt.key('\r');
  assert.equal(settled, false);
  await prompt.key('\r');
  assert.equal(await prompt.answer, false);
});

test('不可用选项在 Enter 后继续说明原因和下一步，Ctrl+O 可完整查看', async () => {
  const prompt = harness({ message: '选择操作', choices: [{ value: false, name: '返回' },
    { value: true, name: '切换账号', disabled: '(暂无账号)', description: '还没有保存的账号，请先添加。' }] });
  await prompt.key('\x1b[B');
  const before = prompt.screen().length;
  await prompt.key('\r');
  assert.match(prompt.screen().slice(before), /不可用：还没有保存的账号，请先添加/u);
  await prompt.key('\x0f');
  await prompt.key('\x1b[F');
  await prompt.key('\r');
  await prompt.key('\x1b[A');
  await prompt.key('\r');
  assert.equal(await prompt.answer, false);
});

test('详情内 Esc 返回选项，随后 Esc 才通过 escapable 返回上一级', async (context) => {
  context.after(() => process.stdin.pause());
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    context.after(() => { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); });
  }
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let settled = false;
  const answer = escapable((config) => select({ message: '完整说明', choices: [{ value: false, name: '取消' }] }, { ...config, input, output }));
  void answer.then(() => { settled = true; });
  await tick();
  input.write('?');
  await tick();
  const escape = { name: 'escape', ctrl: false, shift: false };
  process.stdin.emit('keypress', '', escape);
  input.emit('keypress', '', escape);
  await tick();
  assert.equal(settled, false);
  process.stdin.emit('keypress', '', escape);
  assert.equal(await answer, BACK);
});

test('分页不留下孤立的分组标题，账号计数不含分隔符和返回', () => {
  const choices = [...Array.from({ length: 14 }, (_, value) => ({ value: value as number | null, name: `账号 ${value + 1}` })),
    new Separator('操作'), { value: null, name: '返回' }];
  const config = { message: '选择账号', choices, searchable: true };
  for (const rows of [10, 12, 15, 16, 24]) for (let active = 0; active < choices.length; active++) {
    if (Separator.isSeparator(choices[active])) continue;
    const layout = selectLayout(config, { active, query: '', error: '' }, 40, rows);
    assert.ok(!Separator.isSeparator(layout.page.at(-1)?.item));
    if (layout.indicator) assert.match(layout.indicator, /14/u);
    assert.ok(layout.page.some(({ index }) => index === active));
  }
});

test('短终端的完整账户信息页保留身份与两种额度数字，详情仍可查看全部时间', () => {
  const info = { email: alice.email, planType: 'plus', expiresAt: '2030-12-15T15:59:00Z',
    fiveHour: { remainingPercent: 68, resetsAt: '2030-12-16T00:00:00Z' }, weekly: { remainingPercent: 42, resetsAt: '2030-12-19T00:00:00Z' } };
  for (const columns of [24, 32, 40, 80]) for (const rows of [8, 9, 10, 12, 16, 24]) {
    const config = { message: renderAccountInfo(info, 0, columns - 1), compactMessage: accountSummary(info, columns),
      choices: [{ value: 'refresh', name: '刷新' }, { value: 'back', name: '返回' }] };
    const text = stripVTControlCharacters(renderSelect(config, { active: 0, query: '', error: '' }, columns, rows));
    assert.ok(text.includes('al***ce@e***') && text.includes('68%') && text.includes('42%'), text);
    assert.ok(text.split('\n').length < rows, `${columns}×${rows}: ${text}`);
    for (const line of text.split('\n')) assert.ok(displayWidth(line) < columns, line);
    const full = selectLayout(config, { active: 0, query: '', error: '', reading: true }, columns, rows).fullText.join('\n');
    assert.match(full, /2030-12-\d{2}/u);
    assert.match(full, /重置/u);
  }
});

test('长说明、短说明和返回不会改变页面划分，连续前后翻页可回到原项', async (context) => {
  for (const [key, value] of [['columns', 40], ['rows', 16]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
    Object.defineProperty(process.stdout, key, { value, configurable: true });
    context.after(() => { if (descriptor) Object.defineProperty(process.stdout, key, descriptor); else Reflect.deleteProperty(process.stdout, key); });
  }
  const choices = [...Array.from({ length: 14 }, (_, value) => ({ value: value as number | null, name: `重置卡 ${value + 1}`,
    description: '卡片说明：用于重置 Codex 的五小时和每周用量，获得与到期时间会在确认前显示。' })), { value: null, name: '返回', description: '重新选择账号' }];
  const config = { message: 'codexplus / 使用重置卡\n选择一张卡', choices, pageSize: 10 };
  const pages = selectLayout(config, { active: 0, query: '', error: '' }, 40, 16).pages;
  for (let active = 0; active < choices.length; active++) {
    assert.deepEqual(selectLayout(config, { active, query: '', error: '' }, 40, 16).pages, pages);
  }
  const prompt = harness(config);
  for (const key of ['\x1b[6~', '\x1b[6~', '\x1b[5~', '\x1b[5~']) await prompt.key(key);
  await prompt.key('\r');
  assert.equal(await prompt.answer, 0);
  const back = harness(config);
  for (const key of ['\x1b[F', '\x1b[5~', '\x1b[6~', '\r']) await back.key(key);
  assert.equal(await back.answer, null);
});

test('短确认页优先显示全部选择，裁剪按段落处理并且不重复文字', () => {
  const message = 'codexplus / 解决版本冲突\nal***ce@e*** 的版本不一致\n  本机刷新时间：2026-11-15T08:00:00Z\n  服务端刷新时间：2026-11-14T08:00:00Z\n  无法比较哪份更新，覆盖可能替换仍可用的凭证。';
  const choices = [{ value: 'local', name: '覆盖账号库' }, { value: 'server', name: '覆盖本机' }, { value: 'back', name: '返回' }];
  for (const columns of [24, 30, 40, 60]) for (const rows of [8, 9, 10, 12, 14, 15]) {
    const config = { message, choices };
    const layout = selectLayout(config, { active: 2, query: '', error: '' }, columns, rows);
    assert.equal(layout.page.length, 3);
    const text = stripVTControlCharacters(renderSelect(config, { active: 2, query: '', error: '' }, columns, rows));
    assert.ok(text.split('\n').length < rows, `${columns}×${rows}\n${text}`);
    for (const name of ['覆盖账号库', '覆盖本机', '返回']) assert.ok(text.includes(name), text);
    assert.equal(new Set(layout.header).size, layout.header.length);
    for (let index = 0; index < layout.header.length; index++) {
      if (layout.header[index]!.endsWith('刷新时间：')) assert.match(layout.header[index + 1] ?? '', /2026-11-\d{2}T08:00:00Z/u);
    }
  }
  assert.deepEqual(clipHeader('首段\n第二段\n最后一句很长的警告', 12, 2), ['首段', '最后一句很…']);
});

test('未登录和无效文件的紧凑首页只显示一次状态', () => {
  for (const current of [{ status: 'none' }, { status: 'invalid', reason: '无法解析文件' }] as const) {
    for (const columns of [24, 40, 80]) for (const rows of [8, 10, 12, 15]) {
      const menu = mainChoices([], current);
      const text = stripVTControlCharacters(renderSelect({ message: renderHome(current, 0, '0.1.0', columns), compactMessage: homeSummary(current, 0),
        choices: menu.choices }, { active: 1, query: '', error: '' }, columns, rows));
      const status = current.status === 'none' ? '未登录' : '登录文件无效';
      assert.equal(text.split('\n').filter((line) => line === status).length, 1, text);
      assert.ok(text.split('\n').length < rows, text);
      assert.equal(text.match(/Ctrl\+O/gu)?.length, 1, text);
    }
  }
});

test('长卡片标题可在详情中完整查看，短标签保持原操作值', async () => {
  const name = '专用于 Codex 的长名称重置卡'.repeat(8) + '唯一结尾';
  const config = { message: '选择重置卡', choices: [{ value: 'card', name }] };
  const primary = stripVTControlCharacters(renderSelect(config, { active: 0, query: '', error: '' }, 40, 16));
  assert.ok(!primary.includes('唯一结尾'));
  const prompt = harness(config);
  await prompt.key('\x0f');
  await prompt.key('\x1b[F');
  assert.ok(prompt.screen().includes('唯一结尾'));
  await prompt.key('\r');
  await prompt.key('\r');
  assert.equal(await prompt.answer, 'card');
});

test('说明截断不会把悬挂缩进拼进正文，省略号前不留空格', () => {
  for (const description of ['这张卡可以立即重置当前五小时窗口和每周用量。'.repeat(20), 'The Codex server will restart. '.repeat(20)]) {
    const config = { message: '使用重置卡', choices: [{ value: 'card', name: '重置卡', description }, { value: null, name: '返回' }] };
    const layout = selectLayout(config, { active: 0, query: '', error: '' }, 40, 12);
    const last = layout.detailLines.at(-1)!;
    assert.ok(last.startsWith('  '));
    assert.ok(last.endsWith('…'));
    assert.doesNotMatch(last.slice(2), / {2}|\s…/u);
    assert.ok(description.includes(last.slice(2, -1)));
    assert.ok(displayWidth(last) < 40);
  }
});

test('宽而矮的终端保留完整按键说明和可容纳的选项描述', () => {
  const config = { message: '确认删除？\n删除后无法恢复。', theme: { escapeLabel: '取消' },
    choices: [{ value: false, name: '取消', description: '保留该账号' }, { value: true, name: '删除', description: '从账号库移除保存的凭证' }] };
  const text = stripVTControlCharacters(renderSelect(config, { active: 1, query: '', error: '' }, 100, 9));
  assert.match(text, /Esc 取消/u);
  assert.match(text, /Ctrl\+O 说明/u);
  assert.match(text, /从账号库移除保存的凭证/u);
  assert.ok(text.split('\n').length < 9);
});

test('位置摘要分别保留服务类型和完整回环地址，不按文件路径缩略', () => {
  for (const kind of ['自带', '独立']) for (const columns of [24, 40]) {
    const text = locationSummary('/tmp/vault', '/tmp/codex/auth.json', `${kind}服务端 http://127.0.0.1:47831`, columns);
    assert.ok(text.includes(`本机服务 ${kind}`));
    assert.ok(text.includes('127.0.0.1:47831'));
    for (const line of text.split('\n')) assert.ok(displayWidth(line) < columns);
  }
});

test('翻页与渲染共用可视页大小，分隔行不会成为焦点', () => {
  const choices = Array.from({ length: 30 }, (_, value) => ({ value, name: `账号 ${value + 1}` }));
  const config = { message: '选择账号', choices: [...choices.slice(0, 9), new Separator('其他'), ...choices.slice(9)] };
  const state = { active: 0, query: '', error: '' };
  for (const rows of [10, 12, 16, 24]) {
    const layout = selectLayout(config, state, 40, rows);
    const target = pageTarget(config, state, 40, rows, 1);
    assert.ok(!Separator.isSeparator(config.choices[target]));
    assert.ok(target >= layout.pageSize);
    const next = selectLayout(config, { ...state, active: target }, 40, rows);
    assert.ok(next.start > layout.start);
    assert.ok(next.page.some(({ index }) => index === target));
  }
});

test('位置页摘要省略长路径，完整说明保留原始的隐私处理路径', () => {
  const home = '/Users/sy***er/' + 'directory/'.repeat(20);
  const authPath = `${home}codex/auth.json`;
  const config = { message: renderLocations(home, authPath, 'http://127.0.0.1:47831'),
    compactMessage: locationSummary(home, authPath, 'http://127.0.0.1:47831', 40), choices: [{ value: 'back', name: '返回' }] };
  const state = { active: 0, query: '', error: '' };
  const text = stripVTControlCharacters(renderSelect(config, state, 40, 16));
  assert.ok(text.includes('…'));
  const full = selectLayout(config, state, 40, 16).fullText.join('');
  assert.ok(full.includes(authPath));
  assert.ok(!full.includes('…'));
});
