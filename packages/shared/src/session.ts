import { z } from 'zod';
import { authDigestSchema, browserLoginIdSchema, emailSchema } from './identity.js';

export const credentialSchema = z.object({ type: z.literal('codex'), email: emailSchema });
export const saveOptionsSchema = z.object({ base: authDigestSchema.nullable().optional(), restore: z.boolean().optional() });
export type SaveOptions = z.infer<typeof saveOptionsSchema>;

export type SaveRequest = SaveOptions & (
  | { kind: 'credentials.import'; path: string }
  | { kind: 'login.save' }
  | { kind: 'login.browser.save'; id: z.infer<typeof browserLoginIdSchema> }
);

const uploadResultSchema = z.object({ credential: credentialSchema, changed: z.boolean() });
const currentLoginSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('invalid'), reason: z.string() }),
  z.object({ status: z.literal('saved'), email: emailSchema }),
  z.object({ status: z.literal('ahead'), email: emailSchema }),
  z.object({ status: z.literal('behind'), email: emailSchema }),
  z.object({ status: z.literal('diverged'), email: emailSchema }),
  z.object({ status: z.literal('deleted'), email: emailSchema }),
  z.object({ status: z.literal('unsaved'), email: emailSchema.nullable() }),
]);
const snapshotSchema = credentialSchema.extend({ digest: authDigestSchema.nullable(), lastRefresh: z.string().nullable() });
const browserStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), url: z.string(), manual: z.boolean() }),
  z.object({ status: z.literal('complete'), url: z.string(), manual: z.boolean() }),
  z.object({ status: z.literal('error'), url: z.string(), manual: z.boolean(), error: z.string() }),
]);
const conflictSchema = z.object({ code: z.literal('conflict'), email: emailSchema,
  digest: authDigestSchema.nullable(), lastRefresh: z.string().nullable(), localRefresh: z.string().nullable().default(null) });
const restoreSchema = z.object({ code: z.literal('restore_required'), email: emailSchema.nullable() });

export const loginBaselineSchema = z.object({ email: emailSchema, digest: authDigestSchema }).nullable();

export type Credential = z.infer<typeof credentialSchema>;
export type UploadResult = z.infer<typeof uploadResultSchema>;
export type CurrentLogin = z.infer<typeof currentLoginSchema>;
export type CredentialSnapshot = z.infer<typeof snapshotSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type UploadConflict = z.infer<typeof conflictSchema>;

export function parseCredential(value: unknown): Credential {
  const result = credentialSchema.safeParse(value);
  if (!result.success) throw new Error('凭证信息格式无效。');
  return result.data;
}

export function parseUploadResult(value: unknown): UploadResult {
  const result = uploadResultSchema.safeParse(value);
  if (!result.success) throw new Error('服务端保存响应格式无效。');
  return result.data;
}

export function parseCurrentLogin(value: unknown): CurrentLogin {
  const result = z.object({ current: currentLoginSchema }).safeParse(value);
  if (!result.success) throw new Error('服务端登录状态格式无效。');
  return result.data.current;
}

export function parseCredentialSnapshots(value: unknown): CredentialSnapshot[] {
  const result = z.object({ credentials: z.array(snapshotSchema) }).safeParse(value);
  if (!result.success) throw new Error('服务端凭证列表格式无效。');
  return result.data.credentials;
}

export function parseBrowserSession(value: unknown) {
  return z.object({ id: browserLoginIdSchema }).parse(value);
}

export function parseBrowserStatus(value: unknown): BrowserStatus {
  const result = browserStatusSchema.safeParse(value);
  if (!result.success) throw new Error('服务端浏览器登录状态无效。');
  return result.data;
}

export function parseUploadFailure(value: unknown) {
  return z.discriminatedUnion('code', [conflictSchema, restoreSchema]).parse(value);
}

export function parseRefreshTimes(value: unknown) {
  return z.object({ local: z.string().nullable(), server: z.string().nullable() }).parse(value);
}

export function parseProcesses(value: unknown) {
  return z.object({ processes: z.array(z.object({ pid: z.number().int().positive().safe(), command: z.string() })) }).parse(value).processes;
}

export function parseLoginInfo(value: unknown) {
  return z.object({ home: z.string(), userHome: z.string(), authPath: z.string() }).parse(value);
}

export function parseServiceHealth(value: unknown) {
  return z.object({ service: z.string(), version: z.number().int() }).parse(value);
}
