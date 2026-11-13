import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { runAdmin } from '../src/serve.js';
import { temporaryHome } from './helpers.js';

for (const action of ['log'] as const) {
  test(`${action} 拒绝不存在的目录和普通文件，不创建任何文件`, async (context) => {
    const parent = await temporaryHome(context);
    const missing = join(parent, 'missing', 'nested');
    const file = join(parent, 'file');
    await writeFile(file, 'unchanged');
    for (const home of [missing, file, join(file, 'nested')]) {
      const messages: string[] = [];
      await assert.rejects(runAdmin({ kind: 'admin', action, home: relative(process.cwd(), home) }, (message) => messages.push(message)), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(resolve(home)));
        assert.match(error.message, /检查 --home 或先运行 codexplus-server/u);
        return true;
      });
      assert.deepEqual(messages, []);
    }
    await assert.rejects(stat(join(parent, 'missing')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(parent), ['file']);
    assert.equal(await readFile(file, 'utf8'), 'unchanged');
  });

  test(`${action} 在已存在的空目录中保持原有行为`, async (context) => {
    const parent = await temporaryHome(context);
    const home = join(parent, 'empty');
    await mkdir(home);
    const messages: string[] = [];
    const command = { kind: 'admin' as const, action, home };
    await runAdmin(command, (message) => messages.push(message));
    assert.match(messages.join('\n'), /暂无操作记录/u);
    assert.equal((await stat(home)).isDirectory(), true);
  });
}
