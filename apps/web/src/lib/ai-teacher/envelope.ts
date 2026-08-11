import type { Lesson, ValidationFinding, ValidationResult, WorkspaceSnapshot } from '../course/types';
import { resolveWorkspaceImportClosure } from '../course/workspace';

export interface AiTeacherEditorPosition {
  offset?: number;
  line?: number;
  column?: number;
}

export type AiTeacherEditorFocus = 'focused' | 'blurred' | 'not-mounted';
export type AiTeacherInteractionTarget = 'code' | 'diagnostic' | 'course-content' | 'ai-panel' | 'non-code' | 'unknown';
export type AiTeacherCursorOrigin = 'current' | 'frozen-explicit' | 'last-known' | 'default';
export type AiTeacherSelectionOrigin = 'current' | 'frozen-explicit' | 'last-known' | 'none';

export interface AiTeacherEditorContextState {
  focus?: AiTeacherEditorFocus;
  interactionTarget?: AiTeacherInteractionTarget;
  capturedAt?: string;
  documentRevision?: string;
  cursorOrigin?: AiTeacherCursorOrigin;
  selectionOrigin?: AiTeacherSelectionOrigin;
  degradedReason?: string;
}

export interface AiTeacherEditorContext {
  cursor?: AiTeacherEditorPosition;
  selection?: {
    from?: AiTeacherEditorPosition;
    to?: AiTeacherEditorPosition;
    text?: string;
    empty?: boolean;
  };
  symbolName?: string;
  contextState?: AiTeacherEditorContextState;
}

export interface BuildAiTeacherEnvelopeOptions {
  questionText: string;
  threadId?: string;
  clarificationCheckpointId?: string;
  manualContinuationSourceRunId?: string;
  manualContinuationKind?: 'engineering_feedback';
  coursePackId?: string;
  lesson?: Lesson | null;
  workspace: WorkspaceSnapshot;
  activeFilePath?: string;
  validation?: ValidationResult | null;
  activeDiagnosticId?: string | null;
  editorState?: string;
  editorContext?: AiTeacherEditorContext | null;
}

export interface AiTeacherStreamEvent {
  type?: string;
  text?: string;
  message?: string;
  activityId?: string;
  kind?: string;
  status?: string | number;
  count?: number;
  items?: Array<{ title?: string; detail?: string; url?: string; [key: string]: unknown }>;
  threadId?: string;
  runId?: string;
  response?: AiTeacherResponse;
  data?: AiTeacherResponse;
  error?: string;
  [key: string]: unknown;
}

export interface AiTeacherResponse {
  contractVersion?: string;
  responseId?: string;
  requestId?: string;
  answerType?: string;
  title?: string;
  confidence?: string;
  directAnswer?: string;
  answerCompletionStatus?: string;
  clarification?: {
    checkpointId?: string;
    status?: 'waiting';
    question?: string;
    questionId?: string;
    options?: Array<{ optionId?: string; label?: string }>;
    expiresAt?: string;
  };
  engineeringReview?: {
    assessmentStatus?: string;
    recommendation?: string;
    verification?: 'not_run' | 'resolved' | 'unresolved' | 'unavailable';
    engineeringCompletionStatus?: string;
    revisionDelivered?: boolean;
    engineeringResolution?: 'resolved' | 'unresolved' | 'unknown' | 'not_assessed';
    openSuggestions?: Array<{ publicSuggestionId?: string; summary?: string }>;
    previousVersion?: {
      available?: boolean;
      files?: Array<{ filePath?: string; content?: string }>;
    };
    canContinue?: boolean;
    sourceRunId?: string;
    continuationAction?: 'continue_engineering_improvement';
  };
  continuation?: {
    status?: 'automatic_pending' | 'complete' | 'user_confirmation_required';
    sourceRunId?: string;
    autoContinuationUsed?: boolean;
    canContinue?: boolean;
    completedItems?: Array<{ title?: string; detail?: string; status?: 'completed' | 'validated' }>;
    remainingItems?: Array<{ title?: string; detail?: string; status?: 'remaining' | 'blocked' }>;
  };
  sections?: Array<{ kind?: string; title?: string; content?: string; [key: string]: unknown }>;
  evidence?: Array<{ sourceTitle?: string; sourceType?: string; confidence?: string; [key: string]: unknown }>;
  warnings?: string[];
  patches?: AiTeacherPatch[];
  codeBlockValidations?: AiTeacherCodeBlockValidation[];
  alignmentReview?: {
    version?: string;
    label?: 'high' | 'medium' | 'uncertain';
    summary?: string;
    targetSatisfied?: boolean;
    scopePreserved?: boolean;
    minimality?: 'minimal' | 'possibly_overbroad' | 'uncertain';
    [key: string]: unknown;
  };
  threadId?: string;
  [key: string]: unknown;
}

