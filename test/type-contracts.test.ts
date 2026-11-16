import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

function diagnostics(source: string) {
  const file = resolve('test/type-contract-probe.ts');
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve('tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
  assert.ok(parsed);
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => path === file ? source : readFile(path);
  host.fileExists = (path) => path === file || fileExists(path);
  const program = ts.createProgram([file], parsed.options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
}

const imports = `import type { AuthDigest, BrowserLoginId, BrowserStatus, Credential, CurrentLogin, ResetCardId, SaveRequest } from '@weiguangchao/codexplus-shared';
declare const cardId: ResetCardId;
declare const loginId: BrowserLoginId;
declare const digest: AuthDigest;`;

test('编译器拒绝混用语义 ID、缺失状态数据和未处理的操作分支', () => {
  const invalid = diagnostics(`${imports}
export const wrongLogin: BrowserLoginId = cardId;
export const wrongCard: ResetCardId = loginId;
export const wrongEmail: Credential['email'] = digest;
export const missingAccount: CurrentLogin = { status: 'saved' };
export const missingError: BrowserStatus = { status: 'error', url: '', manual: false };
export const missingPath: SaveRequest = { kind: 'credentials.import' };
export function act(request: SaveRequest) {
  switch (request.kind) {
    case 'login.save': return;
    case 'credentials.import': return;
    default: { const exhaustive: never = request; return exhaustive; }
  }
}`);
  assert.equal(invalid.length, 7, JSON.stringify(invalid));
  assert.ok(invalid.every(({ code }) => code === 2322));
});
