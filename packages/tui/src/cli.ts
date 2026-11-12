#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { isRecord, PairingCancelled } from '@codexplus/shared';
import { CredentialClient } from './client.js';
import { parseCommand, usage } from './options.js';
import { menu } from './flows.js';
import { askPairing, askRepair, confirmRestore, confirmUpload, isCancel, retryPairing } from './prompts.js';
import { cancelled, line, renderTitle, report, symbols } from './ui.js';

function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === 'help') {
    console.log(usage);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('请在交互式终端中运行 codexplus。');
  }

  console.log(renderTitle(readVersion()));
  const client = new CredentialClient({ home: command.home });
  const store = await client.connect({
    ...(command.target === undefined ? {} : { target: command.target }),
    askPairing,
    retryPairing,
    askRepair,
    log: (message) => report(symbols.info, message),
  });
  store.confirmUpload = confirmUpload;
  store.confirmRestore = confirmRestore;
  try {
    await menu(store);
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PairingCancelled) {
    report(symbols.info, error.message);
    return;
  }
  if (isCancel(error)) {
    cancelled();
    return;
  }
  console.error(line(symbols.failure, styleText('red', `错误：${error instanceof Error ? error.message : '操作失败，请重试。'}`)));
  process.exitCode = 1;
});
