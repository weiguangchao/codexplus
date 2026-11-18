import { z } from 'zod';
import { authDigestSchema, emailSchema } from './identity.js';

export const antigravityAccountSchema = z.object({ email: emailSchema, digest: authDigestSchema });
export const antigravityStatusSchema = z.object({
  authPath: z.string(),
  current: z.discriminatedUnion('status', [
    z.object({ status: z.literal('none'), digest: z.null() }),
    z.object({ status: z.literal('invalid'), digest: authDigestSchema }),
    antigravityAccountSchema.extend({ status: z.literal('valid') }),
  ]),
  accounts: z.array(antigravityAccountSchema),
});

export type AntigravityAccount = z.infer<typeof antigravityAccountSchema>;
export type AntigravityStatus = z.infer<typeof antigravityStatusSchema>;
