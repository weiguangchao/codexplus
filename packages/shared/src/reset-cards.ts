import { z } from 'zod';
import { resetCardIdSchema } from './identity.js';

const dateSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const resetCardSchema = z.object({ id: resetCardIdSchema, resetType: z.string().refine((value) => value.trim().length > 0),
  title: z.string().nullable(), description: z.string().nullable(), grantedAt: dateSchema, expiresAt: dateSchema.nullable() });
const resetCardOutcomeSchema = z.enum(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']);

export type ResetCard = z.infer<typeof resetCardSchema>;
export type ResetCardOutcome = z.infer<typeof resetCardOutcomeSchema>;

export function parseResetCard(value: unknown): ResetCard {
  const result = resetCardSchema.safeParse(value);
  if (!result.success) throw new Error('重置卡信息格式无效。');
  return result.data;
}

export function parseResetCardOutcome(value: unknown): ResetCardOutcome {
  const result = resetCardOutcomeSchema.safeParse(value);
  if (!result.success) throw new Error('重置卡使用结果格式无效。');
  return result.data;
}
