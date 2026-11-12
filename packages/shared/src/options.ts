import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

export function resolveHome(value: string | undefined): string {
  const home = value ?? join(homedir(), '.codexplus');
  if (!home.trim()) {
    throw new Error('--home 需要指定目录路径。');
  }
  return home === '~' ? homedir() : home.startsWith('~/') ? resolve(homedir(), home.slice(2)) : resolve(home);
}

export function parseOptions<T extends ParseArgsOptionsConfig>(program: string, args: string[], options: T) {
  for (const arg of args) {
    if (arg === '--') break;
    const name = arg.startsWith('--') ? arg.slice(2).split('=')[0] : undefined;
    if (name && !Object.hasOwn(options, name)) {
      throw new Error(`--${name} 不能用于此命令，请运行 ${program} --help。`);
    }
  }
  const parsed = parseArgs({ args, allowPositionals: true, options });
  const allow = (...names: string[]): void => {
    const extra = Object.keys(parsed.values).find((name) => !names.includes(name));
    if (extra) {
      throw new Error(`--${extra} 不能用于此命令，请运行 ${program} --help。`);
    }
  };
  return { ...parsed, allow };
}
