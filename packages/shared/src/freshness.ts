export function newerRefresh(local: unknown, server: unknown): 'local' | 'server' | null {
  const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : NaN;
  const left = timestamp(local);
  const right = timestamp(server);
  return !Number.isFinite(left) || !Number.isFinite(right) || left === right ? null : left > right ? 'local' : 'server';
}
