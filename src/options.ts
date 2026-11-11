import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export function parseHome(args: string[]): string {
  const { values } = parseArgs({
    args,
    options: { home: { type: 'string' } },
    allowPositionals: false,
  });
  const home = values.home ?? join(homedir(), '.codexplus');
  if (!home.trim()) {
    throw new Error('--home 需要指定目录路径。');
  }
  return home === '~' ? homedir() : home.startsWith('~/') ? resolve(homedir(), home.slice(2)) : resolve(home);
}
