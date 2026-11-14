import { isRecord } from '@codexplus/shared';

export function idTokenEmail(content: string): string | null {
  try {
    const auth: unknown = JSON.parse(content);
    if (!isRecord(auth) || !isRecord(auth.tokens) || typeof auth.tokens.id_token !== 'string') {
      return null;
    }
    const payload = auth.tokens.id_token.split('.')[1];
    if (!payload) {
      return null;
    }
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(claims) && typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : null;
  } catch {
    return null;
  }
}
