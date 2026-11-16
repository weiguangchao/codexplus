import { Separator } from '@inquirer/core';
import { stripVTControlCharacters, styleText } from 'node:util';
import { fit, keyHelp, wrapWords } from './text-layout.js';
import { glyph } from './terminal-symbols.js';
import { selectBudget } from './select-budget.js';

export interface Choice<T> {
  value: T;
  name: string;
  description?: string;
  disabled?: boolean | string;
  key?: string;
  tone?: 'danger';
}

export type Message = string | ((columns: number, rows: number, availableRows?: number) => string);

export interface SelectConfig<T> {
  message: Message;
  compactMessage?: Message;
  details?: Message;
  choices: readonly (Choice<T> | Separator)[];
  default?: T;
  pageSize?: number;
  searchable?: boolean;
  theme?: { escapeLabel: string };
}

export interface SelectState {
  active: number;
  query: string;
  error: string;
  reading?: boolean;
  scroll?: number;
}

export const plain = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
export const back = <T>(item: Choice<T>) => item.value === null || item.value === 'back';
const resolve = (message: Message, columns: number, rows: number, availableRows?: number) => typeof message === 'string' ? message : message(columns, rows, availableRows);

export function visibleChoices<T>(config: SelectConfig<T>, query: string) {
  const needle = query.toLocaleLowerCase();
  return config.choices.flatMap<{ item: Choice<T> | Separator; index: number }>((item, index) => {
    if (Separator.isSeparator(item)) return query ? [] : [{ item, index }];
    return !needle || back(item) || plain(item.name).toLocaleLowerCase().includes(needle) ? [{ item, index }] : [];
  });
}

function paginate<T>(entries: { item: Choice<T> | Separator; index: number }[], capacity: number) {
  const pages: (typeof entries)[] = [];
  let page: typeof entries = [];
  let pending: (typeof entries)[number] | undefined;
  for (const entry of entries) {
    if (Separator.isSeparator(entry.item)) { pending = entry; continue; }
    const groupSize = pending && capacity > 1 ? 2 : 1;
    if (page.length && page.length + groupSize > capacity) { pages.push(page); page = []; }
    if (pending && capacity > 1) page.push(pending);
    pending = undefined;
    page.push(entry);
  }
  if (page.length) pages.push(page);
  return pages;
}

export function selectLayout<T>(config: SelectConfig<T>, state: SelectState, columns: number, rows: number) {
  const width = Math.max(8, columns - 1);
  const height = Math.max(5, rows - 1);
  const entries = visibleChoices(config, state.query);
  const focused = entries.find(({ index }) => index === state.active)?.item;
  const selected = focused && !Separator.isSeparator(focused) ? focused : undefined;
  const description = state.error || selected?.description || (selected?.disabled ? typeof selected.disabled === 'string' ? selected.disabled : '该选项暂不可用。' : '');
  const detailText = plain(description).trim();
  const detail = description ? wrapWords(detailText, width - 2).split('\n') : [];
  const source = resolve(config.message, columns, rows);
  const fullText = [...wrapWords(resolve(config.details ?? config.message, columns, rows), width).split('\n'),
    ...(selected ? ['', ...wrapWords(plain(selected.name), width).split('\n')] : []), ...detail.map((line) => `  ${line}`)];
  const baseReadingHelp = keyHelp(['Enter/Esc 返回选项'], width);
  const scrolls = fullText.length > height - baseReadingHelp.length;
  const readingHelp = scrolls ? keyHelp([`${glyph.navigate} 滚动`, 'Enter/Esc 返回选项'], width) : baseReadingHelp;
  const readingHeight = Math.max(1, height - readingHelp.length - (scrolls ? 1 : 0));
  const readingEnd = Math.max(0, fullText.length - readingHeight);
  const readingStart = Math.max(0, Math.min(state.scroll ?? 0, readingEnd));
  const noMatch = config.searchable && !entries.some(({ item }) => !Separator.isSeparator(item) && !back(item));
  const notice = noMatch ? [fit('无匹配账号，Ctrl+U 清空', width)] : [];
  const search = config.searchable ? [fit(`筛选 ${state.query || '输入显示邮箱'}`, width)] : [];
  const compactMessage = config.compactMessage;
  const compact = compactMessage === undefined ? undefined : (limit: number) => resolve(compactMessage, columns, rows, limit);
  const { header, detailSize, pageSize, help, gap, layoutEntries } = selectBudget(config, entries, source, compact, width, height, search.length, notice.length);
  const detailLines = Array.from({ length: detailSize }, (_, index) => detail[index] ? `  ${detail[index]}` : '');
  if (detail.length > detailSize && detailSize) {
    let offset = 0;
    for (const line of detail.slice(0, detailSize - 1)) offset = detailText.indexOf(line, offset) + line.length;
    detailLines[detailSize - 1] = `  ${fit(detailText.slice(offset).trimStart(), width - 2)}`;
  }
  const pages = paginate(layoutEntries, pageSize);
  const pageNumber = Math.max(0, pages.findIndex((page) => page.some(({ index }) => index === state.active)));
  const page = pages[pageNumber] ?? [];
  const start = entries.findIndex(({ index }) => index === page[0]?.index);
  const counted = entries.filter(({ item }) => !Separator.isSeparator(item) && !back(item));
  const indicator = pages.length > 1 ? `第 ${pageNumber + 1}/${pages.length} 页${config.searchable ? `  ${counted.length} 个账号` : ''}`
    : config.searchable && rows >= 12 ? `${counted.length} 个账号` : '';
  return { width, height, header, search, notice, help, detailLines, entries, page, pages, pageNumber, pageSize, start,
    fullText, readingHelp, readingHeight, readingStart, readingEnd, gap, indicator };
}

