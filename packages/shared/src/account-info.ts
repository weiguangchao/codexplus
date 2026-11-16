import { z } from 'zod';

const dateSchema = z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable();
const quotaWindowSchema = z.object({ remainingPercent: z.number().min(0).max(100), resetsAt: dateSchema });
const accountInfoSchema = z.object({ email: z.string().nullable(), planType: z.string().refine((value) => value.trim().length > 0),
  expiresAt: dateSchema, fiveHour: quotaWindowSchema.nullable(), weekly: quotaWindowSchema.nullable() });

export type QuotaWindow = z.infer<typeof quotaWindowSchema>;
export type AccountInfo = z.infer<typeof accountInfoSchema>;

export function parseAccountInfo(value: unknown): AccountInfo {
  const result = accountInfoSchema.safeParse(value);
  if (!result.success) throw new Error('账户信息格式无效。');
  return result.data;
}
