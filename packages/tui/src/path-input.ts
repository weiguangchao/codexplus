import { createPrompt, isEnterKey, makeTheme, useEffect, useKeypress, usePrefix, useRef, useState } from '@inquirer/core';
import { styleText } from 'node:util';
import { displayWidth, inputTheme, wrapWords } from './ui.js';

export function pathWindow(value: string, cursor: number, columns: number): { text: string; cursor: number } {
  const points = Array.from(value);
  const position = Math.max(0, Math.min(cursor, points.length));
  const width = Math.max(1, columns - 1);
  if (displayWidth(value) <= width) return { text: value, cursor: points.slice(0, position).join('').length };
  let start = position;
  let end = position;
  let used = 0;
  while (start > 0 && used + displayWidth(points[start - 1]!) <= Math.floor(width * 2 / 3) - 1) used += displayWidth(points[--start]!);
  while (end < points.length && used + displayWidth(points[end]!) <= width - 2) used += displayWidth(points[end++]!);
  while (start > 0 && used + displayWidth(points[start - 1]!) <= width - 2) used += displayWidth(points[--start]!);
  const prefix = start > 0 ? '‹' : '';
  return { text: prefix + points.slice(start, end).join('') + (end < points.length ? '›' : ''), cursor: prefix.length + points.slice(start, position).join('').length };
}

interface PathConfig {
  initial: string;
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
    const next = pathWindow(value, cursor, process.stdout.columns || 80);
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
      const added = Array.from(sequence).filter((point) => point.codePointAt(0)! >= 32 && point !== '\x7f');
      points.splice(cursor, 0, ...added); cursor += added.length;
    }
    update(points.join(''), cursor, rl);
    setError('');
  });
  return [
    `${prefix} ${wrapWords('auth.json 路径 (esc 返回)', (process.stdout.columns || 80) - 2)}\n${view.text}`,
    error ? inputTheme.style.error(error) : styleText('dim', '← → 移动光标 · esc 返回'),
  ];
});
