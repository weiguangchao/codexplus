import { z } from 'zod';
import { emailSchema } from '@weiguangchao/codexplus-shared';
import type { Auth, Email } from '@weiguangchao/codexplus-shared';

const claimsSchema = z.object({ email: z.string().trim().pipe(emailSchema) });

export function idTokenEmail(auth: Auth): Email | null {
  if (typeof auth.tokens.id_token !== 'string') return null;
  const payload = auth.tokens.id_token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return claims.success ? claims.data.email : null;
  } catch { return null; }
}