export interface AiTeacherCodeBlockValidation {
  index?: number;
  language?: string;
  status?: string;
  label?: string;
  message?: string;
  attempts?: number;
  maxAttempts?: number;
  manualReviewRequired?: boolean;
  diagnostics?: ValidationFinding[];
  [key: string]: unknown;
}

export interface AiTeacherPatch {
  patchId?: string;
  title?: string;
  baseFilePath?: string;
  baseContentHash?: string;
  previewText?: string;
  validatorStatus?: string;
  applyPolicy?: string;
  validationDiagnostics?: ValidationFinding[];
  warnings?: string[];
  operations?: AiTeacherPatchOperation[];
  learningCard?: Record<string, unknown>;
  validationResult?: ValidationResult;
  [key: string]: unknown;
}

export interface AiTeacherPatchOperation {
  op?: string;
  filePath?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  replacement?: string;
}

export function buildAiTeacherEnvelope(options: BuildAiTeacherEnvelopeOptions) {
  const activeFilePath = options.activeFilePath
    || options.workspace.activeFilePath
    || options.workspace.entryFile
    || options.workspace.files?.[0]?.path
    || 'main.sysml';
  const activeFile = (options.workspace.files || []).find((file) => file.path === activeFilePath)
    || options.workspace.files?.[0];
  const editorContext = normalizeEditorContext(options.editorContext, String(activeFile?.content || ''));
  return {
    contractVersion: '1.1',
    requestId: `react-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    threadId: options.threadId || undefined,
    clarificationCheckpointId: options.clarificationCheckpointId || undefined,
    manualContinuationSourceRunId: options.manualContinuationSourceRunId || undefined,
    manualContinuationKind: options.manualContinuationKind || undefined,
    host: {
      hostAppId: 'sysmlv2-learning-platform',
      integrationMode: 'embedded-panel'
    },
    tenant: {
      tenantId: 'local-desktop',
      dataPolicy: {
        allowExternalProvider: false,
        allowModelTraining: false,
        piiExpected: false
      }
    },
    course: {
      coursePackId: options.coursePackId || 'sysmlv2-course-pack',
      courseId: options.lesson?.courseId || inferCourseId(options.lesson?.id),
      lessonId: options.lesson?.id || '',
      lessonTitle: options.lesson?.title || '',
      learningGoals: teacherLearningGoals(options.lesson)
    },
    editor: {
      language: 'sysmlv2',
      entryFile: options.workspace.entryFile || activeFilePath,
      activeFilePath,
      files: resolveWorkspaceImportClosure(
        options.workspace.files || [],
        options.workspace.entryFile || activeFilePath,
        [activeFilePath]
      ).map((file) => ({
        path: file.path || 'main.sysml',
        content: String(file.content || ''),
        editable: file.editable !== false,
        source: file.source || (file.editable === false ? 'reference' : 'workspace'),
        loadPolicy: file.loadPolicy || 'always'
      })),
      selection: {
        startOffset: editorContext.selection.from.offset,
        startLine: editorContext.selection.from.line,
        startColumn: editorContext.selection.from.column,
        endOffset: editorContext.selection.to.offset,
        endLine: editorContext.selection.to.line,
        endColumn: editorContext.selection.to.column,
        text: editorContext.selection.text,
        empty: editorContext.selection.empty
      },
      cursor: {
        offset: editorContext.cursor.offset,
        line: editorContext.cursor.line,
        column: editorContext.cursor.column
      },
      symbolName: editorContext.symbolName,
      contextState: editorContext.contextState
    },
    model: {
      modelElements: Array.isArray(options.validation?.modelElements) ? options.validation?.modelElements : [],
      symbolsSummary: {}
    },
    diagnostics: diagnosticsContext(options.validation, options.activeDiagnosticId),
    courseContext: {
      editorState: options.editorState || 'template',
      lastValidationPassed: Boolean(
        options.validation?.syntaxValid
        && options.validation?.semanticValid
        && options.validation?.coursePassed
      )
    },
    question: {
      text: options.questionText
    }
  };
}

export function sanitizeTeacherUiText(value: unknown): string {
  return String(value || '')
    .replace(/(authorization)\s*[:=]\s*(?:Bearer\s+)?["']?[^"'\s,}]+/gi, '$1=[redacted]')
    .replace(/(api[_-]?key)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[^"'\s,}]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
}

function diagnosticsContext(result?: ValidationResult | null, requestedActiveDiagnosticId?: string | null) {
  const all = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  const normalized: Array<ValidationFinding & { diagnosticId: string }> = all.map((item) => ({
    ...item,
    diagnosticId: aiTeacherDiagnosticId(item)
  }));
  const diagnosticIds = new Set(normalized.map((item) => item.diagnosticId));
  return {
    officialValidator: normalized.filter((item) => item.source !== 'course-rule'),
    courseRules: normalized.filter((item) => item.source === 'course-rule'),
    lastValidation: result ? {
      syntaxValid: Boolean(result.syntaxValid),
      semanticValid: Boolean(result.semanticValid),
      coursePassed: Boolean(result.coursePassed),
      validatedAt: new Date().toISOString()
    } : null,
    activeDiagnosticId: requestedActiveDiagnosticId && diagnosticIds.has(requestedActiveDiagnosticId)
      ? requestedActiveDiagnosticId
      : null
  };
}

export function aiTeacherDiagnosticId(value: ValidationFinding): string {
  const signature = [
    value?.source,
    value?.ruleId,
    value?.code,
    value?.category,
    value?.severity,
    value?.file,
    value?.line,
    value?.column,
    value?.message
  ].map((item) => String(item ?? '').trim()).join('\u001f');
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `diag-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeEditorContext(context: AiTeacherEditorContext | null | undefined, content: string): {
  cursor: Required<AiTeacherEditorPosition>;
  selection: {
    from: Required<AiTeacherEditorPosition>;
    to: Required<AiTeacherEditorPosition>;
    text: string;
    empty: boolean;
  };
  symbolName: string;
  contextState: Required<AiTeacherEditorContextState>;
} {
  const cursor = normalizePosition(context?.cursor, content);
  const from = normalizePosition(context?.selection?.from || context?.cursor, content);
  const to = normalizePosition(context?.selection?.to || context?.cursor, content);
  const selectionStart = Math.min(from.offset, to.offset);
  const selectionEnd = Math.max(from.offset, to.offset);
  const canonicalFrom = positionAtOffset(content, selectionStart);
  const canonicalTo = positionAtOffset(content, selectionEnd);
  const text = content.slice(selectionStart, selectionEnd);
  const capturedRevision = String(context?.contextState?.documentRevision || documentRevisionForText(content));
  const currentRevision = documentRevisionForText(content);
  const sourceFocus = normalizeFocus(context?.contextState?.focus, context ? 'blurred' : 'not-mounted');
  const interactionTarget = normalizeInteractionTarget(context?.contextState?.interactionTarget);
  const sourceOrigin = normalizeCursorOrigin(context?.contextState?.cursorOrigin, context ? 'last-known' : 'default');
  const sourceSelectionOrigin = normalizeSelectionOrigin(
    context?.contextState?.selectionOrigin,
    selectionStart === selectionEnd ? 'none' : sourceOrigin === 'current' ? 'current' : 'last-known'
  );
  const grounding = normalizeGroundingState({
    focus: sourceFocus,
    interactionTarget,
    capturedRevision,
    currentRevision,
    sourceOrigin
  });
  const groundedCursor = grounding.cursorOrigin === 'default' ? positionAtOffset(content, 0) : cursor;
  const groundedFrom = grounding.cursorOrigin === 'default' ? groundedCursor : canonicalFrom;
  const groundedTo = grounding.cursorOrigin === 'default' ? groundedCursor : canonicalTo;
  const selectionOrigin = normalizedSelectionOrigin({
    sourceSelectionOrigin,
    hasSelection: selectionStart !== selectionEnd,
    cursorOrigin: grounding.cursorOrigin
  });
  return {
    cursor: groundedCursor,
    selection: {
      from: groundedFrom,
      to: groundedTo,
      text: grounding.cursorOrigin === 'default' ? '' : text,
      empty: grounding.cursorOrigin === 'default' || selectionStart === selectionEnd
    },
    symbolName: grounding.cursorOrigin === 'default'
      ? ''
      : typeof context?.symbolName === 'string'
        ? context.symbolName
        : symbolAt(content, cursor.offset),
    contextState: {
      focus: sourceFocus,
      interactionTarget,
      capturedAt: validIsoTimestamp(context?.contextState?.capturedAt) || new Date().toISOString(),
      documentRevision: capturedRevision,
      cursorOrigin: grounding.cursorOrigin,
      selectionOrigin,
      degradedReason: grounding.degradedReason
    }
  };
}

function normalizePosition(position: AiTeacherEditorPosition | null | undefined, content: string): Required<AiTeacherEditorPosition> {
  if (Number.isFinite(position?.offset)) return positionAtOffset(content, Number(position?.offset));
  return positionAtOffset(content, offsetAtLineColumn(content, Number(position?.line || 1), Number(position?.column || 1)));
}

export function documentRevisionForText(value: string): string {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function positionAtOffset(content: string, value: number): Required<AiTeacherEditorPosition> {
  const offset = Math.max(0, Math.min(Number.isFinite(value) ? Math.floor(value) : 0, content.length));
  const starts = lineStarts(content);
  let lineIndex = starts.length - 1;
  while (lineIndex > 0 && starts[lineIndex] > offset) lineIndex -= 1;
  return {
    offset,
    line: lineIndex + 1,
    column: offset - starts[lineIndex] + 1
  };
}

function offsetAtLineColumn(content: string, lineValue: number, columnValue: number): number {
  const starts = lineStarts(content);
  const lines = content.split(/\r\n|\r|\n/);
  const line = Math.max(1, Math.min(Number.isFinite(lineValue) ? Math.floor(lineValue) : 1, starts.length));
  const maxColumn = (lines[line - 1] || '').length + 1;
  const column = Math.max(1, Math.min(Number.isFinite(columnValue) ? Math.floor(columnValue) : 1, maxColumn));
  return starts[line - 1] + column - 1;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  const pattern = /\r\n|\r|\n/g;
  let match = pattern.exec(content);
  while (match) {
    starts.push(match.index + match[0].length);
    match = pattern.exec(content);
  }
  return starts;
}

function symbolAt(content: string, offsetValue: number): string {
  const offset = Math.max(0, Math.min(Number(offsetValue || 0), content.length));
  const left = content.slice(0, offset).match(/[A-Za-z_][A-Za-z0-9_:]*$/)?.[0] || '';
  const right = content.slice(offset).match(/^[A-Za-z0-9_:]+/)?.[0] || '';
  const symbol = `${left}${right}`;
  return /^[A-Za-z_][A-Za-z0-9_:]*$/.test(symbol) ? symbol : '';
}

function normalizeFocus(value: unknown, fallback: AiTeacherEditorFocus): AiTeacherEditorFocus {
  return value === 'focused' || value === 'blurred' || value === 'not-mounted' ? value : fallback;
}

function normalizeInteractionTarget(value: unknown): AiTeacherInteractionTarget {
  return value === 'code'
    || value === 'diagnostic'
    || value === 'course-content'
    || value === 'ai-panel'
    || value === 'non-code'
    || value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeCursorOrigin(value: unknown, fallback: AiTeacherCursorOrigin): AiTeacherCursorOrigin {
  return value === 'current' || value === 'frozen-explicit' || value === 'last-known' || value === 'default' ? value : fallback;
}

function normalizeSelectionOrigin(value: unknown, fallback: AiTeacherSelectionOrigin): AiTeacherSelectionOrigin {
  return value === 'current' || value === 'frozen-explicit' || value === 'last-known' || value === 'none'
    ? value
    : fallback;
}

function normalizeGroundingState(options: {
  focus: AiTeacherEditorFocus;
  interactionTarget: AiTeacherInteractionTarget;
  capturedRevision: string;
  currentRevision: string;
  sourceOrigin: AiTeacherCursorOrigin;
}): { cursorOrigin: AiTeacherCursorOrigin; degradedReason: string } {
  if (options.sourceOrigin === 'default' || options.focus === 'not-mounted') {
    return { cursorOrigin: 'default', degradedReason: 'default_context' };
  }
  if (options.capturedRevision !== options.currentRevision) {
    return { cursorOrigin: 'last-known', degradedReason: 'stale_document' };
  }
  if (options.sourceOrigin === 'frozen-explicit' && options.interactionTarget === 'ai-panel') {
    return { cursorOrigin: 'frozen-explicit', degradedReason: 'explicit_context_frozen' };
  }
  if (options.interactionTarget !== 'code' && options.interactionTarget !== 'unknown') {
    return { cursorOrigin: 'last-known', degradedReason: 'non_code_interaction' };
  }
  if (options.focus !== 'focused') {
    return { cursorOrigin: 'last-known', degradedReason: 'editor_blurred' };
  }
  if (options.interactionTarget !== 'code') {
    return { cursorOrigin: 'last-known', degradedReason: 'interaction_unknown' };
  }
  if (options.sourceOrigin !== 'current') {
    return { cursorOrigin: 'last-known', degradedReason: 'source_not_current' };
  }
  return { cursorOrigin: 'current', degradedReason: '' };
}

function normalizedSelectionOrigin(options: {
  sourceSelectionOrigin: AiTeacherSelectionOrigin;
  hasSelection: boolean;
  cursorOrigin: AiTeacherCursorOrigin;
}): AiTeacherSelectionOrigin {
  if (!options.hasSelection || options.cursorOrigin === 'default') return 'none';
  if (options.cursorOrigin === 'current' && options.sourceSelectionOrigin === 'current') return 'current';
  if (options.cursorOrigin === 'frozen-explicit' && options.sourceSelectionOrigin === 'frozen-explicit') {
    return 'frozen-explicit';
  }
  return 'last-known';
}

function validIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return '';
  return value;
}

function teacherLearningGoals(lesson?: Lesson | null): string[] {
  return [
    ...(lesson?.tasks || []).map((task) => task.prompt || task.title || task.description || ''),
    ...(lesson?.learningBlocks || []).map((block) => block.content || block.body || block.text || '')
  ].filter(Boolean).slice(0, 12).map((item) => String(item).slice(0, 240));
}

function inferCourseId(lessonId?: string): string {
  const match = String(lessonId || '').match(/^(course-\d+)/);
  return match?.[1] || '';
}
