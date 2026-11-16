import { Separator } from '@inquirer/core';
import { stripVTControlCharacters } from 'node:util';
import { fit, keyHelp, wrapWords } from './text-layout.js';
import { glyph } from './terminal-symbols.js';
import type { Choice, SelectConfig } from './select-layout.js';

export function clipHeader(source: string, width: number, limit: number): string[] {
  const lines = wrapWords(source, width).split('\n');
  if (lines.length <= limit) return lines;
  const paragraphs = source.split('\n').filter((value) => stripVTControlCharacters(value).trim());
  const selected = paragraphs.length <= limit ? paragraphs : limit === 1 ? paragraphs.slice(0, 1)
    : [...paragraphs.slice(0, limit - 1), ...paragraphs.slice(-1)];
  return selected.map((paragraph) => fit(paragraph, width));
}

export function selectBudget<T>(config: SelectConfig<T>, entries: { item: Choice<T> | Separator; index: number }[], source: string,
  compact: ((limit: number) => string) | undefined, width: number, height: number, searchRows: number, noticeRows: number) {
  const choices = entries.filter(({ item }) => !Separator.isSeparator(item));
  const smallMenu = choices.length <= 4;
  const layoutEntries = smallMenu ? choices : entries;
  const escape = config.theme?.escapeLabel ?? '返回';
  const fullHelp = keyHelp([...(choices.length > 1 ? [`${glyph.navigate} 移动`] : []), 'Enter 确认', `Esc ${escape}`, 'Ctrl+O 说明'], width);
  const help = height < 11 && fullHelp.length > 1 ? keyHelp(['Enter', 'Esc', 'Ctrl+O 说明'], width) : fullHelp;
  const gap = height >= 19 ? 1 : 0;
  const indicatorRows = smallMenu ? config.searchable && height >= 11 ? 1 : 0 : 1;
  const reserve = help.length + searchRows + noticeRows + gap + indicatorRows;
  const minPage = smallMenu ? choices.length : Math.min(2, choices.length);
  const descriptionRows = Math.max(0, ...choices.map(({ item }) => {
    if (Separator.isSeparator(item)) return 0;
    const text = item.description || (typeof item.disabled === 'string' ? item.disabled : item.disabled ? '该选项暂不可用。' : '');
    return text ? wrapWords(`${item.disabled ? '不可用：' : ''}${stripVTControlCharacters(text)}`, width - 2).split('\n').length : 0;
  }));
  const detailTarget = Math.min(3, descriptionRows);
  const preferredPage = smallMenu ? minPage : Math.min(config.pageSize ?? 9, layoutEntries.length);
  const full = wrapWords(source, width).split('\n');
  const headerLimit = Math.max(1, height - reserve - Math.max(1, minPage));
  const headerSource = compact !== undefined && full.length + reserve + detailTarget + preferredPage > height ? compact(headerLimit) : source;
  const header = clipHeader(headerSource, width, headerLimit);
  const detailSize = Math.min(detailTarget, Math.max(0, height - reserve - header.length - minPage));
  const pageSize = Math.max(1, Math.min(smallMenu ? minPage : config.pageSize ?? 9, height - reserve - header.length - detailSize));
  return { header, detailSize, pageSize, help, gap, layoutEntries, smallMenu };
}
