import { createPrompt, isEnterKey, makeTheme, useEffect, useKeypress, usePrefix, useRef, useState } from '@inquirer/core';
import { styleText } from 'node:util';
import type { Session } from './client.js';
import { inputTheme } from './ui.js';
import { fit, keyHelp, wrapWords } from './text-layout.js';
import { glyph } from './terminal-symbols.js';

type Result = { id: string } | { error: unknown } | null;
interface BrowserView {
  url: string;
  manual: boolean;
  cancelling: boolean;
  prefix: string;
  reading: boolean;
  scroll: number;
}

export function browserLayout(view: BrowserView, columns: number, rows: number) {
  const width = Math.max(8, columns - 1);
  const message = view.cancelling ? '正在取消登录…' : view.url ? '等待浏览器登录…' : '正在启动浏览器登录…';
  const header = [...(rows < 12 ? [] : ['codexplus / 添加账号']), '浏览器登录', `${view.prefix} ${message}`].flatMap((line) => wrapWords(line, width).split('\n'));
  const url = view.url ? wrapWords(view.url, width).split('\n') : [];
  const footer = keyHelp(view.reading ? [`${glyph.navigate} 滚动`, 'Enter/Esc 返回登录'] : [...(view.url ? ['Ctrl+O 完整链接'] : []), 'Esc 取消登录'], width);
  let hint = view.url ? wrapWords(rows < 12 ? '手动打开链接：' : view.manual ? '请手动打开下面的链接：' : '浏览器未打开时，可手动打开：', width).split('\n') : [];
  const capacity = Math.max(1, rows - 1 - header.length - footer.length - hint.length - 1);
  const end = Math.max(0, url.length - capacity);
  const start = Math.max(0, Math.min(view.scroll, end));
  const long = url.length > capacity;
  const body = view.reading ? url.slice(start, start + capacity) : long ? [] : url;
  if (long && !view.reading) hint = [];
  const indicator = view.reading ? `${start + 1}${glyph.range}${Math.min(url.length, start + capacity)} / ${url.length}`
    : long ? '链接较长，请打开完整链接。' : '登录后自动保存，再选择是否切换。';
  return { header, body, hint, footer, indicator: fit(indicator, width), end, start, capacity };
}

export function renderBrowserLogin(view: BrowserView, columns: number, rows: number): string {
  const layout = browserLayout(view, columns, rows);
  return [...layout.header, ...layout.hint, ...layout.body, styleText('dim', layout.indicator),
    ...layout.footer.map((line) => styleText('dim', line))].join('\n') + '\x1b[?25l';
}

export const browserLoginPrompt = createPrompt<Result, { store: Pick<Session, 'browserLogin' | 'cancelBrowserLogin'> }>(({ store }, done) => {
  const [url, setUrl] = useState('');
  const [manual, setManual] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reading, setReading] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [size, setSize] = useState({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const controller = useRef(new AbortController());
  const prefix = usePrefix({ status: 'loading', theme: makeTheme(inputTheme) });
  const view = { url, manual, cancelling, reading, scroll, prefix };
  useEffect(() => {
    const resize = () => setSize({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    process.stdout.on('resize', resize);
    return () => { process.stdout.off('resize', resize); };
  }, []);
  useEffect(() => {
    const { signal } = controller.current;
    void (async () => {
      try {
        const id = await store.browserLogin({ signal, onUrl: setUrl, onBrowserError: () => setManual(true) });
        if (signal.aborted) { await store.cancelBrowserLogin(id); done(null); }
        else done({ id });
      } catch (error) { done(signal.aborted ? null : { error }); }
    })();
    return () => controller.current.abort();
  }, []);
  useKeypress((key, rl) => {
    rl.clearLine(0);
    if (reading && (key.name === 'escape' || isEnterKey(key))) { setReading(false); setScroll(0); }
    else if (key.name === 'escape') { setCancelling(true); controller.current.abort(); }
    else if (url && (key.name === 'f1' || key.ctrl && key.name === 'o' || 'sequence' in key && key.sequence === '?')) { setReading(!reading); setScroll(0); }
    else if (reading) {
      const layout = browserLayout(view, size.columns, size.rows);
      const delta = key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'pageup' ? -layout.capacity : key.name === 'pagedown' ? layout.capacity : 0;
      setScroll(key.name === 'home' ? 0 : key.name === 'end' ? layout.end : Math.max(0, Math.min(layout.end, layout.start + delta)));
    }
  });
  return renderBrowserLogin(view, size.columns, size.rows);
});
