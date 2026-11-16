import { writeOutput, writeError, isRecord } from '@weiguangchao/codexplus-shared';
import { readFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { CredentialClient } from './client.js';
import { parseCommand, usage } from './options.js';
import { menu } from './flows.js';
import { confirmRestore, confirmUpload, isCancel, requireInteractive } from './prompts.js';
import { cancelled, line, symbols } from './ui.js';

function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

export async function runCli({ home }: { home?: string } = {}): Promise<void> {
  try {
    const command = parseCommand(process.argv.slice(2));
    if (command.kind === 'help') {
      writeOutput(usage);
      return;
    }
    requireInteractive();
    const client = new CredentialClient(home === undefined ? {} : { home });
    const store = await client.connect({ log: (message) => writeError(line(symbols.info, message)) });
    store.confirmUpload = confirmUpload;
    store.confirmRestore = confirmRestore;
    try {
      await menu({ store, version: readVersion() });
    } finally {
      await store.close();
    }
  } catch (error) {
    if (isCancel(error)) {
      cancelled();
      return;
    }
    writeError(line(symbols.failure, styleText('red', `错误：${error instanceof Error ? error.message : '操作失败，请重试。'}`)));
    process.exitCode = 1;
  }
}
