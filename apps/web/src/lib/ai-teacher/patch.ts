import type { ValidationResult } from '../course/types';
import type { AiTeacherPatch, AiTeacherPatchOperation } from './envelope';

export interface PatchApplyResult {
  ok: boolean;
  content?: string;
  validationResult?: ValidationResult;
  message: string;
}

export function isAiTeacherPatchApplyReady(patch?: AiTeacherPatch | null): boolean {
  return ['validated_passed', 'passed'].includes(String(patch?.validatorStatus || ''))
    && patch?.applyPolicy === 'user_confirm_required'
    && Array.isArray(patch.operations)
    && patch.operations.length === 1;
}

export function teacherPatchStatusLabel(value?: string): string {
  const labels: Record<string, string> = {
    validated_passed: '已验证通过',
    passed: '已验证通过',
    validated_failed: '验证未通过',
    failed: '验证未通过',
    validator_unavailable: '验证不可用',
    not_validated: '未验证',
    unavailable: '验证不可用'
  };
  return labels[String(value || '')] || '待处理';
}

export async function applySingleLinePatchToContent(content: string, patch: AiTeacherPatch): Promise<PatchApplyResult> {
  if (!isAiTeacherPatchApplyReady(patch)) {
    return { ok: false, message: '这条建议尚未通过验证，不能直接应用。' };
  }
  const operation = patch.operations?.[0];
  if (!operation || operation.op !== 'replaceRange') {
    return { ok: false, message: '建议操作不是受支持的单行 replaceRange。' };
  }
  const currentHash = await sha256Content(content);
  if (patch.baseContentHash && currentHash !== patch.baseContentHash) {
    return { ok: false, message: '当前代码已变化，请重新向 AI 教师生成建议。' };
  }
  const range = lineColumnRange(content, operation);
  if (!range) return { ok: false, message: '建议位置已失效，请重新生成建议。' };
  return {
    ok: true,
    content: `${content.slice(0, range.start)}${operation.replacement || ''}${content.slice(range.end)}`,
    validationResult: patch.validationResult,
    message: '已应用单行建议，请复核并保存草稿。'
  };
}

export async function sha256Content(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('crypto.subtle is not available.');
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function lineColumnRange(content: string, operation: AiTeacherPatchOperation): { start: number; end: number } | null {
  const start = lineColumnOffset(content, operation.startLine, operation.startColumn);
  const end = lineColumnOffset(content, operation.endLine, operation.endColumn);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

export function lineColumnOffset(content: string, lineNumber = 1, columnNumber = 1): number {
  const value = String(content || '');
  const targetLine = Math.max(1, Number(lineNumber || 1));
  const targetColumn = Math.max(1, Number(columnNumber || 1));
  let line = 1;
  let offset = 0;
  while (line < targetLine && offset < value.length) {
    const char = value[offset];
    if (char === '\r') {
      offset += value[offset + 1] === '\n' ? 2 : 1;
      line += 1;
    } else if (char === '\n') {
      offset += 1;
      line += 1;
    } else {
      offset += 1;
    }
  }
  return Math.min(value.length, offset + targetColumn - 1);
}
