import { dirname } from 'node:path';
import { z } from 'zod';
import { authDigestSchema, browserLoginIdSchema, credentialSchema, saveOptionsSchema, authSchema, protocolVersion,
  resetCardIdSchema, resetRequestIdSchema, ServiceError } from '@weiguangchao/codexplus-shared';
import { recordAudit, recordCommitted } from './audit.js';
import type { CurrentLoginStore } from './current-login.js';
import type { CredentialStore } from './store.js';
import type { BrowserSessions } from './browser-sessions.js';
import { findCodexProcesses } from './processes.js';
import { restartCodexServer } from './restart-codex.js';
import { listResetCards, useResetCard } from './reset-cards.js';
import { lookupAccountInfo } from './account-info.js';
import { idTokenEmail } from './login.js';
import { RpcError } from './rpc.js';

const credentialFields = credentialSchema.shape;
const saveFields = saveOptionsSchema.shape;
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(['health', 'credentials.list', 'login.info', 'login.current', 'login.processes',
    'login.accountInfo', 'login.restartServer', 'login.browser.start']) }),
  z.object({ kind: z.literal('login.save'), ...saveFields }),
  z.object({ kind: z.literal(['login.switch', 'login.refreshTimes', 'credentials.download', 'resetCards.list']), ...credentialFields }),
  z.object({ kind: z.literal('credentials.delete'), ...credentialFields, base: authDigestSchema.nullable() }),
  z.object({ kind: z.literal('credentials.upload'), base: authDigestSchema.nullable(), auth: authSchema }),
  z.object({ kind: z.literal(['credentials.import', 'credentials.validate']), path: z.string(), ...saveFields }),
  z.object({ kind: z.literal(['login.browser.status', 'login.browser.cancel']), id: browserLoginIdSchema }),
  z.object({ kind: z.literal('login.browser.save'), id: browserLoginIdSchema, ...saveFields }),
  z.object({ kind: z.literal('resetCards.use'), ...credentialFields, cardId: resetCardIdSchema, requestId: resetRequestIdSchema }),
]);

type Operation = z.infer<typeof operationSchema>;

function parseOperation({ method, params }: { method: string; params: unknown }): Operation {
  if (!operationSchema.options.some((schema) => schema.shape.kind.safeParse(method).success)) {
    throw new RpcError({ code: -32601, message: '未找到服务端方法。' });
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new RpcError({ code: -32602, message: 'params 必须为命名参数对象。' });
  const result = operationSchema.safeParse({ ...params, kind: method });
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('、');
    throw new ServiceError({ status: 400, message: method === 'resetCards.use' ? '使用重置卡必须提供 cardId 和 requestId。' : `服务端方法参数格式无效：${fields}。` });
  }
  return result.data;
}

export function createOperations({ store, current, browsers, home, accountRequest, findProcesses = findCodexProcesses, restartServer = restartCodexServer }: {
  store: CredentialStore; current: CurrentLoginStore; browsers: BrowserSessions; home: string; accountRequest: typeof fetch;
  findProcesses?: typeof findCodexProcesses; restartServer?: typeof restartCodexServer;
}) {
  const client = { id: 'local', name: '本机' };
  return async ({ method, params }: { method: string; params: unknown }): Promise<unknown> => {
    try {
      const operation = parseOperation({ method, params });
      switch (operation.kind) {
        case 'health': return { service: 'codexplus', version: protocolVersion };
        case 'credentials.list': return { credentials: await store.snapshots() };
        case 'login.info': return await current.info();
        case 'login.current': return { current: await current.current() };
        case 'login.processes': return { processes: await findProcesses() };
        case 'login.accountInfo': {
          const { auth } = await current.readSource(current.authPath);
          const info = await lookupAccountInfo({ tokens: auth.tokens, request: accountRequest });
          return { ...info, email: info.email ?? idTokenEmail(auth) };
        }
        case 'resetCards.list': return { cards: await listResetCards({ tokens: (await store.get(operation)).tokens, request: accountRequest }) };
        case 'resetCards.use': {
          const { tokens } = await store.get(operation);
          const outcome = await useResetCard({ tokens, cardId: operation.cardId, requestId: operation.requestId, request: accountRequest });
          if (outcome === 'reset') await recordCommitted({ home, event: '重置', client, subject: { email: operation.email } });
          return { outcome };
        }
        case 'login.save': return await current.saveCurrent(operation);
        case 'login.switch': return await current.switch(operation);
        case 'login.refreshTimes': return await current.refreshTimes(operation.email);
        case 'login.restartServer': await restartServer(dirname(current.authPath)); return { ok: true };
        case 'credentials.import': return await current.import({ sourcePath: operation.path, options: operation });
        case 'credentials.validate': await current.readSource(operation.path); return { ok: true };
        case 'login.browser.start': return browsers.start();
        case 'login.browser.status': return browsers.status(operation.id);
        case 'login.browser.save': return await current.save({ auth: browsers.auth(operation.id), currentFile: false, options: operation });
        case 'login.browser.cancel': await browsers.cancel(operation.id); return { ok: true };
        case 'credentials.upload': {
          const result = await store.add({ auth: operation.auth, base: operation.base });
          if (result.changed) await recordCommitted({ home, event: '上传', client, subject: { email: result.credential.email } });
          return result;
        }
        case 'credentials.delete': await current.delete({ credential: operation, base: operation.base }); return { ok: true };
        case 'credentials.download': {
          const auth = await store.get(operation);
          await recordAudit({ home, event: '下载', client, subject: { email: operation.email } });
          return { auth };
        }
        default: {
          const _exhaustive: never = operation;
          return _exhaustive;
        }
      }
    } catch (error) {
      if (error instanceof ServiceError || error instanceof RpcError) throw error;
      if (['health', 'credentials.list', 'login.info', 'login.current', 'login.processes'].includes(method)) throw error;
      if (error instanceof Error && !('code' in error)) throw new ServiceError({ status: 400, message: error.message });
      throw error;
    }
  };
}
