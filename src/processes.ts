import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface CodexProcess {
  pid: number;
  command: string;
}

type RunCommand = (command: string, args: string[]) => Promise<string>;

const execute = promisify(execFile);

const runCommand: RunCommand = async (command, args) => {
  const { stdout } = await execute(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
};

export async function findCodexProcesses(
  platform = process.platform,
  run: RunCommand = runCommand,
): Promise<CodexProcess[]> {
  try {
    const windows = platform === 'win32';
    const output = windows
      ? await run('tasklist.exe', ['/FI', 'IMAGENAME eq codex.exe', '/FO', 'CSV', '/NH'])
      : await run('ps', ['-A', '-o', 'pid=', '-o', 'comm=']);
    const processes: CodexProcess[] = [];
    for (const line of output.split(/\r?\n/u)) {
      const match = windows
        ? /^"([^"]+)","(\d+)",/u.exec(line.trim())
        : /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
      if (!match) {
        continue;
      }
      const command = (windows ? match[1] : match[2])?.split(/[\\/]/u).at(-1) ?? '';
      const pid = Number(windows ? match[2] : match[1]);
      if (/^codex(?:\.exe)?$/iu.test(command) && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
        processes.push({ pid, command });
      }
    }
    return processes.toSorted((left, right) => left.pid - right.pid);
  } catch {
    throw new Error('无法检测 Codex 进程，未切换账号。请确认系统允许查询进程后重试。');
  }
}
