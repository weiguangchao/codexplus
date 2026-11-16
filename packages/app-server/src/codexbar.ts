import { z } from 'zod';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { credentialDirectory, expandPath, readOptional, writeAtomic } from '@weiguangchao/codexplus-shared';
import type { Credential } from '@weiguangchao/codexplus-shared';

const configSchema = z.looseObject({ version: z.literal(1), providers: z.array(z.looseObject({
  id: z.string(), enabled: z.boolean().nullish(), codexProfileHomePaths: z.unknown().optional(),
})) });

async function readConfig({ userHome, env }: { userHome: string; env: NodeJS.ProcessEnv }): Promise<{ path: string; content: string } | null> {
  const override = env.CODEXBAR_CONFIG?.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const xdgHome = xdg === '~' || xdg?.startsWith('~/') ? expandPath({ home: userHome, path: xdg }) : xdg;
  const paths = override ? [expandPath({ home: userHome, path: override })]
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
  const saved = await readConfig({ userHome, env });
  if (saved === null || !saved.content.trim()) return;
  let config: unknown;
  try { config = JSON.parse(saved.content); } catch {
    throw new Error(`${saved.path} 不是有效的 JSON，已有文件未被覆盖。`);
  }
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error(`${saved.path} 格式无效，已有文件未被覆盖。`);
  const provider = parsed.data.providers.find((entry) => entry.id === 'codex');
  if (!provider) return;
  const parsedPaths = z.array(z.string()).safeParse(provider.codexProfileHomePaths ?? []);
  if (!parsedPaths.success) throw new Error(`${saved.path} 的 codexProfileHomePaths 格式无效，已有文件未被覆盖。`);
  const paths = parsedPaths.data;
  const root = resolve(home, 'credentials');
  const manual = paths.filter((path) => {
    const expanded = expandPath({ home: userHome, path });
    return dirname(expanded) !== root || !basename(expanded).startsWith('codex-');
  });
  const next = [...manual, ...credentials.filter(({ email }) => email !== currentEmail)
    .map(({ email }) => join(root, credentialDirectory(email)))];
  if (JSON.stringify(paths) === JSON.stringify(next)) return;
  provider.codexProfileHomePaths = next;
  await writeAtomic({ path: saved.path, content: `${JSON.stringify(parsed.data, null, 2)}\n` });
}
