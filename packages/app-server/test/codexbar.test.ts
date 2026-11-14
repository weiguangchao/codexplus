import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readOptional, writeAtomic } from '@codexplus/shared';
import { syncCodexBar } from '../src/codexbar.js';
import { temporaryHome } from './helpers.js';

test('配置路径遵循 CodexBar 的环境变量、XDG 和旧目录优先级', async (context) => {
  const defaults = ['.config/codexbar/config.json', '.codexbar/config.json'];
  const cases: [string, (home: string) => NodeJS.ProcessEnv, string[], string | null][] = [
    ['显式路径', (home) => ({ CODEXBAR_CONFIG: join(home, 'override.json'), XDG_CONFIG_HOME: join(home, 'xdg') }), ['override.json', 'xdg/codexbar/config.json', ...defaults], 'override.json'],
    ['显式 ~/ 路径', () => ({ CODEXBAR_CONFIG: '~/override.json' }), ['override.json', ...defaults], 'override.json'],
    ['绝对 XDG 路径', (home) => ({ XDG_CONFIG_HOME: join(home, 'xdg') }), ['xdg/codexbar/config.json', ...defaults], 'xdg/codexbar/config.json'],
    ['展开 XDG 的 ~/', () => ({ XDG_CONFIG_HOME: '~/xdg' }), ['xdg/codexbar/config.json', ...defaults], 'xdg/codexbar/config.json'],
    ['相对 XDG 被忽略，新目录优先', () => ({ XDG_CONFIG_HOME: 'relative' }), defaults, defaults[0]!],
    ['旧目录', () => ({}), [defaults[1]!], defaults[1]!],
    ['显式路径不存在时不回退', () => ({ CODEXBAR_CONFIG: '~/missing.json' }), defaults, null],
    ['XDG 路径不存在时不回退', (home) => ({ XDG_CONFIG_HOME: join(home, 'missing') }), defaults, null],
  ];
  for (const [name, env, files, selected] of cases) {
    await context.test(name, async (context) => {
      const userHome = await temporaryHome(context);
      const home = join(userHome, '.codexplus');
      const content = '{"version":1,"providers":[{"id":"codex"}]}';
      for (const file of files) await writeAtomic(join(userHome, file), content);
      await syncCodexBar({ userHome, home, credentials: [{ type: 'codex', email: 'other@example.com' }], currentEmail: 'current@example.com', env: env(userHome) });
      for (const file of files) {
        const result = await readFile(join(userHome, file), 'utf8');
        if (file !== selected) assert.equal(result, content);
        else assert.deepEqual(JSON.parse(result).providers[0].codexProfileHomePaths, [join(home, 'credentials', 'codex-other@example.com')]);
      }
      assert.equal(await readOptional(join(userHome, 'missing.json')), null);
      assert.equal(await readOptional(join(userHome, 'missing', 'codexbar', 'config.json')), null);
    });
  }
});
