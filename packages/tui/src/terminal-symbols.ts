import figures, { mainSymbols } from '@inquirer/figures';

export const unicode = figures.tick === mainSymbols.tick;
export const glyph = {
  cursor: unicode ? '›' : '>',
  navigate: unicode ? '↑↓' : 'Up/Down',
  range: unicode ? '–' : '-',
  ellipsis: unicode ? '…' : '...',
  left: unicode ? '‹' : '<',
  right: unicode ? '›' : '>',
  filled: unicode ? '●' : figures.circleFilled,
  empty: unicode ? '○' : figures.circle,
};
