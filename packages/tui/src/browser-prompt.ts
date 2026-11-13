import { createPrompt, makeTheme, useEffect, useKeypress, usePrefix, useRef, useState } from '@inquirer/core';
import { styleText } from 'node:util';
import { browserLogin } from './browser-login.js';
import { inputTheme, wrapWords } from './ui.js';

type Result = { auth: string } | { error: unknown } | null;

export const browserLoginPrompt = createPrompt<Result, Record<string, never>>((_config, done) => {
  const [url, setUrl] = useState('');
  const [manual, setManual] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const controller = useRef(new AbortController());
  const prefix = usePrefix({ status: 'loading', theme: makeTheme(inputTheme) });
  useEffect(() => {
    const { signal } = controller.current;
    void browserLogin({ signal, onUrl: setUrl, onBrowserError: () => setManual(true) }).then(
      (auth) => done(signal.aborted ? null : { auth }),
      (error: unknown) => done(signal.aborted ? null : { error }),
    );
    return () => controller.current.abort();
  }, []);
  useKeypress((key) => {
    if (key.name === 'escape') { setCancelling(true); controller.current.abort(); }
  });
  const message = cancelling ? '正在取消登录…' : url ? '等待浏览器登录…' : '正在启动 Codex 浏览器登录…';
  return [
    `${prefix} ${message}${url ? `\n${wrapWords(manual ? '无法自动打开浏览器，请手动打开：' : '若浏览器未打开，可手动打开：', process.stdout.columns || 80)}\n${url}` : ''}`,
    styleText('dim', 'esc 取消登录'),
  ];
});
