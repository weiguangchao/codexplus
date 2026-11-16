#!/usr/bin/env node
import { writeOutput, writeError, isRecord } from '@weiguangchao/codexplus-shared';
import { readFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { CredentialClient } from './client.js';
import { parseCommand, usage } from './options.js';
import { menu, switchAccount } from './flows.js';
import { confirmRestore, confirmUpload, isCancel, requireInteractive } from './prompts.js';
import { cancelled, line, maskEmail, maskHomePath, renderStatus, symbols } from './ui.js';

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
    writeOutput(usage);
    return;
  }
  if (command.kind === 'client' || command.kind === 'switch' && command.email === undefined) {
    requireInteractive();
  }

  const client = new CredentialClient({ home: command.home });
  const store = await client.connect({
    ...(command.port === undefined ? {} : { port: command.port }),
    log: (message) => writeError(line(symbols.info, message)),
  });
  store.confirmUpload = confirmUpload;
  store.confirmRestore = confirmRestore;
  try {
    if (command.kind === 'client') {
      await menu({ store, version: readVersion() });
    } else if (command.kind === 'switch') {
      await switchAccount({ store, email: command.email });
    } else {
      const credentials = await store.list();
      const current = await store.current();
      if (command.kind === 'status') {
        writeOutput(store.server === 'local' ? `数据目录  ${maskHomePath({ path: store.home, userHome: store.userHome })}` : `服务地址  ${store.url}`);
        const authPath = maskHomePath({ path: store.codexAuthPath, userHome: store.userHome });
        writeOutput(`登录文件  ${authPath}`);
        writeOutput(renderStatus(current, credentials.length, authPath));
      } else if (credentials.length === 0) {
        writeOutput('暂无已保存的账号。');
      } else {
        for (const credential of credentials) {
          const active = 'email' in current && current.email === credential.email;
          const broken = store.snapshotDigest(credential.email) === null;
          writeOutput(`${maskEmail(credential.email)}${active ? '  ← 当前' : ''}${broken ? '  凭证文件缺失或损坏' : ''}`);
        }
      }
    }
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  if (isCancel(error)) {
    cancelled();
    return;
  }
  writeError(line(symbols.failure, styleText('red', `错误：${error instanceof Error ? error.message : '操作失败，请重试。'}`)));
  process.exitCode = 1;
});
