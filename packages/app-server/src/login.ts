import { z } from 'zod';
import { emailSchema } from '@weiguangchao/codexplus-shared';
import type { Auth, Email } from '@weiguangchao/codexplus-shared';

const claimsSchema = z.object({ email: z.string().trim().pipe(emailSchema) });

export function idTokenEmail(auth: Auth): Email | null {
  return emailFromIdToken(auth.tokens.id_token);
}

export function emailFromIdToken(token: unknown): Email | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return claims.success ? claims.data.email : null;
  } catch { return null; }
}
