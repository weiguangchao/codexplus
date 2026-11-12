#!/usr/bin/env node
import { styleText } from 'node:util';
import { parseServerCommand, serverUsage } from './options.js';
import { runAdmin, runServe } from './serve.js';

async function main(): Promise<void> {
  const command = parseServerCommand(process.argv.slice(2));
  if (command.kind === 'help') {
    console.log(serverUsage);
  } else if (command.kind === 'serve') {
    await runServe(command);
  } else {
    await runAdmin(command);
  }
}

main().catch((error: unknown) => {
  console.error(styleText('red', `错误：${error instanceof Error ? error.message : '操作失败，请重试。'}`));
  process.exitCode = 1;
});
