import stringWidth from 'fast-string-width';
import { stripVTControlCharacters } from 'node:util';
import { glyph } from './terminal-symbols.js';

const words = new Intl.Segmenter('zh', { granularity: 'word' });
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const formatting = new RegExp(`(${String.fromCharCode(27)}\\[[\\d;]*m)`, 'u');

export const displayWidth = (text: string): number => stringWidth(text);

export function keyHelp(groups: string[], width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const group of groups) {
    if (line && displayWidth(`${line}  ${group}`) > width) { lines.push(line); line = ''; }
    line = line ? `${line}  ${group}` : group;
  }
  if (line) lines.push(line);
  return lines.flatMap((value) => wrapWords(value, width).split('\n'));
}

function cells(text: string): string[] {
  return text.split(formatting).flatMap((part) => formatting.test(part) ? [part] : Array.from(graphemes.segment(part), ({ segment }) => segment));
}

export function fit(text: string, columns: number): string {
  const width = Math.max(1, columns);
  if (displayWidth(text) <= width) return text;
  let shown = '';
  const ellipsis = glyph.ellipsis.slice(0, width);
  let used = displayWidth(ellipsis);
  for (const cell of cells(text)) {
    if (used + displayWidth(cell) > width) break;
    shown += cell;
    used += displayWidth(cell);
  }
  return `${shown.trimEnd()}${ellipsis}${formatting.test(shown) ? '\x1b[0m' : ''}`;
}

export function wrapWords(text: string, columns: number): string {
  const width = Math.max(1, columns);
  return text.split('\n').map((paragraph) => {
    const units = cells(paragraph);
    let consumed = 0;
    let styles = '';
    let spaces = '';
    for (const unit of units) {
      if (formatting.test(unit)) styles += unit;
      else if (/^[ \t]+$/u.test(unit)) spaces += unit;
      else break;
      consumed++;
    }
    const indent = ' '.repeat(Math.min(displayWidth(spaces.replaceAll('\t', '  ')), width - 1));
    const available = width - displayWidth(indent);
    const content = styles + units.slice(consumed).join('');
    const chunks: string[] = [];
    for (const part of content.split(formatting)) {
      if (formatting.test(part)) {
        if (chunks.length) chunks[chunks.length - 1] += part;
        else chunks.push(part);
        continue;
      }
      for (const { segment } of words.segment(part)) {
        const previous = chunks.at(-1);
        if (previous && (/^[，。；：！？、）】》」』,.!?;:]+$/u.test(segment)
          || /^[\w~./\\:@+?=&%#-]+$/u.test(segment) && /^[\w~./\\:@+?=&%#-]+$/u.test(previous))) chunks[chunks.length - 1] += segment;
        else chunks.push(segment);
      }
    }
    const lines: string[] = [];
    let line = '';
    for (let chunk of chunks) {
      if (displayWidth(line) > 0 && displayWidth(line + chunk) > available) { lines.push(line.trimEnd()); line = ''; }
      if (!stripVTControlCharacters(line)) chunk = chunk.trimStart();
      for (const cell of cells(chunk)) {
        if (displayWidth(line + cell) > available && displayWidth(line) > 0) { lines.push(line.trimEnd()); line = ''; }
        line += cell;
      }
    }
    lines.push(line.trimEnd());
    return lines.map((value) => indent + value).join('\n');
  }).join('\n');
}
