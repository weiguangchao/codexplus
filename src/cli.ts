#!/usr/bin/env node
import { input, password, select } from '@inquirer/prompts';
import { hostname } from 'node:os';
import { CredentialClient } from './client.js';
import { parseHome } from './options.js';
import { defaultServerUrl } from './protocol.js';
import { switchCredential } from './switch.js';

async function main(): Promise<void> {
  const home = parseHome(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('请在交互式终端中运行 codexplus。');
  }

  const client = new CredentialClient({ home });
  let connection: string;
  try {
    const current = await client.connection();
    connection = `${current.mode === 'local' ? '本地' : '已配对'} · ${current.url}`;
  } catch {
    connection = '连接配置需修复，请重新配对或选择本地服务端';
  }
  const action = await select({
    message: `codexplus（${connection}）`,
    choices: [
      { name: '添加凭证', value: 'add' },
      { name: '切换凭证', value: 'switch' },
      { name: '配对远程服务端', value: 'pair' },
      { name: '使用本地服务端（免配对）', value: 'local' },
    ],
  });
  if (action === 'pair') {
    const url = await input({ message: '服务端地址（远程使用 HTTPS）', validate: (value) => Boolean(value.trim()) || '请输入服务端地址。' });
    const code = await password({ message: '服务端生成的配对码', mask: true });
    const name = await input({ message: '客户端名称', default: hostname(), validate: (value) => (Boolean(value.trim()) && value.length <= 100) || '请输入名称，最多 100 字符。' });
    await client.pair(url, code, name);
    console.log('配对成功，后续自动认证。请再次运行 codexplus 添加或切换凭证。');
    return;
  }
  if (action === 'local') {
    const url = await input({ message: '本地服务端地址', default: defaultServerUrl });
    await client.useLocal(url);
    console.log('已连接本地服务端，无需配对。');
    return;
  }

  if (action === 'add') {
    const path = await input({
      message: 'auth.json 文件路径',
      default: '~/.codex/auth.json',
      validate: (value) => value.trim().length > 0 || '请输入文件路径。',
    });
    const credential = await client.add(path);
    console.log(`已保存凭证：${credential.email}`);
    return;
  }

  const credentials = await client.list();
  if (credentials.length === 0) {
    console.log('还没有保存的凭证，请先选择“添加凭证”。');
    return;
  }
  const credential = await select({
    message: '选择要切换的账号',
    choices: credentials.map((entry) => ({ name: entry.email, value: entry })),
  });
  await switchCredential(client, credential);
}

main().catch((error: unknown) => {
  if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
    console.log('已取消。');
    return;
  }
  console.error(`错误：${error instanceof Error ? error.message : '操作失败，请重试。'}`);
  process.exitCode = 1;
});
