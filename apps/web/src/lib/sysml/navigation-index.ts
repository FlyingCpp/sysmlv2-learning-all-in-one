import { SYSML_HIGHLIGHT_KEYWORDS, SYSML_LEXICON } from './lexicon';
import { scanSysmlText, sysmlCodeOnlyText } from './text';

export interface SysmlSymbol {
  id: string;
  parentId: string;
  parentName: string;
  kind: string;
  name: string;
  line: number;
  from: number;
  to: number;
  typeName?: string;
}

export interface SysmlReference {
  name: string;
  line: number;
  from: number;
  to: number;
  kind: string;
}

export interface SysmlNavigationIndex {
  symbols: SysmlSymbol[];
  references: SysmlReference[];
  definitionsByName: Map<string, SysmlSymbol[]>;
}

interface StackEntry {
  id: string;
  name: string;
}

const SYSML_NAME_SOURCE = String.raw`'(?:\\.|[^'\\\r\n])+'|[A-Za-z_]\w*`;
const SYSML_QUALIFIED_NAME_SOURCE = String.raw`(?:${SYSML_NAME_SOURCE})(?:::(?:${SYSML_NAME_SOURCE}))*`;
const PACKAGE_DECLARATION_REGEX = new RegExp(String.raw`\bpackage\s+(${SYSML_NAME_SOURCE})(?=\s*[;{])`);
const DEFINITION_DECLARATION_REGEX = new RegExp(
  String.raw`\b((?:part|item|attribute|port|interface|connection|allocation|flow|action|state|requirement|constraint|calc|analysis|verification|viewpoint|concern|rendering|metadata|view)\s+def|use\s+case\s+def)\s+(${SYSML_NAME_SOURCE})(?=\s|[;{:])`,
  'g'
);
const USAGE_DECLARATION_REGEX = new RegExp(
  String.raw`\b(ref\s+(?:item|part|port)|then\s+action|perform\s+action|entry\s+action|do\s+action|exit\s+action|part|item|attribute|port|end|interface|connection|allocation|action|state|requirement|constraint|calc|analysis|verification|view|viewpoint|actor|subject|objective|in|out|return)\s+(${SYSML_NAME_SOURCE})\s*(?::\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?`,
  'g'
);
const REFERENCE_TOKEN_REGEX = new RegExp(SYSML_QUALIFIED_NAME_SOURCE, 'g');

export function cleanSysmlTypeName(rawType: unknown): string {
  const trimmed = String(rawType || '')
    .trim()
    .replace(/[;{}].*$/, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  const match = new RegExp(String.raw`^~?(${SYSML_QUALIFIED_NAME_SOURCE})`).exec(trimmed);
  if (match?.[1]) return decodeSysmlQualifiedName(match[1]);
  return trimmed.split(/\s+/)[0].trim();
}

export function buildSysmlNavigationIndex(content: unknown): SysmlNavigationIndex {
  const text = String(content || '');
  const codeOnly = sysmlCodeOnlyText(text);
  const lines = text.split(/\r?\n/);
  const codeLines = codeOnly.split(/\r?\n/);
  const symbols: SysmlSymbol[] = [];
  const references: SysmlReference[] = [];
  const definitionsByName = new Map<string, SysmlSymbol[]>();
  const stack: StackEntry[] = [];
  let offset = 0;

  const addSymbol = (symbol: Omit<SysmlSymbol, 'id' | 'parentId' | 'parentName'>) => {
    if (!symbol.name || SYSML_HIGHLIGHT_KEYWORDS.has(symbol.name)) return null;
    const parent = stack[stack.length - 1] || null;
    const nextSymbol: SysmlSymbol = {
      id: `sym-${symbols.length + 1}`,
      parentId: parent?.id || '',
      parentName: parent?.name || '',
      ...symbol
    };
    symbols.push(nextSymbol);
    if (!definitionsByName.has(nextSymbol.name)) definitionsByName.set(nextSymbol.name, []);
    definitionsByName.get(nextSymbol.name)?.push(nextSymbol);
    return nextSymbol;
  };

  const pushBlock = (symbol: SysmlSymbol | null, codeLine: string) => {
    if (!symbol || !codeLine.includes('{')) return;
    stack.push({ id: symbol.id, name: symbol.name });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] || '';
    const codeLine = codeLines[lineIndex] || '';
    const line = lineIndex + 1;
    const leadingCloseCount = (codeLine.match(/^\s*}+/)?.[0].match(/}/g) || []).length;
    for (let count = 0; count < leadingCloseCount && stack.length; count += 1) stack.pop();

    const packageMatch = codeLine.match(PACKAGE_DECLARATION_REGEX);
    if (packageMatch) {
      const rawName = packageMatch[1];
      const tokenStart = offset + codeLine.indexOf(rawName, packageMatch.index);
      const range = sysmlNameSourceRange(tokenStart, rawName);
      const symbol = addSymbol({ kind: 'package', name: decodeSysmlNameToken(rawName), line, from: range.from, to: range.to });
      pushBlock(symbol, codeLine);
    }

    for (const match of codeLine.matchAll(DEFINITION_DECLARATION_REGEX)) {
      const kind = match[1].replace(/\s+/g, ' ');
      const rawName = match[2];
      const tokenStart = offset + (match.index || 0) + match[0].lastIndexOf(rawName);
      const range = sysmlNameSourceRange(tokenStart, rawName);
      const symbol = addSymbol({ kind, name: decodeSysmlNameToken(rawName), line, from: range.from, to: range.to });
      pushBlock(symbol, codeLine.slice(match.index || 0));
    }

    for (const match of codeLine.matchAll(USAGE_DECLARATION_REGEX)) {
      const kind = match[1].replace(/\s+/g, ' ');
      const rawName = match[2];
      const name = decodeSysmlNameToken(rawName);
      if (name === 'def' || /\bdef\b/.test(match[0])) continue;
      const tokenStart = offset + (match.index || 0) + match[0].indexOf(rawName);
      const range = sysmlNameSourceRange(tokenStart, rawName);
      const symbol = addSymbol({
        kind,
        name,
        line,
        from: range.from,
        to: range.to,
        typeName: cleanSysmlTypeName(match[3] || '')
      });
      pushBlock(symbol, codeLine.slice(match.index || 0));
    }

    for (const token of codeLine.matchAll(REFERENCE_TOKEN_REGEX)) {
      const rawName = token[0];
      const name = decodeSysmlQualifiedName(rawName);
      if (SYSML_HIGHLIGHT_KEYWORDS.has(name) || (SYSML_LEXICON.standardLibraries as readonly string[]).includes(name)) continue;
      const tokenStart = offset + (token.index || 0);
      const range = sysmlNameSourceRange(tokenStart, rawName);
      references.push({ name, line, from: range.from, to: range.to, kind: classifySysmlReferenceKind(codeLine, token.index || 0) });
    }

    const openCount = (codeLine.match(/{/g) || []).length;
    const closeCount = (codeLine.match(/}/g) || []).length - leadingCloseCount;
    const netClose = Math.max(0, closeCount - openCount);
    for (let count = 0; count < netClose && stack.length; count += 1) stack.pop();
    offset += rawLine.length + 1;
  }

  const definitionRanges = new Set(symbols.map((symbol) => `${symbol.from}:${symbol.to}`));
  const filteredReferences = references
    .filter((reference) => !definitionRanges.has(`${reference.from}:${reference.to}`))
    .filter((reference) => definitionsByName.has(reference.name) || reference.name.includes('::') || reference.name.includes('.'));
  return { symbols, references: filteredReferences, definitionsByName };
}

