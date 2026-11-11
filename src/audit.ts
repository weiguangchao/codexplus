import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOptional, writeAtomic } from './files.js';
import { withLock } from './lock.js';

export interface AuditEntry {
  time: string;
  event: '下载' | '上传' | '删除' | '配对' | '撤销';
  clientId: string;
  clientName: string;
  email?: string;
}

export async function recordAudit(home: string, event: AuditEntry['event'], client: { id: string; name: string }, email?: string): Promise<void> {
  await withLock(home, async () => {
    const path = join(home, 'audit.log');
    const entry: AuditEntry = { time: new Date().toISOString(), event, clientId: client.id, clientName: client.name, ...(email ? { email } : {}) };
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
