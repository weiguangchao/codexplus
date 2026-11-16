import { resolve } from 'node:path';
import { runCli } from '../packages/tui/src/main.js';

await runCli({ home: resolve('.codexplus') });
