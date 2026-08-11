export type SysmlTextMode = 'code' | 'lineComment' | 'blockComment' | 'string' | 'unrestrictedName';

export interface SysmlTextVisit {
  mode: SysmlTextMode;
  char: string;
  index: number;
  line: number;
}

export interface SysmlPunctuationIssue {
  line: number;
  from: number;
  to: number;
  char: string;
  replacement: string;
  label: string;
}

export const SYSML_PUNCTUATION_REPLACEMENTS = [
  ['：', ':', '全角冒号'],
  ['；', ';', '全角分号'],
  ['，', ',', '全角逗号'],
  ['（', '(', '全角左括号'],
  ['）', ')', '全角右括号'],
  ['｛', '{', '全角左花括号'],
  ['｝', '}', '全角右花括号'],
  ['［', '[', '全角左方括号'],
  ['］', ']', '全角右方括号']
] as const;

export function scanSysmlText(value: unknown, visitor: (visit: SysmlTextVisit) => void): void {
  const text = String(value || '');
  let mode: SysmlTextMode = 'code';
  let quote = '';
  let escaped = false;
  let line = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || '';
    if (mode === 'lineComment') {
      visitor({ mode, char, index, line });
      if (char === '\n') {
        mode = 'code';
        line += 1;
      }
      continue;
    }
    if (mode === 'blockComment') {
      visitor({ mode, char, index, line });
      if (char === '\n') line += 1;
      if (char === '*' && next === '/') {
        index += 1;
        visitor({ mode, char: '/', index, line });
        mode = 'code';
      }
      continue;
    }
    if (mode === 'string' || mode === 'unrestrictedName') {
      visitor({ mode, char, index, line });
      if (char === '\n') line += 1;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
        mode = 'code';
      }
      continue;
    }
    if (char === '"') {
      visitor({ mode: 'code', char, index, line });
      quote = char;
      mode = 'string';
      continue;
    }
    if (char === "'") {
      visitor({ mode: 'unrestrictedName', char, index, line });
      quote = char;
      mode = 'unrestrictedName';
      continue;
    }
    if (char === '/' && next === '/') {
      visitor({ mode: 'lineComment', char, index, line });
      index += 1;
      visitor({ mode: 'lineComment', char: '/', index, line });
      mode = 'lineComment';
      continue;
    }
    if (char === '/' && next === '*') {
      visitor({ mode: 'blockComment', char, index, line });
      index += 1;
      visitor({ mode: 'blockComment', char: '*', index, line });
      mode = 'blockComment';
      continue;
    }
    visitor({ mode: 'code', char, index, line });
    if (char === '\n') line += 1;
  }
}

export function forEachSysmlCodeChar(value: unknown, callback: (visit: Omit<SysmlTextVisit, 'mode'>) => void): void {
  scanSysmlText(value, ({ mode, char, index, line }) => {
    if (mode === 'code') callback({ char, index, line });
  });
}

export function transformSysmlCodeText(value: unknown, transformCodeChar: (char: string) => string): string {
  let result = '';
  scanSysmlText(value, ({ mode, char }) => {
    result += mode === 'code' ? transformCodeChar(char) : char;
  });
  return result;
}

export function sysmlCodeOnlyText(value: unknown): string {
  let result = '';
  scanSysmlText(value, ({ mode, char }) => {
    result += mode === 'code' || mode === 'unrestrictedName' || char === '\n' || char === '\r' ? char : ' ';
  });
  return result;
}

export function scanSysmlPunctuationIssues(content: unknown): SysmlPunctuationIssue[] {
  const issues: SysmlPunctuationIssue[] = [];
  const replacements = new Map<string, { to: string; label: string }>(
    SYSML_PUNCTUATION_REPLACEMENTS.map(([from, to, label]) => [from, { to, label }])
  );
  forEachSysmlCodeChar(content, ({ char, index, line }) => {
    const match = replacements.get(char);
    if (!match) return;
    issues.push({
      line,
      from: index,
      to: index + 1,
      char,
      replacement: match.to,
      label: match.label
    });
  });
  return issues;
}

export function normalizeSysmlPunctuation(content: unknown): { content: string; count: number } {
  let count = 0;
  const replacements = new Map<string, string>(SYSML_PUNCTUATION_REPLACEMENTS.map(([from, to]) => [from, to]));
  const nextContent = transformSysmlCodeText(content, (char) => {
    const replacement = replacements.get(char);
    if (!replacement) return char;
    count += 1;
    return replacement;
  });
  return { content: nextContent, count };
}
