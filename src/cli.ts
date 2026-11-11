#!/usr/bin/env node
import { input, select } from '@inquirer/prompts';
import { CredentialStore } from './store.js';
import { switchCredential } from './switch.js';

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error('请直接运行 codexplus，通过菜单添加或切换凭证。');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('请在交互式终端中运行 codexplus。');
  }

  const action = await select({
    message: 'codexplus',
    choices: [
      { name: '添加凭证', value: 'add' },
      { name: '切换凭证', value: 'switch' },
    ],
  });
  const store = new CredentialStore();

  if (action === 'add') {
    const path = await input({
      message: 'auth.json 文件路径',
      default: '~/.codex/auth.json',
      validate: (value) => value.trim().length > 0 || '请输入文件路径。',
    });
    const credential = await store.add(path);
    console.log(`已保存凭证：${credential.email}`);
    return;
  }

  const credentials = await store.list();
  if (credentials.length === 0) {
    console.log('还没有保存的凭证，请先选择“添加凭证”。');
    return;
  }
  const credential = await select({
    message: '选择要切换的账号',
    choices: credentials.map((entry) => ({ name: entry.email, value: entry })),
  });
  await switchCredential(store, credential);
}

main().catch((error: unknown) => {
  if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
    console.log('已取消。');
    return;
  }
  console.error(`错误：${error instanceof Error ? error.message : '操作失败，请重试。'}`);
  process.exitCode = 1;
});
