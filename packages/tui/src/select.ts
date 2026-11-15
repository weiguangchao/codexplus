import { createPrompt, isEnterKey, Separator, useEffect, useKeypress, useRef, useState } from '@inquirer/core';
import { back, pageTarget, plain, renderSelect, selectLayout, visibleChoices } from './select-layout.js';
import type { SelectConfig, SelectState } from './select-layout.js';
import type { EscapeControl } from './prompt-context.js';

export { renderSelect } from './select-layout.js';

const prompt = createPrompt<unknown, SelectConfig<unknown> & { escape?: EscapeControl }>((config, done) => {
  const initial = config.choices.findIndex((item) => !Separator.isSeparator(item) && !item.disabled && Object.is(item.value, config.default));
  const [state, setState] = useState<SelectState>({
    active: initial >= 0 ? initial : config.choices.findIndex((item) => !Separator.isSeparator(item) && !item.disabled),
    query: '', error: '',
  });
  const [size, setSize] = useState({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const current = useRef(state);
  current.current = state;
  useEffect(() => {
    const escape = config.escape;
    if (escape) escape.isReading = () => current.current.reading === true;
    return () => { if (escape) delete escape.isReading; };
  }, []);
  useEffect(() => {
    const resize = () => setSize({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    process.stdout.on('resize', resize);
    return () => { process.stdout.off('resize', resize); };
  }, []);
  useKeypress((key, rl) => {
    rl.clearLine(0);
    const visible = visibleChoices(config, state.query).filter(({ item }) => !Separator.isSeparator(item));
    const item = config.choices[state.active];
    if (key.name === 'f1' || key.ctrl && key.name === 'o' || !config.searchable && 'sequence' in key && key.sequence === '?'
      || state.reading && (isEnterKey(key) || key.name === 'escape')) {
      setState({ ...state, reading: !state.reading, scroll: 0 });
      return;
    }
    if (state.reading) {
      const layout = selectLayout(config, state, size.columns, size.rows);
      const delta = key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'pageup' ? -layout.readingHeight : key.name === 'pagedown' ? layout.readingHeight : 0;
      setState({ ...state, scroll: key.name === 'home' ? 0 : key.name === 'end' ? layout.readingEnd
        : Math.max(0, Math.min(layout.readingEnd, layout.readingStart + delta)) });
      return;
    }
    if (isEnterKey(key)) {
      if (item && !Separator.isSeparator(item)) {
        if (item.disabled) setState({ ...state, error: `不可用：${item.description ? plain(item.description) : typeof item.disabled === 'string' ? plain(item.disabled) : '该选项暂不可用。'}` });
        else done(item.value);
      }
      return;
    }
    let next = state.active;
    const offset = key.name === 'up' ? -1 : key.name === 'down' || key.name === 'tab' ? key.shift ? -1 : 1 : 0;
    if (offset) {
      const at = visible.findIndex(({ index }) => index === state.active);
      next = visible[(at + offset + visible.length) % visible.length]?.index ?? -1;
    } else if (key.name === 'home') next = visible[0]?.index ?? -1;
    else if (key.name === 'end') next = visible.at(-1)?.index ?? -1;
    else if (key.name === 'pageup' || key.name === 'pagedown') {
      next = pageTarget(config, state, size.columns, size.rows, key.name === 'pageup' ? -1 : 1);
    } else if (config.searchable) {
      const sequence = 'sequence' in key && typeof key.sequence === 'string' ? key.sequence : '';
      const query = key.ctrl && key.name === 'u' ? '' : key.name === 'backspace' ? Array.from(state.query).slice(0, -1).join('')
        : !key.ctrl && !('meta' in key && key.meta) && sequence && !sequence.startsWith('\x1b') ? state.query + plain(sequence) : state.query;
      if (query !== state.query) {
        const matches = visibleChoices(config, query);
        next = matches.find(({ item }) => !Separator.isSeparator(item) && !back(item))?.index
          ?? matches.find(({ item }) => !Separator.isSeparator(item))?.index ?? -1;
        setState({ active: next, query, error: '' });
        return;
      }
    } else if (!key.ctrl && !('meta' in key && key.meta)) {
      next = config.choices.findIndex((item) => !Separator.isSeparator(item) && item.key === key.name);
      if (next < 0) next = state.active;
    }
    setState({ ...state, active: next, error: '' });
  });
  return renderSelect(config, state, size.columns, size.rows);
});

export function select<const T>(config: SelectConfig<T>, context?: Parameters<typeof prompt>[1] & { escape?: EscapeControl }): Promise<T> {
  return prompt({ ...config, ...(context?.escape ? { escape: context.escape } : {}) }, context) as Promise<T>;
}
