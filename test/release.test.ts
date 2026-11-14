import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRelease } from '../scripts/prepare-release.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codexplus-release-'));
  const directories = ['', 'packages/shared', 'packages/app-server', 'packages/tui'];
  for (const directory of directories) {
    await mkdir(join(root, directory), { recursive: true });
    await copyFile(new URL(`../${directory ? `${directory}/` : ''}package.json`, import.meta.url), join(root, directory, 'package.json'));
  }
  await copyFile(new URL('../package-lock.json', import.meta.url), join(root, 'package-lock.json'));
  return { root, directories };
}

test('标签决定根包、工作区包、内部依赖和 lockfile 的发布版本，外部依赖保持不变', async () => {
  const { root, directories } = await fixture();
  try {
    assert.equal(await prepareRelease(root, 'v0.1.12'), '0.1.12');
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '0.1.12');
    for (const directory of directories) {
      const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
      const original = JSON.parse(await readFile(new URL(`../${directory ? `${directory}/` : ''}package.json`, import.meta.url), 'utf8'));
      assert.equal(manifest.version, '0.1.12');
      assert.equal(lock.packages[directory].version, '0.1.12');
      assert.equal(manifest.private, directory === '' ? true : undefined);
      for (const [name, version] of Object.entries(original.dependencies ?? {})) {
        const expected = name.startsWith('@weiguangchao/codexplus') ? '0.1.12' : version;
        assert.equal(manifest.dependencies[name], expected);
        assert.equal(lock.packages[directory].dependencies[name], expected);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('非法标签在读写文件之前被拒绝', async () => {
  for (const tag of ['', '0.1.0', 'v0.2.0', 'v1.1.0', 'v0.1.01', 'v0.1.-1', 'v0.1.0-beta.1', 'v0.1.0\n', 'v0.1.9007199254740992']) {
    await assert.rejects(prepareRelease('nonexistent-release-root', tag), /发布标签必须为 v0\.1\.x/u);
  }
});
