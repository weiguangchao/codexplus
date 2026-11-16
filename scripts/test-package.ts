import { z } from 'zod';
import { writeOutput } from '@weiguangchao/codexplus-shared';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请从仓库根目录运行 npm run test:package。');
const temporary = await mkdtemp(join(tmpdir(), 'codexplus-package-'));
const prefix = join(temporary, 'prefix');
const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporary, USERPROFILE: temporary, CODEX_HOME: join(temporary, 'codex'), NO_COLOR: '1' };
delete env.FORCE_COLOR;
const npm = (args: string[], cwd = temporary) => execFileSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8' }).trim();
try {
  const packages = z.array(z.object({ name: z.string(), filename: z.string(), files: z.array(z.object({ path: z.string() })) }))
    .parse(JSON.parse(npm(['pack', '--workspaces', '--json', '--pack-destination', temporary], process.cwd())));
  for (const packed of packages) {
    assert.ok(packed.files.some((file) => file.path.startsWith('dist/')), `${packed.name} 缺少构建产物，请先运行 npm run build。`);
    assert.ok(packed.files.every((file) => file.path === 'package.json' || file.path.startsWith('dist/') || /^(?:README|LICENSE)/u.test(file.path)), `${packed.name} 包含非发布文件。`);
  }
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...packages.map((packed) => join(temporary, packed.filename))]);
  const installed = npm(['root', '--global', '--prefix', prefix]);
  for (const packed of packages) {
    assert.equal((await lstat(join(installed, packed.name))).isSymbolicLink(), false);
  }
  const run = (name: string, args: string[]) => execFileSync(process.execPath, [join(installed, name, 'dist', 'cli.js'), ...args], { cwd: temporary, env, encoding: 'utf8' });
  const help = run('@weiguangchao/codexplus', ['--help']);
  assert.match(help, /codexplus --help \| -h/u);
  assert.equal(run('@weiguangchao/codexplus', ['-h']), help);
  assert.match(run('@weiguangchao/codexplus-server', ['--help']), /codexplus-server/u);
  for (const args of [[], ['status'], ['list'], ['switch'], ['--home', join(temporary, 'data')], ['--port', '47831']]) {
    const result = spawnSync(process.execPath, [join(installed, '@weiguangchao/codexplus', 'dist', 'cli.js'), ...args], { cwd: temporary, env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, args.length === 0 ? /交互式终端/u : /codexplus --help/u);
  }
  await assert.rejects(lstat(join(temporary, '.codexplus')), { code: 'ENOENT' });
  writeOutput('发布包安装验证通过：独立安装三个 tarball，帮助入口可用，TUI 拒绝旧命令和非交互启动。');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
