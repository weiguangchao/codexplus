import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const mode = process.env.LOGIN_FIXTURE_MODE;
const record = process.env.LOGIN_FIXTURE_RECORD;
const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'browser-access', refresh_token: 'browser-refresh' }, extra: 'discard' };
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = async (value) => { if (record) await appendFile(record, `${JSON.stringify(value)}\n`); };
await log({ home: process.env.CODEX_HOME, args: process.argv.slice(2) });
if (mode === 'exit') process.exit(1);
const lines = createInterface({ input: process.stdin });
for await (const message of lines) {
  const { method, id, params } = JSON.parse(message);
  await log({ method, params });
  if (method === 'initialize') {
    if (mode === 'startup-timeout') continue;
    send({ id, result: {} });
  } else if (method === 'account/login/start') {
    if (mode === 'rpc-error') { send({ id, error: { code: -32601, message: 'sensitive-response' } }); continue; }
    const complete = () => send({ method: 'account/login/completed', params: { loginId: 'this-login', success: mode !== 'denied', error: 'sensitive-response' } });
    if (mode === 'early') { await writeFile(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify(auth)); complete(); }
    send({ id, result: { type: 'chatgpt', loginId: 'this-login', authUrl: mode === 'bad-url' ? 'file:///etc/passwd' : 'https://auth.openai.com/oauth/authorize?fixture=1' } });
    send({ method: 'account/login/completed', params: { loginId: 'other-login', success: true } });
    if (['pending', 'early', 'bad-url'].includes(mode)) continue;
    setTimeout(async () => {
      if (mode !== 'missing-file') await writeFile(join(process.env.CODEX_HOME, 'auth.json'), mode === 'invalid-file' ? '{"OPENAI_API_KEY":"fake-key"}' : JSON.stringify(auth));
      complete();
    }, 100);
  } else if (method === 'account/login/cancel') {
    send({ id, result: { status: 'canceled' } });
  }
}
process.exit(0);