export function pageTarget<T>(config: SelectConfig<T>, state: SelectState, columns: number, rows: number, direction: -1 | 1): number {
  const { pages, pageNumber, page } = selectLayout(config, state, columns, rows);
  const navigable = page.filter(({ item }) => !Separator.isSeparator(item));
  const offset = Math.max(0, navigable.findIndex(({ index }) => index === state.active));
  const next = pages[Math.max(0, Math.min(pages.length - 1, pageNumber + direction))]?.filter(({ item }) => !Separator.isSeparator(item));
  return next?.[Math.min(offset, next.length - 1)]?.index ?? state.active;
}

export function renderSelect<T>(config: SelectConfig<T>, state: SelectState, columns: number, rows: number): string {
  const layout = selectLayout(config, state, columns, rows);
  const { width } = layout;
  if (state.reading) {
    return [...layout.fullText.slice(layout.readingStart, layout.readingStart + layout.readingHeight),
      ...(layout.readingEnd ? [styleText('dim', fit(`${layout.readingStart + 1}${glyph.range}${Math.min(layout.fullText.length, layout.readingStart + layout.readingHeight)} / ${layout.fullText.length}`, width))] : []),
      ...layout.readingHelp.map((line) => styleText('dim', line))].join('\n') + '\x1b[?25l';
  }
  const page = layout.page.map(({ item, index }) => {
    if (Separator.isSeparator(item)) return styleText('dim', fit(`  ${plain(item.separator).trim()}`, width));
    const focused = state.active === index;
    const marker = focused ? glyph.cursor : ' ';
    const shortcut = item.key ? `${item.key}  ` : '';
    const disabled = item.disabled ? `  ${typeof item.disabled === 'string' ? plain(item.disabled) : '(不可用)'}` : '';
    const label = fit(`${marker} ${shortcut}${plain(item.name)}${disabled}`, width);
    return focused ? styleText(['bold', item.disabled ? 'yellow' : item.tone === 'danger' ? 'red' : 'cyan'], label)
      : item.disabled ? styleText('dim', label) : item.tone === 'danger' ? styleText('red', label) : label;
  });
  return [...layout.header, ...layout.search.map((line) => styleText('dim', line)), ...(layout.gap ? [''] : []),
    ...layout.notice.map((line) => styleText('yellow', line)), ...page, ...(layout.indicator ? [styleText('dim', fit(layout.indicator, width))] : []),
    ...layout.detailLines.map((line) => styleText(state.error ? 'yellow' : 'dim', line)),
    ...layout.help.map((line) => styleText('dim', line))].join('\n') + '\x1b[?25l';
}
