import { z } from 'zod';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOptional, writeAtomic, withLock, emailSchema, writeError } from '@weiguangchao/codexplus-shared';

const auditEntrySchema = z.object({
  time: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  event: z.enum(['下载', '上传', '删除', '切换', '重置']),
  clientId: z.string(), clientName: z.string(), email: emailSchema.optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

type Actor = { id: string; name: string };

export async function recordAudit({ home, event, client, subject = {} }: { home: string; event: AuditEntry['event']; client: Actor; subject?: Pick<AuditEntry, 'email'> | undefined }): Promise<void> {
  await withLock({ home, fn: async () => {
    const path = join(home, 'audit.log');
    const entry: AuditEntry = { time: new Date().toISOString(), event, clientId: client.id, clientName: client.name,
      ...(subject.email ? { email: subject.email } : {}) };
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    if (lines.length > 1000) await writeAtomic({ path, content: `${lines.slice(-1000).join('\n')}\n` });
  } });
}

export async function readAudit({ home, limit = 50 }: { home: string; limit?: number | undefined }): Promise<AuditEntry[]> {
  return await withLock({ home, fn: async () => {
    const content = await readOptional(join(home, 'audit.log'));
    if (!content?.trim()) return [];
    try { return content.trim().split('\n').slice(-limit).map((line) => auditEntrySchema.parse(JSON.parse(line))); }
    catch { throw new Error('操作记录格式无效。'); }
  } });
}

export async function recordCommitted(options: Parameters<typeof recordAudit>[0]): Promise<void> {
  try {
    await recordAudit(options);
  } catch {
    writeError(JSON.stringify({ event: 'audit_write_failed', home: options.home, action: options.event,
      message: '操作已完成，但未能写入操作记录，请检查服务端目录的文件权限和磁盘空间。' }));
  }
}
