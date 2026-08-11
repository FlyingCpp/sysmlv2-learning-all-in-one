import { SYSML_HIGHLIGHT_KEYWORDS, SYSML_LEXICON } from './lexicon';
import { buildSysmlNavigationIndex, type SysmlNavigationIndex, type SysmlSymbol } from './navigation-index';
import { sysmlCodeOnlyText } from './text';

export interface SysmlCompletionRequest {
  content: string;
  cursor?: number;
  explicit?: boolean;
}

export interface SysmlCompletionOption {
  label: string;
  type: 'keyword' | 'type' | 'variable' | 'property' | 'function';
  detail?: string;
  info?: string;
}

export interface SysmlMemberCompletion {
  name: string;
  completionType: SysmlCompletionOption['type'];
  detail: string;
  info: string;
  source: SysmlSymbol;
}

export const SYSML_CONTEXT_COMPLETION_RULES = [
  { test: /\binterface\s+def\b[^{}]*\{[^{}]*$/s, candidates: ['end', 'flow', 'flow of', 'connect'] },
  { test: /\bport\s+def\b[^{}]*\{[^{}]*$/s, candidates: ['ref item', 'in item', 'out item'] },
  { test: /\b(?:action|calc)\s+(?:def\s+)?[A-Za-z_]\w*[^{}]*\{[^{}]*$/s, candidates: ['in', 'out', 'return', 'action', 'then action', 'perform action', 'flow'] },
  { test: /\bstate\s+def\b[^{}]*\{[^{}]*$/s, candidates: ['state', 'entry action', 'do action', 'exit action', 'transition', 'accept', 'then'] },
  { test: /\brequirement\s+def\b[^{}]*\{[^{}]*$/s, candidates: ['doc', 'subject', 'attribute', 'require constraint', 'assume constraint'] },
  { test: /\bverification\s+def\b[^{}]*\{[^{}]*$/s, candidates: ['subject', 'objective', 'verify', 'VerificationCases::PassIf'] },
  { test: /\bview\b[^{}]*\{[^{}]*$/s, candidates: ['expose', 'render', ...SYSML_LEXICON.standardViews] },
  { test: /\bpart\s+def\b[^{}]*\{[^{}]*$/s, candidates: ['attribute', 'part', 'port', 'perform action', 'satisfy', 'connect', 'bind'] }
] as const;

export function sysmlCompletionCandidates(request: SysmlCompletionRequest): string[] {
  const content = request.content || '';
  const cursor = clampCursor(content, request.cursor);
  const beforeCursor = content.slice(0, cursor);
  const navigationIndex = buildSysmlNavigationIndex(content);
  const contextCandidates = sysmlContextualCompletionCandidates(content, beforeCursor, navigationIndex);
  const symbolNames = navigationIndex.symbols.map((symbol) => symbol.name);
  const identifiers = Array.from(new Set(content.match(/\b[A-Za-z_][A-Za-z0-9_:]{2,}\b/g) || []))
    .filter((name) => !SYSML_HIGHLIGHT_KEYWORDS.has(name) && !/^TODO$/.test(name));
  return Array.from(new Set([
    ...contextCandidates,
    ...symbolNames,
    ...identifiers,
    ...SYSML_LEXICON.definitionPhrases,
    ...SYSML_LEXICON.usagePhrases,
    ...SYSML_LEXICON.relationPhrases,
    ...SYSML_LEXICON.coreKeywords,
    ...SYSML_LEXICON.scalarTypes,
    ...SYSML_LEXICON.standardViews,
    ...SYSML_LEXICON.standardLibraries
  ]));
}

export function sysmlContextualCompletionCandidates(
  content: string,
  beforeCursor: string,
  navigationIndex = buildSysmlNavigationIndex(content)
): string[] {
  const source = sysmlCodeOnlyText(beforeCursor).slice(-3000);
  const direct: string[] = [];
  if (/\bspecializes\s+[A-Za-z_:]*$/.test(source)) direct.push(...SYSML_LEXICON.standardViews);
  if (/\bimport\s+[A-Za-z_:*]*$/.test(source)) {
    direct.push(...SYSML_LEXICON.standardLibraries.map((name) => `${name}::*`));
  }
  if (/:\s*[A-Za-z_:]*$/.test(source) || /:>\s*[A-Za-z_:]*$/.test(source)) {
    direct.push(...SYSML_LEXICON.scalarTypes, ...navigationIndex.symbols.map((symbol) => symbol.name));
  }
  for (const rule of SYSML_CONTEXT_COMPLETION_RULES) {
    if (rule.test.test(source)) direct.push(...rule.candidates);
  }
  return Array.from(new Set(direct));
}

export function bestSysmlCompletion(prefix: string, candidates: readonly string[]): string {
  const normalized = String(prefix || '').trimEnd();
  if (!normalized) return '';
  const lowerPrefix = normalized.toLowerCase();
  const exactPrefixMatches = candidates
    .filter((candidate) => candidate.toLowerCase().startsWith(lowerPrefix) && candidate !== normalized)
    .sort((left, right) => {
      const leftLongName = /[A-Z].*[A-Z]|::/.test(left) ? 0 : 1;
      const rightLongName = /[A-Z].*[A-Z]|::/.test(right) ? 0 : 1;
      return leftLongName - rightLongName || left.length - right.length || left.localeCompare(right);
    });
  return exactPrefixMatches[0] || '';
}

export function sysmlCompletionOptions(request: SysmlCompletionRequest): SysmlCompletionOption[] {
  const content = request.content || '';
  const cursor = clampCursor(content, request.cursor);
  const beforeCursor = content.slice(0, cursor);
  const memberMatch = beforeCursor.match(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/);
  if (memberMatch) {
    const objectName = memberMatch[1];
    const prefix = memberMatch[2] || '';
    return sysmlMemberCompletionOptions(content, objectName, prefix)
      .slice(0, 60)
      .map((member) => ({
        label: member.name,
        type: member.completionType,
        detail: member.detail,
        info: member.info
      }));
  }
  const word = beforeCursor.match(/[A-Za-z_][A-Za-z0-9_:]*(?:\s+[A-Za-z_][A-Za-z0-9_:]*)?$/)?.[0] || '';
  const prefix = word.trimStart().toLowerCase();
  if (!prefix && !request.explicit) return [];
  return sysmlCompletionCandidates({ content, cursor, explicit: request.explicit })
    .filter((candidate) => candidate.toLowerCase().startsWith(prefix))
    .slice(0, 80)
    .map((candidate) => ({
      label: candidate,
      type: completionTypeForCandidate(candidate)
    }));
}

export function sysmlMemberCompletionOptions(
  content: string,
  objectName: string,
  prefix = '',
  navigationIndex = buildSysmlNavigationIndex(content)
): SysmlMemberCompletion[] {
  const owner = navigationIndex.definitionsByName.get(objectName)?.[0];
  if (!owner) return [];
  const ownerTypeName = owner.typeName || owner.name;
  const members = navigationIndex.symbols.filter((symbol) => {
    if (symbol.parentId === owner.id || symbol.parentName === owner.name) return true;
    return Boolean(ownerTypeName && (symbol.parentName === ownerTypeName || symbol.parentId.includes(ownerTypeName)));
  });
  const normalizedPrefix = prefix.toLowerCase();
  return members
    .filter((symbol) => symbol.name !== objectName)
    .filter((symbol) => !normalizedPrefix || symbol.name.toLowerCase().startsWith(normalizedPrefix))
    .sort((left, right) => memberCompletionRank(left) - memberCompletionRank(right) || left.from - right.from)
    .map((symbol) => ({
      name: symbol.name,
      completionType: memberCompletionType(symbol.kind),
      detail: `${symbol.kind}${symbol.typeName ? ` : ${symbol.typeName}` : ''}`,
      info: memberCompletionInfo(symbol.kind, symbol.typeName),
      source: symbol
    }));
}

export function completionTypeForCandidate(candidate: string): SysmlCompletionOption['type'] {
  if (/\s/.test(candidate)) return 'keyword';
  if (/[A-Z].*[A-Z]|::/.test(candidate)) return 'type';
  if (SYSML_HIGHLIGHT_KEYWORDS.has(candidate)) return 'keyword';
  return 'variable';
}

function memberCompletionType(kind: string): SysmlCompletionOption['type'] {
  if (/^(action|calc|perform|then)\b/.test(kind)) return 'function';
  if (/^(port|attribute|item|part|end|in|out|return)\b/.test(kind)) return 'property';
  return 'variable';
}

function memberCompletionInfo(kind: string, typeName = ''): string {
  const suffix = typeName ? ` 类型：${typeName}` : '';
  if (/^port\b/.test(kind)) return `端口成员，可用于连接、flow 或接口端点。${suffix}`;
  if (/^(attribute|in|out|return)\b/.test(kind)) return `特征成员，可用于约束、计算或 flow。${suffix}`;
  if (/^part\b/.test(kind)) return `结构成员，可继续展开其端口、属性或子部件。${suffix}`;
  return `当前对象可导航成员。${suffix}`;
}

function memberCompletionRank(symbol: SysmlSymbol): number {
  if (/^port\b/.test(symbol.kind)) return 1;
  if (/^(attribute|in|out|return)\b/.test(symbol.kind)) return 2;
  if (/^part\b/.test(symbol.kind)) return 3;
  if (/^action\b/.test(symbol.kind)) return 4;
  return 9;
}

function clampCursor(content: string, cursor: number | undefined): number {
  const value = Number.isFinite(cursor) ? Number(cursor) : content.length;
  return Math.max(0, Math.min(value, content.length));
}
