import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { credentialDirectory, expandPath, isRecord, readOptional, writeAtomic } from '@weiguangchao/codexplus-shared';
import type { Credential } from '@weiguangchao/codexplus-shared';

async function readConfig(userHome: string, env: NodeJS.ProcessEnv): Promise<{ path: string; content: string } | null> {
  const override = env.CODEXBAR_CONFIG?.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const xdgHome = xdg === '~' || xdg?.startsWith('~/') ? expandPath(userHome, xdg) : xdg;
  const paths = override ? [expandPath(userHome, override)]
    : xdgHome && isAbsolute(xdgHome) ? [join(xdgHome, 'codexbar', 'config.json')]
      : [join(userHome, '.config', 'codexbar', 'config.json'), join(userHome, '.codexbar', 'config.json')];
  for (const path of paths) {
    const content = await readOptional(path);
    if (content !== null) return { path, content };
  }
  return null;
}

export async function syncCodexBar({ userHome, home, credentials, currentEmail, env = process.env }: {
  userHome: string;
  home: string;
  credentials: Credential[];
  currentEmail: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const saved = await readConfig(userHome, env);
  if (saved === null || !saved.content.trim()) return;
  let config: unknown;
  try { config = JSON.parse(saved.content); } catch {
    throw new Error(`${saved.path} 不是有效的 JSON，已有文件未被覆盖。`);
  }
  if (!isRecord(config) || config.version !== 1 || !Array.isArray(config.providers) ||
    !config.providers.every((entry: unknown) => isRecord(entry) && typeof entry.id === 'string' &&
      (entry.enabled == null || typeof entry.enabled === 'boolean'))) {
    throw new Error(`${saved.path} 格式无效，已有文件未被覆盖。`);
  }
  const provider = config.providers.find((entry: unknown) => isRecord(entry) && entry.id === 'codex');
  if (!isRecord(provider)) return;
  const paths: unknown = provider.codexProfileHomePaths ?? [];
  if (!Array.isArray(paths) || !paths.every((path: unknown): path is string => typeof path === 'string')) {
    throw new Error(`${saved.path} 的 codexProfileHomePaths 格式无效，已有文件未被覆盖。`);
  }
  const root = resolve(home, 'credentials');
  const manual = paths.filter((path) => {
    const expanded = expandPath(userHome, path);
    return dirname(expanded) !== root || !basename(expanded).startsWith('codex-');
  });
  const next = [...manual, ...credentials.filter(({ email }) => email !== currentEmail)
    .map(({ email }) => join(root, credentialDirectory(email)))];
  if (JSON.stringify(paths) === JSON.stringify(next)) return;
  provider.codexProfileHomePaths = next;
  await writeAtomic(saved.path, `${JSON.stringify(config, null, 2)}\n`);
}
