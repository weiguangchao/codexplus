import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { test } from 'node:test';

test('lint 强制拒绝行注释、块注释、JSDoc 和 eslint-disable', async () => {
  const eslint = new ESLint();
  for (const code of ['// forbidden', '/* forbidden */', '/** forbidden */', '// eslint-disable\n// forbidden']) {
    const results = await eslint.lintText(code, { filePath: 'src/probe.ts' });
    assert.ok(results.some((result) => result.messages.some((message) => message.ruleId === 'local/no-comments')));
  }
});

test('lint 允许 CLI 的解释器声明和字符串中的 URL', async () => {
  const eslint = new ESLint();
  const results = await eslint.lintText('#!/usr/bin/env node\nexport const url = "https://chatgpt.com";\n', { filePath: 'src/probe.ts' });
  assert.equal(results[0]?.errorCount, 0);
});

for (const filePath of ['src/probe.js', 'src/probe.ts']) {
  const code = Array.from({ length: 500 }, (_, index) => `export const line${index} = ${index};`).join('\n');

  test(`lint 允许 ${filePath} 恰好 500 行`, async () => {
    const eslint = new ESLint();
    for (const ending of ['', '\n']) {
      const results = await eslint.lintText(code + ending, { filePath });
      assert.equal(results[0]?.errorCount, 0);
    }
  });

  test(`lint 拒绝 ${filePath} 超过 500 行，包括空行`, async () => {
    const eslint = new ESLint();
    for (const extraLine of ['export const overflow = true;', '']) {
      const results = await eslint.lintText(`${code}\n${extraLine}\n`, { filePath });
      const messages = results[0]?.messages.filter((message) => message.ruleId === 'max-lines');
      assert.equal(messages?.length, 1);
      assert.equal(messages[0]?.severity, 2);
    }
  });
}
