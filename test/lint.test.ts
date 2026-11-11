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