export function classifySysmlReferenceKind(codeLine: string, index: number): string {
  const before = codeLine.slice(0, index);
  if (/\bflow\b/.test(before)) return 'flow';
  if (/\bexpose\s+$/.test(before)) return 'expose';
  if (/\bsatisfy\b/.test(before)) return 'satisfy';
  if (/\bverify\b/.test(before)) return 'verify';
  if (/\bsubject\s+$/.test(before)) return 'subject';
  if (/\breturn\b/.test(before)) return 'return';
  if (/\.\s*$/.test(before)) return 'member access';
  if (/:\s*$/.test(before)) return 'type reference';
  return 'reference';
}

export function findSysmlDefinition(index: SysmlNavigationIndex, name: string): SysmlSymbol | null {
  return index.definitionsByName.get(name)?.[0] || null;
}

export function findSysmlReferences(index: SysmlNavigationIndex, name: string): SysmlReference[] {
  return index.references.filter((reference) => reference.name === name);
}

export function renameSysmlSymbolInCode(content: unknown, fromName: string, toName: string): { content: string; count: number } {
  const source = String(content || '');
  if (!isSysmlIdentifier(fromName) || !isSysmlIdentifier(toName) || fromName === toName) {
    return { content: source, count: 0 };
  }
  const pattern = new RegExp(`(^|[^A-Za-z0-9_:])(${escapeRegExp(fromName)})(?=$|[^A-Za-z0-9_:])`, 'g');
  let count = 0;
  let result = '';
  let codeSegment = '';

  const flushCode = () => {
    if (!codeSegment) return;
    result += codeSegment.replace(pattern, (_match, prefix: string) => {
      count += 1;
      return `${prefix}${toName}`;
    });
    codeSegment = '';
  };

  scanSysmlText(source, ({ mode, char }) => {
    if (mode === 'code') {
      codeSegment += char;
    } else {
      flushCode();
      result += char;
    }
  });
  flushCode();
  return { content: result, count };
}

function isSysmlIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_:]*$/.test(value);
}

function decodeSysmlQualifiedName(value: string): string {
  const tokens = Array.from(String(value || '').matchAll(new RegExp(SYSML_NAME_SOURCE, 'g')));
  if (!tokens.length) return String(value || '').trim();
  return tokens.map((token) => decodeSysmlNameToken(token[0])).join('::');
}

function decodeSysmlNameToken(value: string): string {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/\\(['\\])/g, '$1');
  }
  return text;
}

function sysmlNameSourceRange(tokenStart: number, rawName: string): { from: number; to: number } {
  const text = String(rawName || '');
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return { from: tokenStart + 1, to: tokenStart + text.length - 1 };
  }
  return { from: tokenStart, to: tokenStart + text.length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
