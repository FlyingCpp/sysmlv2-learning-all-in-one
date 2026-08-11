import type { Lesson, WorkspaceFile } from '../course/types';

export const FOCUS_COLORS = ['#1769aa', '#b42318', '#147a4d', '#9a5b00', '#6d3bbd', '#0f766e', '#c2410c', '#be185d'] as const;

export type FocusTermSource = 'text' | 'rule' | 'code';

export interface FocusTerm {
  text: string;
  label: string;
  source: FocusTermSource;
  color: string;
}

export function buildFocusTerms(lesson: Lesson, files: readonly WorkspaceFile[]): FocusTerm[] {
  const terms: FocusTerm[] = [];
  const seen = new Set<string>();
  let textTermCount = 0;
  const add = (value: unknown, source: FocusTermSource = 'text') => {
    const text = normalizeFocusTerm(value);
    if (!text || seen.has(text)) return;
    if (!termAppearsInFiles(text, files)) return;
    seen.add(text);
    terms.push({ text, label: compactLabel(text), source, color: FOCUS_COLORS[terms.length % FOCUS_COLORS.length] });
    if (source === 'text') textTermCount += 1;
  };

  [
    lesson.scenario?.body,
    ...(lesson.learningBlocks || []).flatMap((block) => [block.content, block.body, block.markdown, block.text]),
    ...(lesson.tasks || []).flatMap((task) => [task.prompt, ...(task.hints || [])])
  ].filter(Boolean).forEach((text) => {
    extractBacktickTerms(String(text)).forEach((term) => add(term, 'text'));
  });

  if (terms.length < 8) {
    for (const rule of normalizeLessonRules(lesson.validation?.rules)) {
      const selector = { ...rule, ...recordValue(rule.selector) };
      [
        selector.name,
        selector.typeName,
        selector.parent,
        selector.parentName,
        selector.sourceName,
        selector.targetName
      ].forEach((term) => add(term, 'rule'));
      if (terms.length >= 8) break;
    }
  }

  if (textTermCount === 0 && terms.length < 8) {
    extractCodeIdentifiers(files).forEach((term) => add(term, 'code'));
  }

  return terms.slice(0, 8);
}

export function extractBacktickTerms(text: unknown): string[] {
  return Array.from(String(text).matchAll(/`([^`]+)`/g)).map((match) => match[1]);
}

export function normalizeLessonRules(rules: unknown): Record<string, unknown>[] {
  if (!rules) return [];
  if (Array.isArray(rules)) return rules.filter(isRecord);
  if (isRecord(rules) && Array.isArray(rules.rules)) return rules.rules.filter(isRecord);
  return [];
}

export function extractCodeIdentifiers(files: readonly WorkspaceFile[]): string[] {
  const content = files.map((file) => file.content || '').join('\n');
  const matches = Array.from(content.matchAll(/\b(?:part|port|item|interface|action|state|requirement|analysis|verification|constraint|calc)(?:\s+def)?\s+([A-Za-z_][\w]*)/g));
  return matches.map((match) => match[1]);
}

export function normalizeFocusTerm(value: unknown): string {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length < 3 || text.length > 80) return '';
  if (/^[.,;:{}()[\]]+$/.test(text)) return '';
  return text;
}

export function compactLabel(text: string): string {
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

export function termAppearsInFiles(term: string, files: readonly WorkspaceFile[]): boolean {
  return files.some((file) => {
    const content = String(file.content || '');
    return content.includes(term) || term.split(/\s+/).some((part) => part.length > 2 && content.includes(part));
  });
}

export function focusTermMap(terms: readonly FocusTerm[]): Map<string, FocusTerm> {
  return new Map(terms.map((term) => [term.text, term]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
