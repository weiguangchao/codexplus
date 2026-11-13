import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import process from 'node:process';

const original = childProcess.execFile;
const execute = (...args) => original(...args);
execute[promisify.custom] = async (command, ...args) => {
  if (command === 'ps' || command === 'tasklist.exe') {
    const running = process.env.CODEXPLUS_TEST_RUNNING === '1';
    return { stdout: running ? command === 'ps' ? '  9876 codex\n' : '"codex.exe","9876","Console","1","100 K"\r\n' : '', stderr: '' };
  }
  return await promisify(original)(command, ...args);
};
childProcess.execFile = execute;
syncBuiltinESMExports();
