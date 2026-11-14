import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Manifest {
  name: string;
  version: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
}

interface Lockfile {
  version: string;
  packages: Record<string, Manifest>;
}

export async function prepareRelease(root: string, tag: string): Promise<string> {
  if (!/^v0\.1\.(0|[1-9]\d*)$/u.test(tag) || !Number.isSafeInteger(Number(tag.slice(5)))) {
    throw new Error('发布标签必须为 v0.1.x，x 为不带前导零的非负整数。');
  }
  const version = tag.slice(1);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest;
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as Lockfile;
  const workspaces = await Promise.all((manifest.workspaces ?? []).map(async (directory) => ({
    directory,
    manifest: JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8')) as Manifest,
  })));
  const names = new Set(workspaces.map((entry) => entry.manifest.name));
  const entries = [{ directory: '', manifest }, ...workspaces];
  for (const entry of entries) {
    const locked = lock.packages[entry.directory];
    if (!locked) throw new Error(`package-lock.json 缺少工作区：${entry.directory || '根目录'}`);
    entry.manifest.version = version;
    locked.version = version;
    for (const name of Object.keys(entry.manifest.dependencies ?? {})) {
      if (names.has(name)) {
        entry.manifest.dependencies![name] = version;
        locked.dependencies = { ...locked.dependencies, [name]: version };
      }
    }
  }
  lock.version = version;
  for (const entry of entries) {
    await writeFile(join(root, entry.directory, 'package.json'), `${JSON.stringify(entry.manifest, null, 2)}\n`);
  }
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`发布版本：${await prepareRelease(process.cwd(), process.argv[2] ?? '')}`);
}
