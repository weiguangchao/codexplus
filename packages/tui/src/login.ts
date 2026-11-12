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

export function newerRefresh(local: unknown, server: unknown): 'local' | 'server' | null {
  const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : NaN;
  const left = timestamp(local);
  const right = timestamp(server);
  return !Number.isFinite(left) || !Number.isFinite(right) || left === right ? null : left > right ? 'local' : 'server';
}
