import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请从仓库根目录运行 npm run test:package。');
const temporary = await mkdtemp(join(tmpdir(), 'codexplus-package-'));
const prefix = join(temporary, 'prefix');
const env = { ...process.env, CODEX_HOME: join(temporary, 'codex') };
const npm = (args: string[], cwd = temporary) => execFileSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8' }).trim();
try {
  const packages = JSON.parse(npm(['pack', '--workspaces', '--json', '--pack-destination', temporary], process.cwd())) as {
    name: string;
    filename: string;
    files: { path: string }[];
  }[];
  for (const packed of packages) {
    assert.ok(packed.files.some((file) => file.path.startsWith('dist/')), `${packed.name} 缺少构建产物，请先运行 npm run build。`);
    assert.ok(packed.files.every((file) => file.path === 'package.json' || file.path.startsWith('dist/') || /^(?:README|LICENSE)/u.test(file.path)), `${packed.name} 包含非发布文件。`);
  }
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...packages.map((packed) => join(temporary, packed.filename))]);
  const installed = npm(['root', '--global', '--prefix', prefix]);
  for (const packed of packages) {
    assert.equal((await lstat(join(installed, packed.name))).isSymbolicLink(), false);
  }
  const run = (name: string, args: string[]) => execFileSync(process.execPath, [join(installed, '@codexplus', name, 'dist', 'cli.js'), ...args], { cwd: temporary, env, encoding: 'utf8' });
  assert.match(run('tui', ['--help']), /codexplus status/u);
  assert.match(run('app-server', ['--help']), /codexplus-server/u);
  assert.match(run('tui', ['status', '--home', join(temporary, 'data')]), /本地模式/u);
  console.log('发布包安装验证通过：独立安装三个 tarball，客户端与服务端可启动。');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
