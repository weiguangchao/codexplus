import { createPrompt, isEnterKey, makeTheme, useEffect, useKeypress, usePrefix, useRef, useState } from '@inquirer/core';
import { styleText } from 'node:util';
import { inputTheme } from './ui.js';
import { stepTitle } from './screens.js';
import { displayWidth, keyHelp, wrapWords } from './text-layout.js';
import { glyph } from './terminal-symbols.js';

export function pathWindow({ value, cursor, columns }: { value: string; cursor: number; columns: number }): { text: string; cursor: number } {
  const points = Array.from(value);
  const position = Math.max(0, Math.min(cursor, points.length));
  const width = Math.max(1, columns - 1);
  if (displayWidth(value) <= width) return { text: value, cursor: points.slice(0, position).join('').length };
  let start = position;
  let end = position;
  let used = 0;
  for (const point of points.slice(0, start).reverse()) {
    const size = displayWidth(point);
    if (used + size > Math.floor(width * 2 / 3) - 1) break;
    start--; used += size;
  }
  for (const point of points.slice(end)) {
    const size = displayWidth(point);
    if (used + size > width - 2) break;
    end++; used += size;
  }
  for (const point of points.slice(0, start).reverse()) {
    const size = displayWidth(point);
    if (used + size > width - 2) break;
    start--; used += size;
  }
  const prefix = start > 0 ? glyph.left : '';
  return { text: prefix + points.slice(start, end).join('') + (end < points.length ? glyph.right : ''), cursor: prefix.length + points.slice(start, position).join('').length };
}

interface PathConfig {
  initial: string;
  fileName?: string;
  validate(value: string): Promise<string | true>;
}

export const pathInput = createPrompt<string, PathConfig>((config, done) => {
  const [view, setView] = useState({ text: '', cursor: 0 });
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const state = useRef({ value: config.initial, cursor: Array.from(config.initial).length });
  const prefix = usePrefix({ status, theme: makeTheme(inputTheme) });
  const update = (value: string, cursor: number, rl: { line: string }) => {
    state.current = { value, cursor };
    const next = pathWindow({ value, cursor, columns: process.stdout.columns || 80 });
    Object.assign(rl, { line: next.text, cursor: next.cursor });
    setView(next);
  };
  useEffect((rl) => {
    const resize = () => update(state.current.value, state.current.cursor, rl);
    resize();
    process.stdout.on('resize', resize);
    return () => { process.stdout.off('resize', resize); };
  }, []);
  useKeypress(async (key, rl) => {
    if (status !== 'idle') return;
    const { value } = state.current;
    let { cursor } = state.current;
    if (isEnterKey(key)) {
      update(value, cursor, rl);
      setStatus('loading');
      const result = await config.validate(value);
      if (result === true) { done(value); return; }
      update(value, cursor, rl);
      setError(result);
      setStatus('idle');
      return;
    }
    const points = Array.from(value);
    const sequence = 'sequence' in key && typeof key.sequence === 'string' ? key.sequence : '';
    const meta = 'meta' in key && key.meta === true;
    if (key.name === 'home' || key.ctrl && key.name === 'a') cursor = 0;
    else if (key.name === 'end' || key.ctrl && key.name === 'e') cursor = points.length;
    else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
    else if (key.name === 'right') cursor = Math.min(points.length, cursor + 1);
    else if (key.ctrl && key.name === 'u') { points.splice(0, cursor); cursor = 0; }
    else if (key.ctrl && key.name === 'k') points.splice(cursor);
    else if (key.ctrl && key.name === 'w') {
      const kept = Array.from(points.slice(0, cursor).join('').replace(/\S+\s*$/u, '')).length;
      points.splice(kept, cursor - kept); cursor = kept;
    } else if (key.name === 'backspace') { if (cursor > 0) points.splice(--cursor, 1); }
    else if (key.name === 'delete') points.splice(cursor, 1);
    else if (!key.ctrl && !meta && sequence && !sequence.startsWith('\x1b')) {
      const added = Array.from(sequence).filter((point) => point.charCodeAt(0) >= 32 && point !== '\x7f');
      points.splice(cursor, 0, ...added); cursor += added.length;
    }
    update(points.join(''), cursor, rl);
    setError('');
  });
  const fileName = config.fileName ?? 'auth.json';
  return [
    `${stepTitle('添加账号', `导入 ${fileName}`, (process.stdout.rows || 24) < 16 ? '' : '粘贴或拖入文件，支持 ~/ 和带空格的路径。')}\n${prefix} ${wrapWords(status === 'loading' ? '正在检查文件…' : `${fileName} 路径`, (process.stdout.columns || 80) - 2)}\n${view.text}`,
    [error ? inputTheme.style.error(error) : '', styleText('dim', keyHelp(['Enter 添加', 'Ctrl+U 清空左侧', 'Esc 返回'], (process.stdout.columns || 80) - 1).join('\n'))].filter(Boolean).join('\n'),
  ];
});
