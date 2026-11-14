import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOptional, writeAtomic, withLock } from '@weiguangchao/codexplus-shared';

export interface AuditEntry {
  time: string;
  event: '下载' | '上传' | '删除' | '切换';
  clientId: string;
  clientName: string;
  email?: string;
}

type Actor = { id: string; name: string };

export async function recordAudit(home: string, event: AuditEntry['event'], client: Actor, subject: { email?: string } = {}): Promise<void> {
  await withLock(home, async () => {
    const path = join(home, 'audit.log');
    const entry: AuditEntry = { time: new Date().toISOString(), event, clientId: client.id, clientName: client.name,
      ...(subject.email ? { email: subject.email } : {}) };
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const lines = (await readOptional(path))!.trim().split('\n');
    if (lines.length > 1000) await writeAtomic(path, `${lines.slice(-1000).join('\n')}\n`);
  });
}

export async function readAudit(home: string, limit = 50): Promise<AuditEntry[]> {
  return await withLock(home, async () => {
    const content = await readOptional(join(home, 'audit.log'));
    if (!content?.trim()) return [];
    try { return content.trim().split('\n').slice(-limit).map((line) => JSON.parse(line) as AuditEntry); }
    catch { throw new Error('操作记录格式无效。'); }
  });
}

export async function recordCommitted(...args: Parameters<typeof recordAudit>): Promise<void> {
  try {
    await recordAudit(...args);
  } catch {
    console.error(`操作已完成，但未能写入操作记录（${args[1]}），请检查服务端目录的文件权限和磁盘空间。`);
  }
}
