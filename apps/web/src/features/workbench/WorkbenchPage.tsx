import { Suspense, lazy, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type TransitionEvent } from 'react';
import { ArrowDown, BookOpen, Check, CheckCircle2, Circle, CircleAlert, CircleCheckBig, Code2, Crosshair, ExternalLink, LayoutTemplate, Network, PackageCheck, PackageOpen, PanelRightOpen, PencilLine, RefreshCw, RotateCcw, Save, Search, ShieldCheck, WandSparkles, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  useCourseQuery,
  type DraftSnapshot,
  useDraftQuery,
  useFinalProjectQuery,
  useFinalProjectValidationRequest,
  useLessonQuery,
  useLessonValidationRequest,
  useProgressQuery
} from '../../app/data-hooks';
import { useAppApiClient } from '../../app/use-api-client';
import type { Course, LearningBlock, Lesson, LessonTask, ReferenceItem, SemanticOutline, SemanticOutlineNode, ValidationFinding, ValidationResult, WorkspaceFile, WorkspaceSnapshot } from '../../lib/course/types';
import { cloneWorkspaceFiles, resolveWorkspaceImportClosure, workspaceTemplateSignature } from '../../lib/course/workspace';
import {
  buildSysmlNavigationIndex,
  findSysmlDefinition,
  findSysmlReferences,
  renameSysmlSymbolInCode,
  type SysmlReference,
  type SysmlSymbol
} from '../../lib/sysml/navigation-index';
import { normalizeSysmlPunctuation } from '../../lib/sysml/text';
import { aiTeacherDiagnosticId, type AiTeacherInteractionTarget } from '../../lib/ai-teacher/envelope';
import { assetUrlForPack, ErrorState, ReferenceList, SilentLoadingState } from '../shared/ui';
import { AiTeacherPanel } from '../ai-teacher/AiTeacherPanel';
import { SysmlCodeMirror, type SysmlCodeMirrorHandle, type SysmlEditorContext, type SysmlEditorContextMenu } from './SysmlCodeMirror';
import { ViewPane } from './ViewPane';
import type { MuiModelTreeItem } from './MuiModelOutlineTree';

const MuiModelOutlineTree = lazy(() => import('./MuiModelOutlineTree').then((module) => ({ default: module.MuiModelOutlineTree })));

type EditorStateName = 'template' | 'draft' | 'staleDraft' | 'editing' | 'saved';
type ValidationTone = 'idle' | 'ok' | 'warn' | 'fail';
type WorkbenchMode = 'lesson' | 'final-project' | 'bench';
type WorkbenchCopyScope = 'course' | 'bench';
type SemanticOutlineRefreshState = 'idle' | 'waiting' | 'refreshing' | 'current' | 'invalid' | 'unavailable' | 'error';

const AUTO_SEMANTIC_OUTLINE_DEBOUNCE_MS = 1_000;
const AUTO_SEMANTIC_OUTLINE_TIMEOUT_MS = 45_000;

interface WorkbenchPageProps {
  entity: Lesson;
  draftId: string;
  mode: WorkbenchMode;
  validateWorkspace: (workspace: WorkspaceSnapshot) => Promise<ValidationResult>;
  course?: Course | null;
  benchHeader?: BenchHeaderConfig;
}

export interface BenchHeaderConfig {
  description: string;
  selectedTemplateId: string;
  selectedTemplateTitle: string;
  templates: Array<{ id: string; title: string }>;
  onTemplateChange: (templateId: string) => void;
}

function preferredPlantUmlViewName(entity: Lesson) {
  const presentation = entity.viewPresentation as { primaryViewQualifiedName?: unknown; primaryViewName?: unknown } | undefined;
  const augmentedSource = entity.augmentedSourceFile as { primaryView?: unknown } | undefined;
  return [presentation?.primaryViewQualifiedName, presentation?.primaryViewName, augmentedSource?.primaryView]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim())) || '';
}

interface ReferenceRow {
  name: string;
  line: number;
  from: number;
  to: number;
  group: string;
}

const RESET_COPY: Record<WorkbenchCopyScope, { noun: string; confirm: string; status: string; remoteFail: string }> = {
  course: {
    noun: '课程模板',
    confirm: '重置为课程模板会清空当前编辑器草稿，并恢复初始代码模板。\n\n确认要继续吗？',
    status: '已重置为课程模板',
    remoteFail: '已重置可见模板；远端草稿清理失败，可稍后重试。'
  },
  bench: {
    noun: '建模模板',
    confirm: '重置为建模模板会清空当前编辑器草稿，并恢复初始代码模板。\n\n确认要继续吗？',
    status: '已重置为建模模板',
    remoteFail: '已重置可见建模模板；远端草稿清理失败，可稍后重试。'
  }
};

const SAVED_STATUS_COPY: Record<WorkbenchCopyScope, { passed: string; pending: string }> = {
  course: {
    passed: '已通过并保存',
    pending: '草稿已保存，待校验'
  },
  bench: {
    passed: '建模草稿已通过并保存',
    pending: '建模草稿已保存，待校验'
  }
};

export function LessonWorkbenchPage({ lessonId }: { lessonId: string }) {
  const lessonQuery = useLessonQuery(lessonId);
  const courseQuery = useCourseQuery(lessonQuery.data?.courseId || '');
  const validateWorkspace = useLessonValidationRequest(lessonId);
  if (lessonQuery.isLoading) return <SilentLoadingState />;
  if (lessonQuery.error) return <ErrorState title="Lesson 加载失败" error={lessonQuery.error} />;
  if (!lessonQuery.data) return <ErrorState title="Lesson 加载失败" error="Lesson not found" />;
  return (
    <WorkbenchPage
      entity={lessonQuery.data}
      draftId={lessonQuery.data.id || lessonId}
      mode="lesson"
      validateWorkspace={validateWorkspace}
      course={courseQuery.data || null}
    />
  );
}

export function FinalProjectWorkbenchPage() {
  const projectQuery = useFinalProjectQuery();
  const validateWorkspace = useFinalProjectValidationRequest();
  if (projectQuery.isLoading) return <SilentLoadingState />;
  if (projectQuery.error) return <ErrorState title="期末项目加载失败" error={projectQuery.error} />;
  if (!projectQuery.data) return <ErrorState title="期末项目加载失败" error="Final project not found" />;
  return (
    <WorkbenchPage
      entity={{ ...projectQuery.data, id: projectQuery.data.id || 'final-project' }}
      draftId="final-project"
      mode="final-project"
      validateWorkspace={validateWorkspace}
    />
  );
}

export function WorkbenchPage({ entity, draftId, mode, validateWorkspace, course = null, benchHeader }: WorkbenchPageProps) {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const modelNavigationInTeacher = mode === 'lesson' || mode === 'bench';
  const editorRegionRef = useRef<HTMLDivElement | null>(null);
  const viewPaneRegionRef = useRef<HTMLElement | null>(null);
  const draftQuery = useDraftQuery(draftId);
  const progressQuery = useProgressQuery();
  const editorRef = useRef<SysmlCodeMirrorHandle | null>(null);
  const templateFiles = useMemo(() => {
    const cloned = cloneWorkspaceFiles(entity.workspace);
    return cloned.length ? cloned : [{ path: 'main.sysml', content: '', editable: true, source: 'workspace' }];
  }, [entity.workspace]);
  const entryFile = entity.workspace?.entryFile || templateFiles[0]?.path || 'main.sysml';
  const templateSignature = useMemo(() => workspaceTemplateSignature(templateFiles, entryFile), [templateFiles, entryFile]);
  const [files, setFiles] = useState<WorkspaceFile[]>(() => templateFiles);
  const [activePath, setActivePath] = useState(entryFile);
  const [editorStateName, setEditorStateName] = useState<EditorStateName>('template');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [activeDiagnosticId, setActiveDiagnosticId] = useState<string | null>(null);
  const [validationTone, setValidationTone] = useState<ValidationTone>('idle');
  const [status, setStatus] = useState('未校验');
  const [cursorSymbol, setCursorSymbol] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [editorContext, setEditorContext] = useState<SysmlEditorContext | null>(null);
  const [editorInteraction, setEditorInteraction] = useState<WorkbenchEditorInteraction>(() => ({
    target: 'unknown',
    capturedAt: new Date().toISOString()
  }));
  const [activeNavTab, setActiveNavTab] = useState<'resource-tree' | 'overview' | 'references'>('resource-tree');
  const [semanticOutlineSnapshot, setSemanticOutlineSnapshot] = useState<SemanticOutline | null>(null);
  const [semanticOutlineWorkspaceSignature, setSemanticOutlineWorkspaceSignature] = useState<string | null>(null);
  const [semanticOutlineRefreshState, setSemanticOutlineRefreshState] = useState<SemanticOutlineRefreshState>('idle');
  const [semanticOutlineRefreshMessage, setSemanticOutlineRefreshMessage] = useState('等待官方语义更新');
  const [semanticOutlineRefreshNonce, setSemanticOutlineRefreshNonce] = useState(0);
  const [showExpertOutlineNodes, setShowExpertOutlineNodes] = useState(false);
  const [showDependencyOutlineNodes, setShowDependencyOutlineNodes] = useState(true);
  const [isModelNavOpen, setIsModelNavOpen] = useState(!modelNavigationInTeacher);
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isProgressUpdating, setIsProgressUpdating] = useState(false);
  const [manualProgressStep, setManualProgressStep] = useState<number | null>(null);
  const [benchExported, setBenchExported] = useState(false);
  const [autoViewRenderRequestId, setAutoViewRenderRequestId] = useState(0);
  const [autoViewRenderTarget, setAutoViewRenderTarget] = useState<'plantuml' | 'syson'>('plantuml');
  const [selectedViewTarget, setSelectedViewTarget] = useState<'plantuml' | 'syson'>('plantuml');
  const [showViewJumpButton, setShowViewJumpButton] = useState(false);
  const [viewJumpButtonLeft, setViewJumpButtonLeft] = useState(0);
  const [editorContextMenu, setEditorContextMenu] = useState<SysmlEditorContextMenu | null>(null);
  const semanticOutlineRequestRevisionRef = useRef(0);
  const semanticOutlineCompletedRequestKeyRef = useRef('');
  const autoSaveRevisionRef = useRef(0);
  const copyScope: WorkbenchCopyScope = mode === 'bench' ? 'bench' : 'course';
  const resetCopy = RESET_COPY[copyScope];
  const savedStatusCopy = SAVED_STATUS_COPY[copyScope];

  useEffect(() => {
    setManualProgressStep(null);
    setBenchExported(false);
  }, [draftId]);

  useEffect(() => {
    const viewPane = viewPaneRegionRef.current;
    if (!viewPane) return;

    const updateViewJumpVisibility = () => {
      const viewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
      const viewportWidth = Math.max(window.innerWidth, document.documentElement.clientWidth);
      const editorRect = editorRegionRef.current?.getBoundingClientRect();
      const editorHeight = editorRect?.height || 0;
      const viewPaneTop = viewPane.getBoundingClientRect().top;
      const shouldShow = editorHeight > viewportHeight * 1.1 && viewPaneTop > viewportHeight - 72;
      const editorCenter = editorRect ? editorRect.left + editorRect.width / 2 : viewportWidth / 2;
      const safeEditorCenter = Math.min(Math.max(editorCenter, 32), viewportWidth - 32);
      setViewJumpButtonLeft((current) => Math.abs(current - safeEditorCenter) < 0.5 ? current : safeEditorCenter);
      setShowViewJumpButton((current) => current === shouldShow ? current : shouldShow);
    };

    updateViewJumpVisibility();
    window.addEventListener('scroll', updateViewJumpVisibility, { passive: true });
    window.addEventListener('resize', updateViewJumpVisibility);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateViewJumpVisibility);
    resizeObserver?.observe(viewPane);
    if (editorRegionRef.current) resizeObserver?.observe(editorRegionRef.current);
    return () => {
      window.removeEventListener('scroll', updateViewJumpVisibility);
      window.removeEventListener('resize', updateViewJumpVisibility);
      resizeObserver?.disconnect();
    };
  }, [draftId]);

  const scrollToViewPane = () => {
    const viewPane = viewPaneRegionRef.current;
    if (!viewPane) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const distanceToView = Math.abs(viewPane.getBoundingClientRect().top);
    const jumpImmediately = reducedMotion || distanceToView > window.innerHeight * 6;
    viewPane.scrollIntoView({
      block: 'start',
      behavior: jumpImmediately ? 'auto' : 'smooth'
    });
    if (reducedMotion) return;

    let layoutChecks = 0;
    const keepViewAnchoredWhileLayoutSettles = () => {
      if (!viewPane.isConnected) return;
      const viewPaneTop = viewPane.getBoundingClientRect().top;
      if (viewPaneTop < 0 || viewPaneTop > window.innerHeight * 0.75) {
        viewPane.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
      layoutChecks += 1;
      if (layoutChecks < 24) window.setTimeout(keepViewAnchoredWhileLayoutSettles, 100);
    };
    window.setTimeout(keepViewAnchoredWhileLayoutSettles, 500);
  };

  useEffect(() => {
    if (draftQuery.isFetched) return;
    setFiles(templateFiles);
    setActivePath(entryFile);
    setEditorStateName('template');
    setValidation(null);
    setValidationTone('idle');
    setStatus('未校验');
    setSelectedSymbol('');
    setCursorSymbol('');
    setEditorContext(null);
    setSemanticOutlineSnapshot(null);
    setSemanticOutlineWorkspaceSignature(null);
    setSemanticOutlineRefreshState('idle');
    setSemanticOutlineRefreshMessage('等待官方语义更新');
    semanticOutlineCompletedRequestKeyRef.current = '';
  }, [draftQuery.isFetched, draftId, templateFiles, entryFile]);

  useEffect(() => {
    if (!draftQuery.isFetched) return;
    const restored = restoreFilesFromDraft(templateFiles, draftQuery.data, entryFile);
    setFiles(restored.files);
    setActivePath(restored.activePath);
    setEditorStateName(restored.state);
    setValidation(null);
    setValidationTone(restored.state === 'template' ? 'idle' : 'warn');
    setStatus(restored.state === 'template' ? '未校验' : '草稿待校验');
    setSelectedSymbol('');
    setCursorSymbol('');
    setEditorContext(null);
    setSemanticOutlineSnapshot(null);
    setSemanticOutlineWorkspaceSignature(null);
    setSemanticOutlineRefreshState('idle');
    setSemanticOutlineRefreshMessage('等待官方语义更新');
    semanticOutlineCompletedRequestKeyRef.current = '';
  }, [draftQuery.isFetched, draftQuery.dataUpdatedAt, draftId, templateFiles, entryFile]);

  const activeIndex = Math.max(0, files.findIndex((file) => file.path === activePath));
  const activeFile = files[activeIndex] || files[0] || { path: entryFile, content: '' };
  const activeFileReadOnly = activeFile.editable === false;
  const dependencyPackageRoots = useMemo(() => workspaceDependencyPackageRoots(files), [files]);
  const navigationIndex = useMemo(() => buildSysmlNavigationIndex(activeFile.content || ''), [activeFile.content]);
  const currentWorkspaceSignature = useMemo(() => workspaceTemplateSignature(files, entryFile), [files, entryFile]);
  const semanticOutlineIsStale = Boolean(semanticOutlineSnapshot && semanticOutlineWorkspaceSignature && semanticOutlineWorkspaceSignature !== currentWorkspaceSignature);
  const activeSymbol = selectedSymbol || cursorSymbol;
  const references = useMemo(() => referenceRows(navigationIndex, activeSymbol), [navigationIndex, activeSymbol]);
  const diagnostics = normalizeDiagnostics(validation);
  const visibleDiagnostics = diagnostics.length ? diagnostics : validationTone === 'fail' ? [{
    file: activePath || entryFile,
    line: 1,
    column: 1,
    severity: 'error',
    source: 'platform',
    message: status || '校验未通过，请检查当前模型。'
  }] as ValidationFinding[] : [];
  const officialValidationPassed = Boolean(validation?.syntaxValid && validation?.semanticValid);
  const validationPassed = Boolean(validation?.syntaxValid && validation?.semanticValid && (mode === 'bench' || validation?.coursePassed));
  const lessonCompleted = mode === 'lesson'
    && Array.isArray(progressQuery.data?.completedLessons)
    && progressQuery.data.completedLessons.includes(draftId);

  useEffect(() => {
    if (mode !== 'lesson' || !progressQuery.isFetched) return;
    if (lessonCompleted) {
      setManualProgressStep(null);
      return;
    }
    const persistedStep = progressQuery.data?.lessonProgressSteps?.[draftId];
    if (Number.isInteger(persistedStep) && Number(persistedStep) >= 0 && Number(persistedStep) < 4) {
      setManualProgressStep(Number(persistedStep));
    }
  }, [draftId, lessonCompleted, mode, progressQuery.dataUpdatedAt, progressQuery.isFetched]);

  useEffect(() => {
    if (!draftQuery.isFetched || editorStateName !== 'editing' || activeFileReadOnly || !files.length) return;
    const revision = ++autoSaveRevisionRef.current;
    const timer = window.setTimeout(() => {
      const workspace: WorkspaceSnapshot = {
        entryFile,
        activeFilePath: activePath || entryFile,
        files: files.map((file, index) => ({
          ...file,
          content: index === activeIndex ? editorRef.current?.getValue() || file.content : file.content
        }))
      };
      setIsSaving(true);
      void api.request(`/api/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PUT',
        body: { ...workspace, templateSignature }
      }).then(() => {
        if (autoSaveRevisionRef.current !== revision) return;
        setFiles(workspace.files);
        setEditorStateName('saved');
        setValidationTone(validationPassed ? 'ok' : 'warn');
        setStatus(validationPassed ? '已自动保存并通过校验' : '已自动保存，待校验');
      }).catch(() => {
        if (autoSaveRevisionRef.current !== revision) return;
        setValidationTone('warn');
        setStatus('自动保存失败，请点击工具栏中的“手动保存”');
      }).finally(() => {
        if (autoSaveRevisionRef.current === revision) setIsSaving(false);
      });
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [activeFileReadOnly, activeIndex, activePath, api, draftId, draftQuery.isFetched, editorStateName, entryFile, files, templateSignature, validationPassed]);

  useEffect(() => {
    setActiveDiagnosticId(null);
  }, [validation]);

  useEffect(() => {
    if (!editorContextMenu) return;
    const closeMenu = () => setEditorContextMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [editorContextMenu]);

  useEffect(() => {
    if (!draftQuery.isFetched || !files.length || (!modelNavigationInTeacher && !isModelNavOpen) || activeNavTab !== 'resource-tree') return;
    if (semanticOutlineRefreshNonce === 0 && semanticOutlineSnapshot?.status === 'available' && semanticOutlineWorkspaceSignature === currentWorkspaceSignature) {
      setSemanticOutlineRefreshState('current');
      setSemanticOutlineRefreshMessage('已与当前代码同步');
      return;
    }

    const attemptKey = `${currentWorkspaceSignature}:${semanticOutlineRefreshNonce}`;
    if (semanticOutlineCompletedRequestKeyRef.current === attemptKey) return;
    const requestRevision = ++semanticOutlineRequestRevisionRef.current;
    const controller = new AbortController();
    let requestTimeoutTimer: number | null = null;
    let requestTimedOut = false;
    setSemanticOutlineRefreshState('waiting');
    setSemanticOutlineRefreshMessage('等待官方语义更新');

    const timer = window.setTimeout(() => {
      setSemanticOutlineRefreshState('refreshing');
      setSemanticOutlineRefreshMessage('正在更新官方语义树');
      const requestFiles = files.map((file) => ({ ...file, content: String(file.content || '') }));
      void (async () => {
        try {
          const expectedContentHash = await officialOutlineContentHash(
            resolveWorkspaceImportClosure(requestFiles, entryFile)
          );
          if (controller.signal.aborted || requestRevision !== semanticOutlineRequestRevisionRef.current) return;
          requestTimeoutTimer = window.setTimeout(() => {
            requestTimedOut = true;
            controller.abort();
          }, AUTO_SEMANTIC_OUTLINE_TIMEOUT_MS);
          const result = await api.request<ValidationResult>('/api/model-outline', {
            method: 'POST',
            body: {
              entryFile,
              activeFilePath: activePath || entryFile,
              files: requestFiles
            },
            signal: controller.signal
          });
          if (controller.signal.aborted || requestRevision !== semanticOutlineRequestRevisionRef.current) return;

          const outline = result.semanticOutline || null;
          if (outline?.contentHash && expectedContentHash && outline.contentHash !== expectedContentHash) {
            semanticOutlineCompletedRequestKeyRef.current = attemptKey;
            setSemanticOutlineRefreshState('error');
            setSemanticOutlineRefreshMessage('返回结果已过期，已保留上次有效结构');
            return;
          }
          if (outline?.status === 'available') {
            semanticOutlineCompletedRequestKeyRef.current = attemptKey;
            setSemanticOutlineSnapshot(outline);
            setSemanticOutlineWorkspaceSignature(currentWorkspaceSignature);
            setSemanticOutlineRefreshState('current');
            setSemanticOutlineRefreshMessage('已与当前代码同步');
            return;
          }

          const hasLastAvailableOutline = semanticOutlineSnapshot?.status === 'available';
          semanticOutlineCompletedRequestKeyRef.current = attemptKey;
          setSemanticOutlineSnapshot((current) => current?.status === 'available' ? current : outline);
          if (outline?.status === 'invalid') {
            setSemanticOutlineRefreshState('invalid');
            setSemanticOutlineRefreshMessage(hasLastAvailableOutline
              ? '当前代码未通过官方解析，显示上次有效结构'
              : '当前代码未通过官方解析');
            return;
          }
          setSemanticOutlineRefreshState('unavailable');
          setSemanticOutlineRefreshMessage(hasLastAvailableOutline
            ? '官方语义服务不可用，显示上次有效结构'
            : '官方语义服务不可用');
        } catch (error) {
          if (requestTimedOut && requestRevision === semanticOutlineRequestRevisionRef.current) {
            semanticOutlineCompletedRequestKeyRef.current = attemptKey;
            setSemanticOutlineRefreshState('error');
            setSemanticOutlineRefreshMessage(semanticOutlineSnapshot?.status === 'available'
              ? '自动更新超时，显示上次有效结构；可点击刷新重试'
              : '自动生成超时，请点击刷新重试');
            return;
          }
          if (isAbortError(error) || controller.signal.aborted || requestRevision !== semanticOutlineRequestRevisionRef.current) return;
          semanticOutlineCompletedRequestKeyRef.current = attemptKey;
          setSemanticOutlineRefreshState('error');
          setSemanticOutlineRefreshMessage(semanticOutlineSnapshot?.status === 'available'
            ? '自动更新失败，显示上次有效结构'
            : '自动更新失败，请重试');
        } finally {
          if (requestTimeoutTimer !== null) window.clearTimeout(requestTimeoutTimer);
        }
      })();
    }, AUTO_SEMANTIC_OUTLINE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (requestTimeoutTimer !== null) window.clearTimeout(requestTimeoutTimer);
      controller.abort();
    };
  }, [
    activeNavTab,
    api,
    currentWorkspaceSignature,
    draftQuery.isFetched,
    entryFile,
    isModelNavOpen,
    modelNavigationInTeacher,
    semanticOutlineRefreshNonce,
    semanticOutlineSnapshot?.status,
    semanticOutlineWorkspaceSignature
  ]);

  if (!files.length) return <ErrorState title="编辑器初始化失败" error="Workspace template is empty" />;
  if (draftQuery.error) return <ErrorState title="草稿加载失败" error={draftQuery.error} />;

  const updateActiveFile = (content: string, nextState: EditorStateName = 'editing') => {
    if (activeFileReadOnly) return;
    setFiles((current) => current.map((file, index) => index === activeIndex ? { ...file, content } : file));
    setEditorStateName(nextState);
    setValidation(null);
    setManualProgressStep(null);
    setBenchExported(false);
    setValidationTone('warn');
    setStatus('修改后待校验');
    setSemanticOutlineRefreshState('waiting');
    setSemanticOutlineRefreshMessage('等待官方语义更新');
  };

  const workspaceSnapshot = (): WorkspaceSnapshot => ({
    entryFile,
    activeFilePath: activePath || entryFile,
    files: files.map((file, index) => ({
      ...file,
      content: index === activeIndex ? editorRef.current?.getValue() || file.content : file.content
    }))
  });

  const saveDraft = async () => {
    setIsSaving(true);
    try {
      const workspace = workspaceSnapshot();
      await api.request(`/api/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PUT',
        body: { ...workspace, templateSignature }
      });
      setFiles(workspace.files);
      setEditorStateName('saved');
      setValidationTone(validationPassed ? 'ok' : 'warn');
      setStatus(validationPassed ? savedStatusCopy.passed : savedStatusCopy.pending);
      await queryClient.invalidateQueries({ queryKey: ['draft'] });
    } finally {
      setIsSaving(false);
    }
  };

  const resetTemplate = async () => {
    const confirmed = window.confirm(resetCopy.confirm);
    if (!confirmed) return;
    setFiles(templateFiles);
    setActivePath(entryFile);
    setEditorStateName('template');
    setValidation(null);
    setValidationTone('idle');
    setBenchExported(false);
    setStatus(resetCopy.status);
    setSelectedSymbol('');
    setCursorSymbol('');
    setEditorContext(null);
    setSemanticOutlineSnapshot(null);
    setSemanticOutlineWorkspaceSignature(null);
    setSemanticOutlineRefreshState('waiting');
    setSemanticOutlineRefreshMessage('等待官方语义更新');
    semanticOutlineCompletedRequestKeyRef.current = '';
    try {
      await api.request(`/api/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['draft'] });
    } catch {
      setStatus(resetCopy.remoteFail);
      setValidationTone('warn');
    }
  };

  const runValidation = async (renderTarget: 'plantuml' | 'syson' = 'plantuml'): Promise<boolean> => {
    setManualProgressStep(null);
    setIsValidating(true);
    setValidationTone('warn');
    setStatus('校验中...');
    setSemanticOutlineRefreshState('refreshing');
    setSemanticOutlineRefreshMessage('正在更新官方语义树');
    try {
      const workspace = workspaceSnapshot();
      setFiles(workspace.files);
      const result = await validateWorkspace(workspace);
      const officialPassed = Boolean(result.syntaxValid && result.semanticValid);
      const passed = Boolean(officialPassed && (mode === 'bench' || result.coursePassed));
      const normalizedResult = ensureValidationDiagnostics(result, passed, activePath || entryFile);
      setValidation(normalizedResult);
      const outline = normalizedResult.semanticOutline || null;
      if (outline?.status === 'available') {
        setSemanticOutlineSnapshot(outline);
        setSemanticOutlineWorkspaceSignature(workspaceTemplateSignature(workspace.files, workspace.entryFile || entryFile));
        setSemanticOutlineRefreshState('current');
        setSemanticOutlineRefreshMessage('已与当前代码同步');
      } else {
        const hasLastAvailableOutline = semanticOutlineSnapshot?.status === 'available';
        setSemanticOutlineSnapshot((current) => current?.status === 'available' ? current : outline);
        setSemanticOutlineRefreshState(outline?.status === 'invalid' ? 'invalid' : 'unavailable');
        setSemanticOutlineRefreshMessage(outline?.status === 'invalid'
          ? hasLastAvailableOutline ? '当前代码未通过官方解析，显示上次有效结构' : '当前代码未通过官方解析'
          : hasLastAvailableOutline ? '官方语义服务不可用，显示上次有效结构' : '官方语义服务不可用');
      }
      setValidationTone(passed ? 'ok' : officialPassed ? 'warn' : 'fail');
      setStatus(passed
        ? mode === 'bench' ? '严格语法/语义校验通过' : '严格校验与课程规则通过'
        : officialPassed
          ? '语法/语义校验通过；课程任务尚未完成，仍可查看模型视图'
          : mode === 'bench' ? '校验未通过，请查看诊断提示' : '校验未通过，请查看诊断与课程目标提示');
      if (officialPassed) {
        setAutoViewRenderTarget(renderTarget);
        setAutoViewRenderRequestId((current) => current + 1);
      }
      return officialPassed;
    } catch (error) {
      const message = error instanceof Error ? error.message : '校验失败';
      setValidation({
        syntaxValid: false,
        semanticValid: false,
        coursePassed: false,
        diagnostics: [{
          file: activePath || entryFile,
          line: 1,
          column: 1,
          severity: 'error',
          source: 'platform',
          message
        }]
      });
      setSemanticOutlineRefreshState('error');
      setSemanticOutlineRefreshMessage(semanticOutlineSnapshot?.status === 'available'
        ? '更新失败，显示上次有效结构'
        : '官方语义树更新失败');
      setValidationTone('fail');
      setStatus(message);
      return false;
    } finally {
      setIsValidating(false);
    }
  };

  const markComplete = async () => {
    if (!validationPassed || mode !== 'lesson' || isProgressUpdating) return;
    setIsProgressUpdating(true);
    try {
      const progress = progressQuery.data || {};
      const completedLessons = Array.isArray(progress.completedLessons) ? [...progress.completedLessons] : [];
      if (!completedLessons.includes(draftId)) completedLessons.push(draftId);
      const lessonProgressSteps = { ...(progress.lessonProgressSteps || {}), [draftId]: 4 };
      await api.request('/api/progress', { method: 'PUT', body: { ...progress, completedLessons, lessonProgressSteps } });
      setManualProgressStep(null);
      await queryClient.invalidateQueries({ queryKey: ['progress'] });
      setStatus('Lesson 已标记完成');
      setValidationTone('ok');
    } catch {
      setStatus('完成状态保存失败，请重试');
      setValidationTone('fail');
    } finally {
      setIsProgressUpdating(false);
    }
  };

  const returnToProgressStep = async (stepIndex: number, stepLabel: string) => {
    if (!lessonCompleted || mode !== 'lesson' || isProgressUpdating || stepIndex >= 4) return;
    const confirmed = window.confirm(`确认回到“${stepLabel}”吗？\n\n完成状态将取消，学习进度会回到该节点。`);
    if (!confirmed) return;
    setIsProgressUpdating(true);
    try {
      const progress = progressQuery.data || {};
      const completedLessons = Array.isArray(progress.completedLessons)
        ? progress.completedLessons.filter((lessonId) => lessonId !== draftId)
        : [];
      const lessonProgressSteps = { ...(progress.lessonProgressSteps || {}), [draftId]: stepIndex };
      await api.request('/api/progress', { method: 'PUT', body: { ...progress, completedLessons, lessonProgressSteps } });
      setManualProgressStep(stepIndex);
      await queryClient.invalidateQueries({ queryKey: ['progress'] });
      setStatus(`已回到“${stepLabel}”`);
      setValidationTone(stepIndex >= 2 ? 'ok' : 'warn');
    } catch {
      setStatus('学习进度回退失败，完成状态未改变');
      setValidationTone('fail');
    } finally {
      setIsProgressUpdating(false);
    }
  };

  const exportWorkspace = () => {
    const workspace = workspaceSnapshot();
    const payload = JSON.stringify(workspace, null, 2);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${draftId || 'workspace'}-workspace.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('已导出当前工作区快照。');
    setValidationTone('ok');
    if (mode === 'bench' && validationPassed) setBenchExported(true);
  };

  const findTextInEditor = (find: string) => {
    if (!find) {
      setStatus('请先选中要全局查找的代码片段。');
      setValidationTone('warn');
      return;
    }
    const value = editorRef.current?.getValue() || activeFile.content || '';
    const from = value.indexOf(find);
    const count = value.split(find).length - 1;
    if (from >= 0) {
      editorRef.current?.focusRange(from, from + find.length);
    }
    if (/^[A-Za-z_]\w*$/.test(find)) setSelectedSymbol(find);
    setStatus(count ? `找到 ${formatContextText(find)} 的 ${count} 处文本匹配。` : `没有找到 ${formatContextText(find)}。`);
    setValidationTone(count ? 'ok' : 'warn');
  };

  const replaceAllInEditor = (find: string, replaceWith: string) => {
    if (activeFileReadOnly) {
      setStatus('当前文件是只读依赖模型，不能替换文本。');
      setValidationTone('warn');
      return;
    }
    if (!find) {
      setStatus('请先选中要全局替换的代码片段。');
      setValidationTone('warn');
      return;
    }
    const value = editorRef.current?.getValue() || activeFile.content || '';
    const count = value.split(find).length - 1;
    if (count <= 0) {
      setStatus(`没有找到 ${formatContextText(find)}。`);
      setValidationTone('warn');
      return;
    }
    updateActiveFile(value.split(find).join(replaceWith));
    if (/^[A-Za-z_]\w*$/.test(replaceWith)) setSelectedSymbol(replaceWith);
    setStatus(`已将 ${formatContextText(find)} 全局替换为 ${formatContextText(replaceWith)}，共 ${count} 处。`);
    setValidationTone('ok');
  };

  const findFromContextMenu = () => {
    const find = contextMenuLookupText(editorContextMenu);
    setEditorContextMenu(null);
    findTextInEditor(find);
  };

  const replaceFromContextMenu = () => {
    const find = contextMenuLookupText(editorContextMenu);
    setEditorContextMenu(null);
    if (!find) {
      setStatus('请先选中要全局替换的代码片段。');
      setValidationTone('warn');
      return;
    }
    const replaceWith = window.prompt(`将所有 “${formatContextText(find)}” 替换为：`, find);
    if (replaceWith === null) return;
    if (replaceWith === find) {
      setStatus('替换内容未变化。');
      setValidationTone('warn');
      return;
    }
    replaceAllInEditor(find, replaceWith);
  };

  const renameFromContextMenu = () => {
    const oldName = contextMenuRenameName(editorContextMenu);
    setEditorContextMenu(null);
    if (activeFileReadOnly) {
      setStatus('当前文件是只读依赖模型，不能重命名符号。');
      setValidationTone('warn');
      return;
    }
    if (!oldName) {
      setStatus('请先在代码区右键一个可重命名的 SysML 标识符。');
      setValidationTone('warn');
      return;
    }
    const nextName = window.prompt(`将 ${oldName} 重命名为：`, oldName);
    if (!nextName || nextName === oldName) return;
    if (!isSimpleSysmlIdentifier(nextName)) {
      setStatus('新名称必须是 ASCII 标识符，例如 BatteryPack。');
      setValidationTone('fail');
      return;
    }
    const result = renameSysmlSymbolInCode(editorRef.current?.getValue() || activeFile.content, oldName, nextName);
    if (!result.count) {
      setStatus(`没有找到可重命名的 ${oldName}。`);
      setValidationTone('warn');
      return;
    }
    updateActiveFile(result.content);
    setSelectedSymbol(nextName);
    setActiveNavTab('references');
    setStatus(`已将 ${oldName} 重命名为 ${nextName}，共 ${result.count} 处定义/引用。`);
    setValidationTone('ok');
  };

  const switchFile = (path: string) => {
    const currentValue = editorRef.current?.getValue();
    setFiles((current) => current.map((file, index) => index === activeIndex ? { ...file, content: currentValue || file.content } : file));
    setActivePath(path);
    setSelectedSymbol('');
    setCursorSymbol('');
    setEditorContext(null);
    setValidation(null);
    setValidationTone('idle');
    setStatus('切换文件后请重新校验');
  };

  const focusSymbol = (symbol: SysmlSymbol) => {
    setSelectedSymbol(symbol.name);
    editorRef.current?.focusRange(symbol.from, symbol.to, { highlightNavigation: true });
  };

  const focusReference = (reference: ReferenceRow) => {
    setSelectedSymbol(reference.name);
    editorRef.current?.focusRange(reference.from, reference.to, { highlightNavigation: true });
  };

  const revealEditorRegion = () => {
    const editorRegion = editorRegionRef.current;
    if (!editorRegion) return;
    const editorRect = editorRegion.getBoundingClientRect();
    const viewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
    if (editorRect.bottom > 0 && editorRect.top < viewportHeight) return;
    editorRegion.scrollIntoView({ block: 'start', behavior: 'auto' });
  };

  const focusSemanticOutlineNode = (node: SemanticOutlineNode) => {
    const name = node.name || node.declaredName || node.qualifiedName || node.metaclass || '模型对象';
    setSelectedSymbol(name);
    const targetPath = node.file && files.some((file) => file.path === node.file) ? node.file : activePath;
    const targetFile = files.find((file) => file.path === targetPath);
    if (targetFile && targetPath === activePath && typeof node.line === 'number' && node.line > 0) {
      const from = lineColumnToOffset(targetFile.content, node.line, typeof node.column === 'number' ? node.column : 1);
      editorRef.current?.focusRange(from, Math.min(targetFile.content.length, from + name.length), {
        focusEditor: false,
        highlightNavigation: true
      });
      revealEditorRegion();
      setStatus(`已定位 ${name}。`);
      setValidationTone('ok');
      return;
    }
    const localSymbol = navigationIndex.symbols.find((symbol) => symbol.name === name);
    if (localSymbol) {
      editorRef.current?.focusRange(localSymbol.from, localSymbol.to, {
        focusEditor: false,
        highlightNavigation: true
      });
      revealEditorRegion();
      setStatus(`已定位 ${name}。`);
      setValidationTone('ok');
      return;
    }
    setStatus(`${name} 暂无源码定位信息。`);
    setValidationTone('warn');
  };

  const gotoDefinition = () => {
    const name = activeSymbol.trim();
    if (!name) {
      setStatus('请先把光标放在要定位的名称上，或在模型树中选择一个对象。');
      setValidationTone('warn');
      return;
    }
    const definition = findSysmlDefinition(navigationIndex, name);
    if (!definition) {
      setStatus(`${name} 在当前文件内没有找到定义。`);
      setValidationTone('warn');
      return;
    }
    focusSymbol(definition);
    setStatus(`已定位 ${name} 的定义。`);
    setValidationTone('ok');
  };

  const showReferences = () => {
    setActiveNavTab('references');
    if (!activeSymbol) {
      setStatus('请先选择或定位一个 SysML 名称。');
      setValidationTone('warn');
      return;
    }
    setStatus(`找到 ${activeSymbol} 的 ${references.length} 处定义/引用。`);
    setValidationTone(references.length ? 'ok' : 'warn');
  };

  const showReferencesForSymbol = (symbolName: string) => {
    const name = symbolName.trim();
    setEditorContextMenu(null);
    if (!name) {
      setStatus('请先在代码区右键一个 SysML 名称。');
      setValidationTone('warn');
      return;
    }
    const rows = referenceRows(navigationIndex, name);
    setSelectedSymbol(name);
    setActiveNavTab('references');
    setStatus(`找到 ${name} 的 ${rows.length} 处定义/引用。`);
    setValidationTone(rows.length ? 'ok' : 'warn');
  };

  const renameSymbol = () => {
    if (activeFileReadOnly) {
      setStatus('当前文件是只读依赖模型，不能重命名符号。');
      setValidationTone('warn');
      return;
    }
    const oldName = activeSymbol.trim();
    if (!isSimpleSysmlIdentifier(oldName)) {
      setStatus('请先选择一个可重命名的 SysML 标识符。');
      setValidationTone('warn');
      return;
    }
    const nextName = window.prompt(`将 ${oldName} 重命名为：`, oldName);
    if (!nextName || nextName === oldName) return;
    if (!isSimpleSysmlIdentifier(nextName)) {
      setStatus('新名称必须是 ASCII 标识符，例如 BatteryPack。');
      setValidationTone('fail');
      return;
    }
    const confirmed = window.confirm(`准备把 ${oldName} 重命名为 ${nextName}。\n\n将只修改代码语义区，注释和字符串不会被修改。\n\n确认继续吗？`);
    if (!confirmed) return;
    const result = renameSysmlSymbolInCode(editorRef.current?.getValue() || activeFile.content, oldName, nextName);
    if (!result.count) {
      setStatus(`没有找到可重命名的 ${oldName}。`);
      setValidationTone('warn');
      return;
    }
    updateActiveFile(result.content);
    setSelectedSymbol(nextName);
    setActiveNavTab('references');
    setStatus(`已将 ${oldName} 重命名为 ${nextName}，共 ${result.count} 处。`);
    setValidationTone('ok');
  };

  const fixPunctuation = () => {
    if (activeFileReadOnly) {
      setStatus('当前文件是只读依赖模型，不能修改标点。');
      setValidationTone('warn');
      return;
    }
    const result = normalizeSysmlPunctuation(editorRef.current?.getValue() || activeFile.content);
    if (!result.count) {
      setStatus('未发现全角语法标点。');
      setValidationTone('ok');
      return;
    }
    updateActiveFile(result.content);
    setStatus(`已修正 ${result.count} 个全角语法标点。`);
    setValidationTone('ok');
  };

  const openEditorContextMenu = (context: SysmlEditorContextMenu) => {
    const menuWidth = 210;
    const menuHeight = 286;
    setEditorContextMenu({
      ...context,
      x: Math.max(8, Math.min(context.x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(context.y, window.innerHeight - menuHeight - 8))
    });
  };

  const copyEditorSelection = async () => {
    try {
      const copied = await editorRef.current?.copySelection();
      setEditorContextMenu(null);
      setStatus(copied ? '已复制选中内容。' : '没有可复制的选中内容。');
      setValidationTone(copied ? 'ok' : 'warn');
    } catch {
      setEditorContextMenu(null);
      setStatus('复制失败，请确认浏览器允许访问剪贴板。');
      setValidationTone('fail');
    }
  };

  const cutEditorSelection = async () => {
    if (activeFileReadOnly) {
      setEditorContextMenu(null);
      setStatus('当前文件是只读依赖模型，不能剪切内容。');
      setValidationTone('warn');
      return;
    }
    try {
      const cut = await editorRef.current?.cutSelection();
      setEditorContextMenu(null);
      setStatus(cut ? '已剪切选中内容。' : '没有可剪切的选中内容。');
      setValidationTone(cut ? 'ok' : 'warn');
    } catch {
      setEditorContextMenu(null);
      setStatus('剪切失败，请确认浏览器允许访问剪贴板。');
      setValidationTone('fail');
    }
  };

  const pasteIntoEditor = async () => {
    if (activeFileReadOnly) {
      setEditorContextMenu(null);
      setStatus('当前文件是只读依赖模型，不能粘贴内容。');
      setValidationTone('warn');
      return;
    }
    try {
      const pasted = await editorRef.current?.pasteFromClipboard();
      setEditorContextMenu(null);
      setStatus(pasted ? '已粘贴剪贴板内容。' : '剪贴板为空或浏览器未返回文本。');
      setValidationTone(pasted ? 'ok' : 'warn');
    } catch {
      setEditorContextMenu(null);
      setStatus('粘贴失败，请确认浏览器允许读取剪贴板。');
      setValidationTone('fail');
    }
  };

  const applyTeacherPatch = (filePath: string, content: string, validationResult?: ValidationResult) => {
    const targetFile = files.find((file) => file.path === filePath);
    if (!targetFile || targetFile.editable === false) {
      setValidationTone('warn');
      setStatus('AI 建议未应用：目标文件是只读依赖模型。');
      return;
    }
    const nextFiles = files.map((file) => file.path === filePath ? { ...file, content } : file);
    setFiles(nextFiles);
    setActivePath(filePath);
    setEditorStateName('editing');
    setValidation(validationResult || null);
    if (validationResult?.semanticOutline) {
      setSemanticOutlineSnapshot(validationResult.semanticOutline);
      setSemanticOutlineWorkspaceSignature(workspaceTemplateSignature(nextFiles, entryFile));
      setSemanticOutlineRefreshState(validationResult.semanticOutline.status === 'available' ? 'current' : 'invalid');
      setSemanticOutlineRefreshMessage(validationResult.semanticOutline.status === 'available' ? '已与当前代码同步' : '当前代码未通过官方解析');
    } else {
      setSemanticOutlineRefreshState('waiting');
      setSemanticOutlineRefreshMessage('等待官方语义更新');
    }
    const passed = Boolean(validationResult?.syntaxValid && validationResult?.semanticValid && validationResult?.coursePassed);
    setValidationTone(validationResult ? (passed ? 'ok' : 'fail') : 'warn');
    setStatus(validationResult ? (passed ? 'AI 建议已应用并通过校验' : 'AI 建议已应用，请查看诊断') : 'AI 建议已应用，待校验');
  };

  const contextLookupText = contextMenuLookupText(editorContextMenu);
  const contextLabelText = compactContextLabel(contextLookupText);
  const contextRenameText = contextMenuRenameName(editorContextMenu);
  const editorContextForTeacher = groundEditorContextForInteraction(
    editorContext,
    editorInteraction
  );
  const recordWorkbenchInteraction = (target: EventTarget | null) => {
    setEditorInteraction({
      target: interactionTargetFromElement(target),
      capturedAt: new Date().toISOString()
    });
  };

  const modelNavigationPanel = (
    <section
      className={`modelTreePanel${modelNavigationInTeacher ? ' aiTeacherModelNavigation' : ''}`}
      data-model-nav-panel
      data-model-navigation-surface={modelNavigationInTeacher ? 'ai-teacher-tab' : 'standalone'}
      tabIndex={0}
      onKeyDown={handleScrollableRegionKeyDown}
    >
      <header className="modelTreeHeader">
        <div>
          <h3>模型导航</h3>
          <span data-workbench-selection>{activeSymbol ? `已选择 ${activeSymbol}` : '选择模型对象进行交叉定位'}</span>
        </div>
        {!modelNavigationInTeacher ? (
          <button
            type="button"
            className="modelTreeCloseButton"
            data-model-nav-close
            aria-label="关闭模型导航"
            title="关闭模型导航"
            onClick={() => setIsModelNavOpen(false)}
          >
            <X size={18} />
          </button>
        ) : null}
      </header>
      <div className="modelNavTabs" role="tablist" aria-label="模型资源树、概览与引用">
        <button type="button" data-model-nav-tab="resource-tree" className={activeNavTab === 'resource-tree' ? 'active' : ''} onClick={() => setActiveNavTab('resource-tree')}>模型资源树</button>
        <button type="button" data-model-nav-tab="overview" className={activeNavTab === 'overview' ? 'active' : ''} onClick={() => setActiveNavTab('overview')}>模型概览</button>
        <button type="button" data-model-nav-tab="references" className={activeNavTab === 'references' ? 'active' : ''} onClick={() => setActiveNavTab('references')}>引用速查</button>
      </div>
      <div data-model-resource-tree className="tree" hidden={activeNavTab !== 'resource-tree'}>
        <ModelResourceTree
          semanticOutline={semanticOutlineSnapshot}
          stale={semanticOutlineIsStale}
          refreshState={semanticOutlineRefreshState}
          refreshMessage={semanticOutlineRefreshMessage}
          showExpertNodes={showExpertOutlineNodes}
          showDependencyNodes={showDependencyOutlineNodes}
          dependencyPackageRoots={dependencyPackageRoots}
          onToggleExpertNodes={setShowExpertOutlineNodes}
          onToggleDependencyNodes={setShowDependencyOutlineNodes}
          onRefresh={() => setSemanticOutlineRefreshNonce((current) => current + 1)}
          onSelect={focusSemanticOutlineNode}
        />
      </div>
      <div data-tree data-model-overview-panel className="tree" hidden={activeNavTab !== 'overview'}>
        <ModelOverview symbols={navigationIndex.symbols} activePath={activeFile.path} onSelect={focusSymbol} />
      </div>
      <div data-references-panel className="modelReferencesPanel" hidden={activeNavTab !== 'references'}>
        <ReferencePanel symbolName={activeSymbol} rows={references} onSelect={focusReference} />
      </div>
    </section>
  );

  return (
    <section
      className="workbenchPage"
      data-phase3-workbench
      data-phase4-workbench
      data-workbench-mode={mode}
      data-editor-state={editorStateName}
      data-validation-state={validationTone}
      data-active-symbol={activeSymbol}
      onPointerDownCapture={(event) => recordWorkbenchInteraction(event.target)}
      onFocusCapture={(event) => recordWorkbenchInteraction(event.target)}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
        event.preventDefault();
        void runValidation(selectedViewTarget);
      }}
    >
      <div className="workbenchAiDockLayout" data-ai-teacher-dock-layout>
        <div className="workbenchMainColumn">
          {mode === 'lesson' ? (
            <WorkbenchFocusHeader
              lesson={entity}
              course={course}
              validation={validation}
              validationPassed={validationPassed}
              completed={Boolean(lessonCompleted)}
              activeStepOverride={manualProgressStep}
              progressUpdating={isProgressUpdating}
              onComplete={markComplete}
              onReturnToStep={returnToProgressStep}
              onOpenTeacher={() => document.querySelector('[data-ai-teacher-panel]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
            />
          ) : null}
          {mode === 'bench' && benchHeader ? (
            <BenchFocusHeader
              config={benchHeader}
              validation={validation}
              validationPassed={validationPassed}
              isValidating={isValidating}
              exported={benchExported}
            />
          ) : null}
          {mode === 'lesson' || mode === 'bench' ? null : (
            <LessonCommandCenter
              entity={entity}
              course={course}
              validationPassed={validationPassed}
              onComplete={markComplete}
              onScrollToEditor={() => editorRegionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
            />
          )}

          <div className="workbenchGrid">
            <div className="workbenchEditorGrid" data-model-nav-visible={!modelNavigationInTeacher && isModelNavOpen}>
              <div className="workbenchPrimaryColumn">
                <main ref={editorRegionRef} className="editorPane workbenchEditorRegion" data-workbench-editor-region>
                <div className="toolbar" aria-label="编辑器工具栏">
                  <div className="toolbarMainActions">
                    <select
                      data-file-select
                      data-active-file-readonly={activeFileReadOnly ? 'true' : 'false'}
                      aria-label="Workspace 文件"
                      value={activePath}
                      onChange={(event) => switchFile(event.currentTarget.value)}
                    >
                      {files.map((file) => (
                        <option
                          key={file.path}
                          value={file.path}
                          data-read-only={file.editable === false ? 'true' : 'false'}
                          className={file.editable === false ? 'readOnlyWorkspaceOption' : undefined}
                        >
                          {file.path}
                        </option>
                      ))}
                    </select>
                    <div className="editorToolbarIconGroup" aria-label="文件操作">
                      <button type="button" className="editorToolbarIconButton" data-tooltip={isSaving ? '正在保存' : '手动保存'} aria-label={isSaving ? '正在保存' : '手动保存'} title={isSaving ? '正在保存' : '手动保存'} data-save onClick={saveDraft} disabled={isSaving}><Save size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                      <button type="button" className="editorToolbarIconButton" data-tooltip="导出工作区" aria-label="导出工作区" title="导出工作区" data-export onClick={exportWorkspace}><PackageOpen size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                      <button type="button" className="editorToolbarIconButton" data-tooltip="修正全角标点" aria-label="修正全角标点" title="修正全角标点" data-check-punctuation onClick={fixPunctuation} disabled={activeFileReadOnly}><WandSparkles size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                      <button type="button" className="editorToolbarIconButton editorToolbarResetButton" data-tooltip={`重置为${resetCopy.noun}`} aria-label={`重置为${resetCopy.noun}`} title={`重置为${resetCopy.noun}`} data-reset onClick={resetTemplate}><RotateCcw size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                    </div>
                    <div className="editorToolbarIconGroup editorSymbolActionGroup" aria-label="符号交叉定位工具">
                      <button type="button" className="editorToolbarIconButton" data-tooltip="定位定义" aria-label="定位定义" title="定位定义" data-goto-definition onClick={gotoDefinition}><Crosshair size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                      <button type="button" className="editorToolbarIconButton" data-tooltip="查找引用" aria-label="查找引用" title="查找引用" data-find-references onClick={showReferences}><Search size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                      <button type="button" className="editorToolbarIconButton" data-tooltip="重命名符号" aria-label="重命名符号" title="重命名符号" data-symbol-rename onClick={renameSymbol} disabled={activeFileReadOnly}><PencilLine size={16} strokeWidth={1.9} aria-hidden="true" /></button>
                    </div>
                  </div>
                  <div className="toolbarRightActions">
                    <div className="validationLamps" data-validation-summary aria-live="polite">
                      <span data-status className="validationLamp" data-summary-state={validationTone === 'fail' ? 'fail' : validationTone === 'ok' ? 'ok' : validationTone === 'warn' ? 'warn' : 'idle'}>
                        <i />
                        {status}
                      </span>
                    </div>
                    {!modelNavigationInTeacher ? (
                      <button
                        type="button"
                        className="workbenchSecondaryAction"
                        data-model-nav-open
                        aria-expanded={isModelNavOpen}
                        aria-controls="workbench-model-navigation"
                        onClick={() => setIsModelNavOpen((current) => !current)}
                      >
                        <PanelRightOpen size={16} strokeWidth={1.9} aria-hidden="true" />
                        模型导航
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="workbenchPrimaryAction"
                      data-validate
                      data-render-view
                      title="先执行官方校验，通过后生成当前教学视图"
                      onClick={() => void runValidation(selectedViewTarget)}
                      disabled={isValidating}
                    >
                      <CircleCheckBig size={16} strokeWidth={2} aria-hidden="true" />
                      {isValidating ? '校验并生成中…' : '生成视图'}
                      <kbd>Ctrl + Enter</kbd>
                    </button>
                  </div>
                </div>
                <ValidationPanel diagnostics={visibleDiagnostics} activeDiagnosticId={activeDiagnosticId} onFocus={(diagnostic, diagnosticId) => {
                  setActiveDiagnosticId(diagnosticId);
                  const offset = lineColumnToOffset(activeFile.content || '', diagnostic.line || 1, diagnostic.column || 1);
                  editorRef.current?.focusRange(offset, offset);
                }} />
                <div className="editorSurface" data-editor-surface>
                  <SysmlCodeMirror
                    ref={editorRef}
                    value={activeFile.content || ''}
                    readOnly={activeFileReadOnly}
                    onChange={updateActiveFile}
                    onCursorSymbolChange={setCursorSymbol}
                    onEditorContextChange={setEditorContext}
                    onEditorContextMenu={openEditorContextMenu}
                  />
                  {editorContextMenu ? (
                    <div
                      className="editorContextMenu"
                      data-editor-context-menu
                      role="menu"
                      style={{ left: editorContextMenu.x, top: editorContextMenu.y }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button type="button" role="menuitem" data-context-find-references onClick={() => showReferencesForSymbol(editorContextMenu.symbolName)} disabled={!editorContextMenu.symbolName}>
                        查找引用{editorContextMenu.symbolName ? `：${editorContextMenu.symbolName}` : ''}
                      </button>
                      <button type="button" role="menuitem" data-context-rename-symbol onClick={renameFromContextMenu} disabled={activeFileReadOnly || !contextRenameText}>
                        重命名{contextRenameText ? `：${contextRenameText}` : ''}
                      </button>
                      <button type="button" role="menuitem" data-context-find-text onClick={findFromContextMenu} disabled={!contextLookupText}>
                        全局查找{contextLabelText ? `：${contextLabelText}` : ''}
                      </button>
                      <button type="button" role="menuitem" data-context-replace-all onClick={replaceFromContextMenu} disabled={activeFileReadOnly || !contextLookupText}>
                        文本替换{contextLabelText ? `：${contextLabelText}` : ''}
                      </button>
                      <span aria-hidden="true" />
                      <button type="button" role="menuitem" data-context-copy onClick={copyEditorSelection} disabled={!editorContextMenu.hasSelection}>复制</button>
                      <button type="button" role="menuitem" data-context-cut onClick={cutEditorSelection} disabled={activeFileReadOnly || !editorContextMenu.hasSelection}>剪切</button>
                      <button type="button" role="menuitem" data-context-paste onClick={pasteIntoEditor} disabled={activeFileReadOnly}>粘贴</button>
                    </div>
                  ) : null}
                </div>
                </main>
              </div>

              {!modelNavigationInTeacher && isModelNavOpen ? (
                <aside id="workbench-model-navigation" className="workbenchSidePanel" aria-label="模型导航侧栏" tabIndex={0} onKeyDown={handleScrollableRegionKeyDown}>
                  {modelNavigationPanel}
                </aside>
              ) : null}
            </div>

            <ViewPane
              sectionRef={viewPaneRegionRef}
              workspace={workspaceSnapshot()}
              validationPassed={officialValidationPassed}
              courseRulesPassed={mode === 'bench' || Boolean(validation?.coursePassed)}
              isValidating={isValidating}
              projectName={`${entity.courseId || mode}-${entity.id || draftId}`}
              autoRenderRequestId={autoViewRenderRequestId}
              autoRenderTarget={autoViewRenderTarget}
              preferredPlantUmlViewName={preferredPlantUmlViewName(entity)}
              onActiveTabChange={setSelectedViewTarget}
              requiresCourseRules={mode !== 'bench'}
            />

            <div className="workbenchReferencesRow">
              <ReferenceList items={(entity.courseReferences || entity.references || []) as ReferenceItem[]} />
            </div>
          </div>

        </div>

        <AiTeacherPanel
          lesson={entity}
          workspace={workspaceSnapshot()}
          activeFilePath={activePath || entryFile}
          validation={validation}
          activeDiagnosticId={activeDiagnosticId}
          editorState={editorStateName}
          editorContext={editorContextForTeacher}
          modelNavigation={modelNavigationInTeacher ? modelNavigationPanel : undefined}
          defaultOpen={modelNavigationInTeacher}
          launcherMode={modelNavigationInTeacher ? 'docked' : 'none'}
          onApplyPatch={applyTeacherPatch}
        />
      </div>
      {showViewJumpButton ? (
        <button
          type="button"
          className="workbenchViewJumpButton"
          data-view-jump
          aria-label="跳转到视图生成区域"
          title="跳转到视图生成区域"
          style={{ left: `${viewJumpButtonLeft}px` }}
          onClick={scrollToViewPane}
        >
          <ArrowDown size={24} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}

const BENCH_PROGRESS_STEPS = [
  { label: '准备模型', icon: LayoutTemplate },
  { label: '编辑模型', icon: Code2 },
  { label: '校验', icon: ShieldCheck },
  { label: '生成视图', icon: Network },
  { label: '导出成果', icon: PackageCheck }
] as const;

function BenchFocusHeader({
  config,
  validation,
  validationPassed,
  isValidating,
  exported
}: {
  config: BenchHeaderConfig;
  validation: ValidationResult | null;
  validationPassed: boolean;
  isValidating: boolean;
  exported: boolean;
}) {
  const [templateBriefOpen, setTemplateBriefOpen] = useState(false);
  const activeStep = exported ? BENCH_PROGRESS_STEPS.length : validationPassed ? 3 : validation || isValidating ? 2 : 1;
  return (
    <header className="workbenchFocusHeader benchFocusHeader" data-bench-focus-header>
      <div className="workbenchCourseContext" aria-label="建模工作区位置">
        <strong>自由建模：</strong>
        <span>模板工作区</span>
      </div>
      <div className="workbenchFocusTitle">
        <div className="workbenchLessonIdentity">
          <span className="workbenchLessonCode">建模任务</span>
          <h1>从模板开始创建 SysML v2 模型</h1>
        </div>
        <label className="benchTemplateSelect benchFocusTemplate">
          <span>模型模板</span>
          <select
            data-bench-template
            value={config.selectedTemplateId}
            aria-label="模型模板"
            onChange={(event) => config.onTemplateChange(event.currentTarget.value)}
          >
            {config.templates.map((template) => (
              <option key={template.id} value={template.id}>{template.title}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="workbenchProgressRow">
        <button
          type="button"
          className="workbenchCourseBriefToggle"
          data-bench-brief-toggle
          aria-expanded={templateBriefOpen}
          aria-controls="workbench-bench-brief"
          onClick={() => setTemplateBriefOpen((current) => !current)}
        >
          <BookOpen size={14} aria-hidden="true" />
          模板说明
          <ArrowDown size={13} aria-hidden="true" />
        </button>
        <ol className="workbenchProgress benchProgress" aria-label="建模任务进度">
          {BENCH_PROGRESS_STEPS.map((step, index) => {
            const Icon = step.icon;
            const isComplete = exported || index < activeStep;
            const isActive = !exported && index === activeStep;
            return (
              <li key={step.label} data-state={isComplete ? 'complete' : isActive ? 'active' : 'pending'} data-bench-stage={step.label}>
                <div>
                  <span className="workbenchProgressIcon"><Icon size={16} strokeWidth={1.9} aria-hidden="true" /></span>
                  <span>{step.label}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {templateBriefOpen ? (
        <section id="workbench-bench-brief" className="workbenchCourseBrief" data-bench-brief>
          <header>
            <div>
              <span className="missionEyebrow">当前模板 · {config.selectedTemplateTitle}</span>
              <p data-bench-description>{config.description}</p>
            </div>
            <button type="button" onClick={() => setTemplateBriefOpen(false)}>收起模板说明</button>
          </header>
        </section>
      ) : null}
    </header>
  );
}

function handleScrollableRegionKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.currentTarget !== event.target) return;
  const region = event.currentTarget;
  const pageStep = Math.max(120, Math.floor(region.clientHeight * 0.82));
  if (event.key === 'PageDown') {
    event.preventDefault();
    region.scrollBy({ top: pageStep });
  } else if (event.key === 'PageUp') {
    event.preventDefault();
    region.scrollBy({ top: -pageStep });
  } else if (event.key === 'Home') {
    event.preventDefault();
    region.scrollTo({ top: 0 });
  } else if (event.key === 'End') {
    event.preventDefault();
    region.scrollTo({ top: region.scrollHeight });
  }
}

function contextMenuLookupText(context: SysmlEditorContextMenu | null): string {
  return (context?.selectedText || context?.symbolName || '').trim();
}

function contextMenuRenameName(context: SysmlEditorContextMenu | null): string {
  const selectedText = (context?.selectedText || '').trim();
  if (isSimpleSysmlIdentifier(selectedText)) return selectedText;
  const symbolName = (context?.symbolName || '').trim();
  return isSimpleSysmlIdentifier(symbolName) ? symbolName : '';
}

function isSimpleSysmlIdentifier(value: string): boolean {
  return /^[A-Za-z_]\w*$/.test(value);
}

function formatContextText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized;
}

function compactContextLabel(value: string): string {
  const normalized = formatContextText(value);
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized;
}

function WorkbenchFocusHeader({
  lesson,
  course,
  validation,
  validationPassed,
  completed,
  activeStepOverride,
  progressUpdating,
  onComplete,
  onReturnToStep,
  onOpenTeacher
}: {
  lesson: Lesson;
  course?: Course | null;
  validation: ValidationResult | null;
  validationPassed: boolean;
  completed: boolean;
  activeStepOverride: number | null;
  progressUpdating: boolean;
  onComplete: () => void;
  onReturnToStep: (stepIndex: number, stepLabel: string) => void;
  onOpenTeacher: () => void;
}) {
  const [courseBriefOpen, setCourseBriefOpen] = useState(false);
  const activeStep = completed ? 4 : activeStepOverride ?? (validationPassed ? 3 : validation ? 2 : 1);
  const steps = ['理解任务', '编辑模型', '校验', '查看证据', '完成'];
  const courseNumber = courseSequenceNumber(course, lesson);
  const lessonNumber = lessonSequenceNumber(course, lesson);
  return (
    <header className="workbenchFocusHeader" data-workbench-focus-header>
      <div className="workbenchCourseContext" aria-label="课程位置">
        <strong>Course {courseNumber}：</strong>
        {lesson.courseId ? (
          <Link
            to="/courses/$courseId"
            params={{ courseId: lesson.courseId }}
            title={`打开 Course ${courseNumber} 课程主页`}
          >
            {course?.title || '当前课程'}
            <ExternalLink size={13} aria-hidden="true" />
          </Link>
        ) : <span>{course?.title || '当前课程'}</span>}
      </div>
      <div className="workbenchFocusTitle">
        <div className="workbenchLessonIdentity">
          <span className="workbenchLessonCode">Lesson {lessonNumber}</span>
          <h1>{lesson.title || '建模任务'}</h1>
        </div>
        <div className="workbenchFocusActions">
          <button type="button" className="workbenchMobileAiJump" onClick={onOpenTeacher}>AI 教师</button>
        </div>
      </div>
      <div className="workbenchProgressRow">
        <button
          type="button"
          className="workbenchCourseBriefToggle"
          data-course-brief-toggle
          aria-expanded={courseBriefOpen}
          aria-controls="workbench-course-brief"
          onClick={() => setCourseBriefOpen((current) => !current)}
        >
          <BookOpen size={14} aria-hidden="true" />
          课程说明
          <ArrowDown size={13} aria-hidden="true" />
        </button>
        <ol className="workbenchProgress" aria-label="本课任务进度">
          {steps.map((step, index) => {
            const isComplete = completed || index < activeStep;
            const isActive = !completed && index === activeStep;
            const canReturnToStep = completed && index < 4;
            const content = <><span className="workbenchProgressIcon">{isComplete ? <Check size={14} /> : <Circle size={13} />}</span><span>{step}</span></>;
            return (
              <li key={step} data-state={isComplete ? 'complete' : isActive ? 'active' : 'pending'}>
                {canReturnToStep
                  ? <button type="button" disabled={progressUpdating} aria-label={`回到${step}`} onClick={() => onReturnToStep(index, step)}>{content}</button>
                  : index === 4 && validationPassed && !completed
                    ? <button type="button" disabled={progressUpdating} onClick={onComplete}>{content}</button>
                  : <div>{content}</div>}
              </li>
            );
          })}
        </ol>
      </div>
      {courseBriefOpen ? (
        <section id="workbench-course-brief" className="workbenchCourseBrief" data-course-brief>
          <header>
            <div>
              <span className="missionEyebrow">当前任务</span>
              <p>{primaryTaskText(lesson)}</p>
            </div>
            <button type="button" onClick={() => setCourseBriefOpen(false)}>收起课程说明</button>
          </header>
          <LearningBlocks entity={lesson} />
        </section>
      ) : null}
    </header>
  );
}

function courseSequenceNumber(course: Course | null | undefined, lesson: Lesson): string {
  if (typeof course?.order === 'number') return String(course.order).padStart(2, '0');
  const match = String(course?.id || lesson.courseId || '').match(/course[-_](\d+)/i);
  return match?.[1] ? match[1].padStart(2, '0') : '--';
}

function lessonSequenceNumber(course: Course | null | undefined, lesson: Lesson): string {
  const lessons = Array.isArray(course?.lessons) ? course.lessons : [];
  const lessonIndex = lessons.findIndex((item) => typeof item !== 'string' && item.id === lesson.id);
  if (lessonIndex >= 0) return String(lessonIndex + 1).padStart(2, '0');
  const match = String(lesson.id || '').match(/lesson[-_](\d+)/i);
  return match?.[1] ? match[1].padStart(2, '0') : '--';
}

function LessonQuickNav({ lesson, course }: { lesson: Lesson; course?: Course | null }) {
  const lessons = Array.isArray(course?.lessons) ? course.lessons.filter((item): item is Lesson => typeof item !== 'string') : [];
  const currentIndex = lessons.findIndex((item) => item.id === lesson.id);
  const previous = currentIndex > 0 ? lessons[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < lessons.length - 1 ? lessons[currentIndex + 1] : null;
  return (
    <nav className="lessonQuickNav" data-lesson-quick-nav aria-label="Lesson 快速跳转">
      {previous?.id ? <Link to="/lesson/$lessonId" params={{ lessonId: previous.id }}>上一课</Link> : <span aria-disabled="true">上一课</span>}
      {lesson.courseId ? <Link to="/courses/$courseId" params={{ courseId: lesson.courseId }}>返回课程主页</Link> : <Link to="/courses">返回课程主页</Link>}
      {next?.id ? <Link to="/lesson/$lessonId" params={{ lessonId: next.id }}>下一课</Link> : <span aria-disabled="true">下一课</span>}
    </nav>
  );
}

function LessonCommandCenter({
  entity,
  course,
  validationPassed,
  onComplete,
  onScrollToEditor
}: {
  entity: Lesson;
  course?: Course | null;
  validationPassed: boolean;
  onComplete: () => void;
  onScrollToEditor: () => void;
}) {
  const [isReadingOpen, setIsReadingOpen] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(true);
  const [detailMaxHeight, setDetailMaxHeight] = useState<string>('none');
  const detailDrawerRef = useRef<HTMLDivElement | null>(null);
  const taskText = primaryTaskText(entity);
  const checkpoints = lessonCheckpoints(entity);
  const visualSummary = lessonVisualSummary(entity);
  const lessonBrief = lessonReadingBrief(entity);
  useEffect(() => {
    if (!detailsExpanded || !detailDrawerRef.current) return;
    setDetailMaxHeight(`${detailDrawerRef.current.scrollHeight}px`);
  }, [detailsExpanded, isReadingOpen, taskText, checkpoints.length, lessonBrief.outcomes.length]);
  const afterNextPaint = (callback: () => void) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(callback);
    });
  };
  const toggleDetails = () => {
    const currentHeight = detailDrawerRef.current?.scrollHeight || 0;
    if (detailsExpanded) {
      setDetailMaxHeight(`${currentHeight}px`);
      afterNextPaint(() => {
        setDetailsExpanded(false);
        setDetailMaxHeight('0px');
      });
      return;
    }
    setDetailsExpanded(true);
    setDetailMaxHeight('0px');
    afterNextPaint(() => {
      setDetailMaxHeight(`${detailDrawerRef.current?.scrollHeight || currentHeight}px`);
    });
  };
  const handleDetailTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'max-height' || !detailsExpanded || !detailDrawerRef.current) return;
    setDetailMaxHeight(`${detailDrawerRef.current.scrollHeight}px`);
  };
  return (
    <section
      className="lessonCommandCenter"
      data-learning-command-center
      data-learning-collapsed={!detailsExpanded}
      aria-label="学习任务中心"
    >
      <div className="lessonCommandTopline">
        <div>
          <span className="missionEyebrow">学习任务中心</span>
          <h2>{lessonDisplayTitle(entity, course)}</h2>
        </div>
        <div className="lessonCommandActions">
          <button type="button" data-complete onClick={onComplete} disabled={!validationPassed}>
            <CheckCircle2 size={14} aria-hidden="true" />标记完成
          </button>
          <button
            type="button"
            className="missionPill lessonDetailToggle"
            data-learning-detail-toggle
            aria-expanded={detailsExpanded}
            aria-controls="lesson-detail-body"
            onClick={toggleDetails}
          >
            <PanelRightOpen size={14} aria-hidden="true" />
            {detailsExpanded ? '收起详情' : '展开详情'}
          </button>
        </div>
      </div>
      <div
        className="lessonCommandDrawerViewport"
        id="lesson-detail-body"
        data-learning-detail-body
        data-expanded={detailsExpanded ? 'true' : 'false'}
        aria-hidden={!detailsExpanded}
        style={{ maxHeight: detailMaxHeight }}
        onTransitionEnd={handleDetailTransitionEnd}
      >
        <div
          ref={detailDrawerRef}
          className="lessonCommandDrawer"
          data-learning-command-drawer
          data-expanded={detailsExpanded ? 'true' : 'false'}
        >
          <div className="lessonCommandPersistent">
            <div className="lessonMissionBrief" data-learning-mission-brief>
              <LearningHeroVisual entity={entity} />
              <div className="lessonMissionCopy">
                <p>{renderInlineText(visualSummary.body)}</p>
                <strong>本课完成后，你应该能解释：</strong>
                <ul>
                  {lessonBrief.outcomes.map((item) => <li key={item}>{renderInlineText(item)}</li>)}
                </ul>
                <div className="lessonMissionSignals" aria-label="本课关键产出">
                  <span><small>产出 / Output</small>{lessonBrief.output}</span>
                  <span><small>关注 / Focus</small>{lessonBrief.focus}</span>
                  <span><small>证据 / Evidence</small>{lessonBrief.evidence}</span>
                </div>
              </div>
            </div>
            <section className="lessonTaskPanel" data-learning-task-panel>
              <div>
                <h3>建模任务</h3>
                <p>{renderInlineText(taskText)}</p>
              </div>
              <ul>{checkpoints.map((item) => <li key={item}>{renderInlineText(item)}</li>)}</ul>
              <div className="lessonTaskActions">
                <button type="button" data-scroll-editor-secondary onClick={onScrollToEditor} disabled={!detailsExpanded}>进入代码编辑器</button>
                <span>校验要求在编辑器诊断区查看</span>
              </div>
            </section>
          </div>
          <div className="lessonDetailBody">
            <section className="lessonReadingPanel" data-learning-reading-panel data-reading-open={isReadingOpen}>
              <div className="lessonReadingPanelHeader">
                <div>
                  <h3>课程说明</h3>
                </div>
                <button
                  type="button"
                  aria-expanded={isReadingOpen}
                  aria-controls="lesson-reading-content"
                  disabled={!detailsExpanded}
                  onClick={() => setIsReadingOpen((value) => !value)}
                >
                  {isReadingOpen ? '收起课程说明' : '展开课程说明'}
                </button>
              </div>
              {detailsExpanded && isReadingOpen ? <LearningBlocks entity={entity} /> : null}
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

interface WorkbenchEditorInteraction {
  target: AiTeacherInteractionTarget;
  capturedAt: string;
}

function interactionTargetFromElement(target: EventTarget | null): AiTeacherInteractionTarget {
  if (!(target instanceof Element)) return 'unknown';
  if (target.closest('[data-editor], [data-editor-surface], .cm-editor')) return 'code';
  if (target.closest('[data-course-diagnostics]')) return 'diagnostic';
  if (target.closest('[data-ai-teacher-widget], [data-ai-teacher-launcher], [data-ai-teacher-panel]')) return 'ai-panel';
  if (target.closest('[data-phase3-workbench]')) return 'course-content';
  return 'unknown';
}

function groundEditorContextForInteraction(
  context: SysmlEditorContext | null,
  interaction: WorkbenchEditorInteraction
): SysmlEditorContext | null {
  if (!context) return null;
  if (interaction.target === 'code') return context;
  const defaultContext = context.contextState.cursorOrigin === 'default'
    || context.contextState.focus === 'not-mounted';
  const freezeExplicitContext = !defaultContext && interaction.target === 'ai-panel';
  return {
    ...context,
    contextState: {
      ...context.contextState,
      focus: defaultContext ? context.contextState.focus : 'blurred',
      interactionTarget: interaction.target,
      capturedAt: interaction.capturedAt,
      cursorOrigin: defaultContext ? 'default' : freezeExplicitContext ? 'frozen-explicit' : 'last-known',
      selectionOrigin: context.selection.empty
        ? 'none'
        : freezeExplicitContext && context.contextState.selectionOrigin === 'current'
          ? 'frozen-explicit'
          : 'last-known',
      degradedReason: defaultContext
        ? 'default_context'
        : freezeExplicitContext ? 'explicit_context_frozen' : 'non_code_interaction'
    }
  };
}

interface ScenarioVisual {
  type?: string;
  title?: string;
  caption?: string;
  nodes?: Array<{
    id?: string;
    icon?: string;
    label?: string;
    detail?: string;
    code?: string;
  }>;
}

function lessonCurrentGoal(entity: Lesson): string {
  const firstTask = entity.tasks?.[0];
  if (firstTask?.prompt || firstTask?.description) return firstTask.prompt || firstTask.description || '';
  return scenarioText(entity);
}

function primaryTaskText(entity: Lesson): string {
  const firstTask = entity.tasks?.[0];
  if (firstTask?.prompt || firstTask?.description) return firstTask.prompt || firstTask.description || '';
  return '阅读课程说明，补齐编辑器 TODO，并使用严格校验确认模型满足本课目标。';
}

function lessonEngineeringIntent(entity: Lesson): string {
  const block = (entity.learningBlocks || []).find((item) => {
    const content = blockText(item);
    return /^工程意图[:：]/.test(content.trim());
  });
  if (!block) return '';
  return blockText(block).replace(/^工程意图[:：]\s*/, '').trim();
}

function lessonVisualSummary(entity: Lesson): { body: string } {
  const gallery = primaryImageGalleryBlock(entity);
  const body = blockText(gallery || {}) || lessonCurrentGoal(entity) || scenarioText(entity);
  return { body };
}

function lessonReadingBrief(entity: Lesson): {
  outcomes: string[];
  output: string;
  focus: string;
  evidence: string;
} {
  const concepts = Array.isArray(entity.concepts) ? entity.concepts.filter((item): item is string => typeof item === 'string') : [];
  const output = concepts.find((item) => /view|视图/i.test(item)) ? '可评审视图入口' : '任务上下文模型';
  const firstTaskTitle = typeof entity.tasks?.[0]?.title === 'string' ? entity.tasks[0].title : '';
  const focus = concepts.slice(0, 2).join(' / ') || firstTaskTitle || '工程对象边界';
  const evidence = concepts.find((item) => /evidence|verify|satisfy|需求|证据/i.test(item)) || '课程规则校验';
  const outcomes = [
    lessonCurrentGoal(entity),
    lessonEngineeringIntent(entity),
    primaryTaskText(entity)
  ].filter(Boolean).slice(0, 3);
  return {
    outcomes: outcomes.length ? outcomes : ['说明本课工程对象、建模入口和完成检查之间的关系。'],
    output,
    focus,
    evidence
  };
}

function lessonCheckpoints(entity: Lesson): string[] {
  const hints = (entity.tasks || []).flatMap((task) => Array.isArray(task.hints) ? task.hints : []);
  if (hints.length) return hints.slice(0, 4);
  return [
    '严格 SysML v2 语法校验通过。',
    '课程规则校验通过，TODO 对应目标已闭合。',
    'PlantUML/SysON 视图可以生成，或给出清晰的学生可读错误。'
  ];
}

function lessonDisplayTitle(entity: Lesson, course?: Course | null): string {
  const lessonTitle = entity.title || 'Lesson Workbench';
  if (!course?.lessons || !Array.isArray(course.lessons)) return lessonTitle;
  const lessonIndex = course.lessons.findIndex((item) => typeof item !== 'string' && item.id === entity.id);
  if (lessonIndex < 0) return lessonTitle;
  const coursePrefix = typeof course.order === 'number' ? `C${String(course.order).padStart(2, '0')}` : '';
  return coursePrefix ? `${coursePrefix}.${lessonIndex + 1} ${lessonTitle}` : lessonTitle;
}

function LearningBlocks({ entity }: { entity: Lesson }) {
  const blocks = (entity.learningBlocks || []).filter((block) => String(block.type || 'markdown') !== 'code');
  const gallery = primaryImageGalleryBlock(entity);
  const readingBlocks = blocks.filter((block) => {
    const type = String(block.type || 'markdown');
    return block !== gallery && type !== 'image' && type !== 'hint-card';
  });
  const hintBlocks = blocks.filter((block) => String(block.type || 'markdown') === 'hint-card');
  const visual = scenarioVisual(entity);
  if (!blocks.length && !visual) return null;
  return (
    <div className="lessonReadingBody" id="lesson-reading-content" data-learning-content>
      {visual ? <ScenarioVisualPanel visual={visual} /> : null}
      <ContinuousLearningNotes blocks={readingBlocks} hintBlocks={hintBlocks} entity={entity} />
      <SupportingVisualStrip entity={entity} />
    </div>
  );
}

function LearningHeroVisual({ entity }: { entity: Lesson }) {
  const gallery = primaryImageGalleryBlock(entity);
  const image = gallery && Array.isArray(gallery.images) ? gallery.images[0] : null;
  if (image && typeof image === 'object' && typeof image.src === 'string') {
    const title = typeof image.title === 'string' ? image.title : '工程说明图';
    const caption = typeof image.caption === 'string' ? image.caption : '';
    const alt = typeof image.alt === 'string' ? image.alt : title;
    return (
      <figure className="lessonHeroVisual">
        <img src={assetUrlForPack(image.src)} alt={alt} loading="lazy" />
        <figcaption>
          <strong>{title}</strong>
          {caption ? <span>{renderInlineText(caption)}</span> : null}
        </figcaption>
      </figure>
    );
  }
  return <LessonFallbackHeroVisual entity={entity} />;
}

function LessonFallbackHeroVisual({ entity }: { entity: Lesson }) {
  const title = lessonDisplayTitle(entity);
  const isVehicleCourse = /汽车|整车|EV|ElectricVehicle|Vehicle|Battery|Drive/i.test(`${entity.courseId || ''} ${title}`);
  if (isVehicleCourse) {
    return (
      <figure className="lessonHeroVisual lessonFallbackHero" aria-label="汽车 SysML v2 工程导引图">
        <svg viewBox="0 0 960 600" role="img" aria-labelledby="vehicleFallbackTitle vehicleFallbackDesc">
          <title id="vehicleFallbackTitle">汽车工程信息进入 SysML v2 模型</title>
          <desc id="vehicleFallbackDesc">电池、驱动、需求、分析和验证信息通过 SysML v2 形成可追踪模型。</desc>
          <defs>
            <linearGradient id="vehicleFallbackSky" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#08192f" />
              <stop offset="62%" stopColor="#103f6d" />
              <stop offset="100%" stopColor="#126f83" />
            </linearGradient>
            <linearGradient id="vehicleFallbackRoad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#172033" />
              <stop offset="100%" stopColor="#223047" />
            </linearGradient>
            <filter id="vehicleFallbackGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect width="960" height="600" rx="28" fill="url(#vehicleFallbackSky)" />
          <circle cx="804" cy="94" r="46" fill="#f7d154" opacity="0.92" />
          <path d="M0 438 C170 384 292 398 444 430 C604 464 748 452 960 396 L960 600 L0 600 Z" fill="url(#vehicleFallbackRoad)" />
          <path d="M82 466 C230 426 420 432 602 458 C732 476 842 464 930 428" fill="none" stroke="#f7d154" strokeWidth="4" strokeDasharray="16 16" opacity="0.9" />

          <g transform="translate(236 252)">
            <path d="M66 98 C102 34 170 14 278 22 L378 104 L478 122 C518 128 548 160 556 202 L36 202 C40 160 48 124 66 98 Z" fill="#e9f7ff" stroke="#9bd7f5" strokeWidth="5" />
            <path d="M176 44 L268 44 L332 104 L136 104 C144 78 158 58 176 44 Z" fill="#113b67" opacity="0.92" />
            <path d="M372 112 L462 128 C492 134 512 152 522 178 L374 178 Z" fill="#20c997" opacity="0.82" />
            <circle cx="142" cy="204" r="46" fill="#0c172a" stroke="#95a3b8" strokeWidth="8" />
            <circle cx="450" cy="204" r="46" fill="#0c172a" stroke="#95a3b8" strokeWidth="8" />
            <rect x="216" y="132" width="128" height="50" rx="12" fill="#f7d154" stroke="#111827" strokeWidth="4" />
            <path d="M238 158 L322 158" stroke="#111827" strokeWidth="7" strokeLinecap="round" />
            <path d="M280 136 L280 180" stroke="#111827" strokeWidth="7" strokeLinecap="round" opacity="0.7" />
          </g>

          <g filter="url(#vehicleFallbackGlow)">
            <path d="M222 270 C164 222 128 178 116 116" fill="none" stroke="#f7d154" strokeWidth="5" markerEnd="url(#none)" />
            <path d="M686 278 C756 226 802 184 836 126" fill="none" stroke="#ff3fb8" strokeWidth="5" />
            <path d="M486 238 C486 174 486 128 486 82" fill="none" stroke="#37d8ff" strokeWidth="5" />
          </g>

          <g className="lessonFallbackBadge">
            <rect x="54" y="54" width="236" height="82" rx="16" />
            <text x="78" y="90">需求 / Requirements</text>
            <text x="78" y="116">续航、能耗、安全目标</text>
          </g>
          <g className="lessonFallbackBadge">
            <rect x="378" y="42" width="218" height="82" rx="16" />
            <text x="402" y="78">模型 / SysML v2</text>
            <text x="402" y="104">结构、接口、行为、状态</text>
          </g>
          <g className="lessonFallbackBadge">
            <rect x="682" y="58" width="222" height="82" rx="16" />
            <text x="706" y="94">验证 / Evidence</text>
            <text x="706" y="120">分析、测试、评审视图</text>
          </g>
          <g className="lessonFallbackBadge lessonFallbackBadgeAccent">
            <rect x="330" y="504" width="300" height="54" rx="16" />
            <text x="354" y="538">Engineering data -&gt; model trace</text>
          </g>
        </svg>
        <figcaption>
          <strong>汽车工程任务导引</strong>
          <span>把分散的需求、结构、接口、行为、分析和验证信息收敛到同一份 SysML v2 可追踪模型。</span>
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="lessonHeroVisual lessonFallbackHero" aria-label="SysML v2 工程导引图">
      <svg viewBox="0 0 960 600" role="img" aria-labelledby="genericFallbackTitle genericFallbackDesc">
        <title id="genericFallbackTitle">SysML v2 工程建模导引</title>
        <desc id="genericFallbackDesc">工程问题通过系统边界、模型对象、追踪关系和验证证据形成评审模型。</desc>
        <rect width="960" height="600" rx="28" fill="#0b1b32" />
        <path d="M80 456 C212 386 312 392 450 438 C596 486 720 458 880 378" fill="none" stroke="#f7d154" strokeWidth="6" strokeDasharray="18 14" />
        <circle cx="192" cy="232" r="86" fill="#1d9bf0" opacity="0.72" />
        <rect x="394" y="172" width="174" height="126" rx="22" fill="#eaf3ff" />
        <path d="M432 212 H530 M432 244 H516 M432 276 H492" stroke="#173a64" strokeWidth="12" strokeLinecap="round" />
        <circle cx="748" cy="246" r="76" fill="#20c997" opacity="0.78" />
        <path d="M256 234 H382 M570 236 H670" stroke="#ff3fb8" strokeWidth="8" strokeLinecap="round" />
        <g className="lessonFallbackBadge">
          <rect x="70" y="62" width="248" height="78" rx="16" />
          <text x="94" y="96">系统边界 / Boundary</text>
          <text x="94" y="122">目标、场景、外部对象</text>
        </g>
        <g className="lessonFallbackBadge">
          <rect x="354" y="62" width="252" height="78" rx="16" />
          <text x="378" y="96">模型对象 / Model</text>
          <text x="378" y="122">part、port、action、state</text>
        </g>
        <g className="lessonFallbackBadge">
          <rect x="642" y="62" width="248" height="78" rx="16" />
          <text x="666" y="96">证据链 / Evidence</text>
          <text x="666" y="122">require、satisfy、verify</text>
        </g>
      </svg>
      <figcaption>
        <strong>SysML v2 工程建模导引</strong>
        <span>先理解工程任务，再把对象、关系和证据组织成可校验、可评审的模型。</span>
      </figcaption>
    </figure>
  );
}

function ContinuousLearningNotes({ blocks, hintBlocks, entity }: { blocks: LearningBlock[]; hintBlocks: LearningBlock[]; entity: Lesson }) {
  const sections = continuousLearningSections(blocks, entity);
  return (
    <section className="lessonContinuousNotes" data-learning-continuous-notes>
      <h3>工程说明</h3>
      <div className="lessonContinuousNoteList">
        {sections.map((section, index) => (
          <article key={`${section.title}-${index}`} data-long-title={section.longTitle ? 'true' : undefined}>
            <strong>{section.title}</strong>
            <p>{renderInlineText(section.body)}</p>
          </article>
        ))}
      </div>
      {hintBlocks.length ? (
        <div className="lessonConceptDrawers" data-learning-hint-cards aria-label="按需展开的概念解读">
          {hintBlocks.map((block, index) => <HintCardBlock block={block} index={index} key={`${learningSectionTitle(block)}-${index}`} />)}
        </div>
      ) : null}
    </section>
  );
}

function SupportingVisualStrip({ entity }: { entity: Lesson }) {
  const gallery = primaryImageGalleryBlock(entity);
  const images = gallery && Array.isArray(gallery.images) ? gallery.images.slice(1) : [];
  const validImages = images.filter(
    (image): image is { src: string; title?: string; caption?: string; alt?: string } =>
      Boolean(image && typeof image === 'object' && typeof image.src === 'string')
  );
  if (!validImages.length) return null;
  return (
    <section className="lessonSupportingVisuals" aria-label="支撑工程图">
      {validImages.map((image, index) => {
        const title = typeof image.title === 'string' ? image.title : `支撑工程图 ${index + 1}`;
        const caption = typeof image.caption === 'string' ? image.caption : '';
        const alt = typeof image.alt === 'string' ? image.alt : title;
        return (
          <figure key={`${image.src}-${index}`}>
            <img src={assetUrlForPack(image.src)} alt={alt} loading="lazy" />
            <figcaption>
              <strong>{title}</strong>
              {caption ? <span>{renderInlineText(caption)}</span> : null}
            </figcaption>
          </figure>
        );
      })}
    </section>
  );
}

type ContinuousLearningSection = { title: string; body: string; longTitle: boolean };

function continuousLearningSections(blocks: LearningBlock[], entity: Lesson): ContinuousLearningSection[] {
  const textBlocks = blocks
    .filter((block) => {
      const type = String(block.type || 'markdown');
      return type === 'markdown' || type === 'hint-card' || type === 'concept-map';
    })
    .map(learningSectionFromBlock)
    .filter((section) => section.body);
  if (textBlocks.length) return textBlocks.slice(0, 5);
  return [
    { title: '工程语境', body: lessonCurrentGoal(entity) || scenarioText(entity) },
    { title: '模型阅读', body: lessonEngineeringIntent(entity) || primaryTaskText(entity) },
    { title: '练习聚焦', body: primaryTaskText(entity) }
  ].filter((section) => section.body).map(toContinuousLearningSection);
}

function learningSectionFromBlock(block: LearningBlock): ContinuousLearningSection {
  const title = learningSectionTitle(block);
  const rawBody = blockText(block);
  const body = stripLeadingSectionTitle(rawBody, title) || rawBody;
  return toContinuousLearningSection({ title, body });
}

function toContinuousLearningSection(section: { title: string; body: string }): ContinuousLearningSection {
  const title = normalizeLearningSectionTitle(section.title) || '课程说明';
  const body = normalizeCourseText(section.body);
  return {
    title,
    body,
    longTitle: isLongLearningSectionTitle(title)
  };
}

function learningSectionTitle(block: LearningBlock): string {
  const explicitTitle = typeof block.title === 'string' ? block.title.trim() : '';
  if (explicitTitle) return normalizeLearningSectionTitle(explicitTitle) || '课程说明';
  const content = blockText(block);
  const prefix = content.match(/^\s*(?:\*\*)?([^*：:\n]{2,32})(?:\*\*)?\s*[:：]/);
  if (prefix?.[1]) return normalizeLearningSectionTitle(prefix[1]) || '课程说明';
  return '课程说明';
}

function primaryImageGalleryBlock(entity: Lesson): LearningBlock | null {
  return (entity.learningBlocks || []).find((block) => String(block.type || '') === 'image-gallery') || null;
}

function ScenarioVisualPanel({ visual }: { visual: ScenarioVisual }) {
  const nodes = Array.isArray(visual.nodes) ? visual.nodes : [];
  return (
    <section className="scenarioVisualPanel" data-scenario-visual>
      <div>
        <h3>{visual.title || '工程场景'}</h3>
        {visual.caption ? <p>{renderInlineText(visual.caption)}</p> : null}
      </div>
      {nodes.length ? (
        <div className="scenarioVisualNodes" data-scenario-visual-nodes>
          {nodes.map((node, index) => (
            <article key={node.id || `${node.label || 'node'}-${index}`} className="scenarioVisualNode">
              <span>{node.icon || index + 1}</span>
              <div>
                <strong>{node.label || `节点 ${index + 1}`}</strong>
                {node.detail ? <p>{renderInlineText(node.detail)}</p> : null}
                {node.code ? <code>{node.code}</code> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LearningBlockCard({ block, index }: { block: LearningBlock; index: number }) {
  const type = String(block.type || 'markdown');
  const title = typeof block.title === 'string' ? block.title : blockLabel(type, index);
  const label = typeof block.label === 'string' ? block.label : '';
  const content = blockText(block);
  if (type === 'code') {
    return null;
  }
  if (type === 'hint-card') {
    return <HintCardBlock block={block} index={index} />;
  }
  if (type === 'image') {
    const src = typeof block.src === 'string' ? block.src : '';
    const alt = typeof block.alt === 'string' ? block.alt : title;
    return (
      <figure className="lessonImageBlock" data-learning-block-type="image">
        {src ? <img src={assetUrlForPack(src)} alt={alt} loading="lazy" /> : null}
        <figcaption>
          <strong>{title}</strong>
          {content ? <span>{renderInlineText(content)}</span> : null}
        </figcaption>
      </figure>
    );
  }
  if (type === 'image-gallery') {
    const images = Array.isArray(block.images) ? block.images : [];
    return (
      <article className="lessonImageGalleryBlock" data-learning-block-type="image-gallery">
        <span className="missionEyebrow">工程图组</span>
        <h3>{title}</h3>
        {content ? <p>{renderInlineText(content)}</p> : null}
        <div>
          {images.map((image, imageIndex) => {
            if (!image || typeof image !== 'object') return null;
            const src = typeof image.src === 'string' ? image.src : '';
            const imageTitle = typeof image.title === 'string' ? image.title : `工程图 ${imageIndex + 1}`;
            const imageCaption = typeof image.caption === 'string' ? image.caption : '';
            const alt = typeof image.alt === 'string' ? image.alt : imageTitle;
            return (
              <figure key={`${src || imageTitle}-${imageIndex}`}>
                {src ? <img src={assetUrlForPack(src)} alt={alt} loading="lazy" /> : null}
                <figcaption>
                  <strong>{imageTitle}</strong>
                  {imageCaption ? <span>{renderInlineText(imageCaption)}</span> : null}
                </figcaption>
              </figure>
            );
          })}
        </div>
      </article>
    );
  }
  return (
    <article className="lessonLearningBlock" data-learning-block-type={type}>
      <span className="missionEyebrow">{blockLabel(type, index)}</span>
      <p>{renderInlineText(content)}</p>
    </article>
  );
}

function HintCardBlock({ block, index }: { block: LearningBlock; index: number }) {
  const title = typeof block.title === 'string' ? block.title : blockLabel('hint-card', index);
  const content = blockText(block);
  return (
    <details className="hintCardBlock" data-learning-block-type="hint-card">
      <summary>
        <strong>{title}</strong>
      </summary>
      <p>{renderInlineText(content)}</p>
    </details>
  );
}

function blockText(block: LearningBlock): string {
  return normalizeCourseText(String(block.content || block.markdown || block.body || block.text || ''));
}

function blockLabel(type: string, index: number): string {
  const labels: Record<string, string> = {
    markdown: '课程讲解',
    'hint-card': '知识卡',
    code: '代码模板',
    image: '工程图',
    'image-gallery': '工程图组',
    'concept-map': '概念图'
  };
  return labels[type] || `课程材料 ${index + 1}`;
}

function scenarioVisual(entity: Lesson): ScenarioVisual | null {
  const visual = entity.scenario?.visual;
  if (!visual || typeof visual !== 'object') return null;
  return visual as ScenarioVisual;
}

function renderInlineText(text: string): ReactNode {
  const parts = normalizeCourseText(text).split(/(`[^`]+`)/g).filter(Boolean);
  return parts.flatMap((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    return renderEmphasisText(part, `text-${index}`);
  });
}

function renderEmphasisText(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong className="inlineEmphasis" key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`${keyPrefix}-${index}`}>{part}</span>;
  });
}

function normalizeCourseText(value: string): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeLearningSectionTitle(value: string): string {
  return normalizeCourseText(value)
    .replace(/^#+\s*/, '')
    .replace(/^课程讲解[:：]?\s*/, '')
    .replace(/^\*\*([\s\S]+)\*\*$/, '$1')
    .replace(/\*\*/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function stripLeadingSectionTitle(body: string, title: string): string {
  const normalizedTitle = normalizeLearningSectionTitle(title);
  if (!normalizedTitle) return normalizeCourseText(body);
  const escapedTitle = escapeRegExp(normalizedTitle);
  return normalizeCourseText(body).replace(
    new RegExp(`^\\s*(?:\\*\\*)?${escapedTitle}(?:\\*\\*)?\\s*[:：]\\s*`),
    ''
  ).trim();
}

function isLongLearningSectionTitle(title: string): boolean {
  return title.length > 12 || /[?？]/.test(title);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restoreFilesFromDraft(templateFiles: WorkspaceFile[], draft: DraftSnapshot | undefined, entryFile: string): {
  files: WorkspaceFile[];
  activePath: string;
  state: EditorStateName;
} {
  const templateSignature = workspaceTemplateSignature(templateFiles, entryFile);
  if (draft?.files?.length) {
    const files = draft.files.map((file) => {
      const templateFile = templateFiles.find((item) => item.path === file.path);
      return {
        path: file.path,
        content: file.content || '',
        editable: file.editable !== false,
        source: file.source || templateFile?.source || 'draft',
        loadPolicy: file.loadPolicy || templateFile?.loadPolicy || 'always'
      };
    });
    return {
      files,
      activePath: files.some((file) => file.path === entryFile) ? entryFile : files[0]?.path || entryFile,
      state: draft.templateSignature && draft.templateSignature !== templateSignature ? 'staleDraft' : 'draft'
    };
  }
  return { files: templateFiles, activePath: entryFile, state: 'template' };
}

function ModelResourceTree({ semanticOutline, stale, refreshState, refreshMessage, showExpertNodes, showDependencyNodes, dependencyPackageRoots, onToggleExpertNodes, onToggleDependencyNodes, onRefresh, onSelect }: {
  semanticOutline: SemanticOutline | null;
  stale: boolean;
  refreshState: SemanticOutlineRefreshState;
  refreshMessage: string;
  showExpertNodes: boolean;
  showDependencyNodes: boolean;
  dependencyPackageRoots: Set<string>;
  onToggleExpertNodes: (value: boolean) => void;
  onToggleDependencyNodes: (value: boolean) => void;
  onRefresh: () => void;
  onSelect: (node: SemanticOutlineNode) => void;
}) {
  const outlineTree = useMemo(
    () => buildSemanticOutlineTreeItems(semanticOutline?.roots || [], showExpertNodes, showDependencyNodes, dependencyPackageRoots),
    [dependencyPackageRoots, semanticOutline?.roots, showDependencyNodes, showExpertNodes]
  );
  const refreshBusy = refreshState === 'waiting' || refreshState === 'refreshing';
  const statusTone = refreshState === 'current' && !stale ? 'current' : refreshState === 'invalid' || refreshState === 'unavailable' || refreshState === 'error' ? 'warning' : 'progress';
  const StatusIcon = statusTone === 'current' ? CheckCircle2 : statusTone === 'warning' ? CircleAlert : RefreshCw;
  const statusText = refreshMessage || (stale ? '显示上次有效结构' : '等待官方语义更新');

  return (
    <>
      <div className="modelResourceTreeToolbar" data-outline-refresh-state={refreshState}>
        <div className="modelResourceTreeStatus" data-tone={statusTone}>
          <StatusIcon size={14} aria-hidden="true" className={refreshBusy ? 'isRefreshing' : ''} />
          <span data-semantic-outline-status title={statusText}>{statusText}</span>
        </div>
        <div className="modelResourceTreeControls">
          <label title="显示只读文件提供的上游基线和外部依赖模型">
            <input
              type="checkbox"
              data-show-dependency-models
              checked={showDependencyNodes}
              onChange={(event) => onToggleDependencyNodes(event.currentTarget.checked)}
            />
            显示依赖模型
          </label>
          <label title="显示官方语义模型中的关系和隐式元素">
            <input
              type="checkbox"
              checked={showExpertNodes}
              onChange={(event) => onToggleExpertNodes(event.target.checked)}
            />
            关系/隐式元素
          </label>
          <button
            type="button"
            className="modelResourceTreeRefreshButton"
            aria-label="刷新模型资源树"
            title="刷新模型资源树"
            disabled={refreshState === 'refreshing'}
            onClick={onRefresh}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {!semanticOutline ? (
        <p className="modelResourceTreeEmpty">{refreshBusy ? '正在读取当前代码的官方语义结构…' : '模型资源树会在停止编辑后自动生成。'}</p>
      ) : semanticOutline.status === 'invalid' ? (
        <p className="modelResourceTreeEmpty">当前代码未通过官方解析，暂无可展示的语义结构。</p>
      ) : semanticOutline.status !== 'available' ? (
        <p className="modelResourceTreeEmpty">官方语义服务暂不可用，请稍后刷新。</p>
      ) : !outlineTree.items.length ? (
        <p className="modelResourceTreeEmpty">当前模型没有可展示的用户语义对象。</p>
      ) : (
        <Suspense fallback={<div className="modelOutlineTree modelOutlineTreeMui modelOutlineTreeLoading" aria-hidden="true" />}>
          <MuiModelOutlineTree
            key={`${semanticOutline.contentHash}:${showExpertNodes ? 'expert' : 'document'}:${showDependencyNodes ? 'dependencies' : 'local'}`}
            items={outlineTree.items}
            defaultExpandedItems={outlineTree.defaultExpandedItems}
            onItemClick={(itemId) => {
              const node = outlineTree.nodeByItemId.get(itemId);
              if (node) onSelect(node);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

function ModelOverview({ symbols, activePath, onSelect }: {
  symbols: SysmlSymbol[];
  activePath: string;
  onSelect: (symbol: SysmlSymbol) => void;
  }) {
    const treeItems = useMemo(() => buildMuiModelTreeItems(symbols, activePath), [symbols, activePath]);
    const defaultExpandedItems = useMemo(() => ['file:active'], []);
    const symbolByItemId = useMemo(() => {
      const map = new Map<string, SysmlSymbol>();
      symbols.forEach((symbol) => map.set(modelSymbolTreeId(symbol.id), symbol));
    return map;
  }, [symbols]);

  if (!symbols.length) return <p className="muted">暂无可识别的模型元素。输入 package、part def 或 view 后会自动出现。</p>;
  return (
    <Suspense fallback={<div className="modelOutlineTree modelOutlineTreeMui modelOutlineTreeLoading" aria-hidden="true" />}>
      <MuiModelOutlineTree
        items={treeItems}
        defaultExpandedItems={defaultExpandedItems}
        onItemClick={(itemId) => {
          const symbol = symbolByItemId.get(itemId);
          if (symbol) onSelect(symbol);
        }}
      />
    </Suspense>
  );
}

function buildSemanticOutlineTreeItems(
  nodes: SemanticOutlineNode[],
  showExpertNodes: boolean,
  showDependencyNodes: boolean,
  dependencyPackageRoots: Set<string>
): {
  items: MuiModelTreeItem[];
  defaultExpandedItems: string[];
  nodeByItemId: Map<string, SemanticOutlineNode>;
} {
  const nodeByItemId = new Map<string, SemanticOutlineNode>();
  const defaultExpandedItems: string[] = [];
  const visit = (node: SemanticOutlineNode, depth: number, inheritedDependency = false): MuiModelTreeItem[] => {
    if (!showExpertNodes && isTechnicalSemanticOutlineDetail(node)) {
      return [];
    }
    const rootName = semanticOutlineQualifiedRootName(node);
    const isDependency = inheritedDependency || Boolean(rootName && dependencyPackageRoots.has(rootName));
    if (!showDependencyNodes && isDependency) return [];
    const promoteChildren = (!showExpertNodes && isExpertSemanticOutlineNode(node))
      || (depth === 0 && isTechnicalSemanticOutlineRoot(node));
    const childItems = (node.children || []).flatMap((child) => visit(child, promoteChildren ? depth : depth + 1, isDependency));
    if (promoteChildren) {
      return childItems;
    }
    const itemId = `semantic:${node.id}`;
    nodeByItemId.set(itemId, node);
    if (depth === 0 && !isDependency) defaultExpandedItems.push(itemId);
    return [{
      id: itemId,
      label: semanticOutlineNodeName(node),
      kindLabel: semanticOutlineKindLabel(node),
      iconKey: semanticOutlineIconKey(node),
      isImplicit: Boolean(node.isImplicit),
      isDependency,
      title: semanticOutlineNodeTitle(node),
      children: childItems.length ? childItems : undefined
    }];
  };
  return {
    items: nodes.flatMap((node) => visit(node, 0)),
    defaultExpandedItems,
    nodeByItemId
  };
}

function semanticOutlineQualifiedRootName(node: SemanticOutlineNode): string {
  const qualifiedName = String(node.qualifiedName || '').trim();
  if (qualifiedName) return qualifiedName.split('::')[0] || '';
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  return /Package/.test(kind) ? String(node.declaredName || node.name || '').trim() : '';
}

function workspaceDependencyPackageRoots(files: WorkspaceFile[]): Set<string> {
  const editableRoots = new Set<string>();
  const readOnlyRoots = new Set<string>();
  for (const file of files) {
    const target = file.editable === false ? readOnlyRoots : editableRoots;
    const index = buildSysmlNavigationIndex(file.content || '');
    for (const symbol of index.symbols) {
      if (symbol.kind === 'package' && !symbol.parentId) target.add(symbol.name);
    }
  }
  return new Set([...readOnlyRoots].filter((name) => !editableRoots.has(name)));
}

function isTechnicalSemanticOutlineRoot(node: SemanticOutlineNode): boolean {
  if (node.declaredName || node.qualifiedName) return false;
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  return /(?:^|\s)(?:Root|Namespace|Element)(?:$|\s)/.test(kind)
    && (!node.name || node.name === node.metaclass || node.name === node.displayKind);
}

function isExpertSemanticOutlineNode(node: SemanticOutlineNode): boolean {
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  return Boolean(node.isImplicit)
    || /Membership|Subclassification|Subsetting|Redefinition|TypeFeaturing|FeatureTyping|FeatureValue|FeatureChaining/.test(kind);
}

function isTechnicalSemanticOutlineDetail(node: SemanticOutlineNode): boolean {
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  return /Multiplicity(?:Range)?|ConjugatedPortDefinition|PortConjugation|FlowEnd|FeatureReferenceExpression|Literal\w*/.test(kind);
}

function semanticOutlineNodeName(node: SemanticOutlineNode): string {
  return node.declaredName || node.name || lastQualifiedNameSegment(node.qualifiedName) || node.metaclass || 'Element';
}

function semanticOutlineKindLabel(node: SemanticOutlineNode): string {
  const kind = node.displayKind || node.metaclass || 'Element';
  const line = typeof node.line === 'number' && node.line > 0 ? ` · L${node.line}` : '';
  return `${kind}${line}`;
}

function semanticOutlineNodeTitle(node: SemanticOutlineNode): string {
  const qualifiedName = node.qualifiedName || semanticOutlineNodeName(node);
  return `${qualifiedName} · ${semanticOutlineKindLabel(node)}${node.isImplicit ? ' · implicit' : ''}`;
}

function semanticOutlineIconKey(node: SemanticOutlineNode): MuiModelTreeItem['iconKey'] {
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  if (/Package|Namespace/.test(kind)) return 'package';
  if (/PartDefinition/.test(kind)) return 'part-definition';
  if (/PartUsage/.test(kind)) return 'part-usage';
  if (/Port/.test(kind)) return 'port';
  if (/Interface/.test(kind)) return 'interface';
  if (/Item/.test(kind)) return 'item';
  if (/Requirement/.test(kind)) return 'requirement';
  if (/Action/.test(kind)) return 'action';
  if (/State/.test(kind)) return 'state';
  if (/Import/.test(kind)) return 'import';
  if (/Connection|Flow|Succession/.test(kind)) return 'connection';
  if (/Attribute|FeatureValue|Literal/.test(kind)) return 'attribute';
  if (/View|Viewpoint/.test(kind)) return 'view';
  if (/Calculation|Calc|Constraint/.test(kind)) return 'calculation';
  if (/Membership|Subclassification|Subsetting|Redefinition|Featuring|Typing/.test(kind)) return 'relationship';
  if (/Definition/.test(kind)) return 'definition';
  if (/Usage|Feature/.test(kind)) return 'usage';
  return 'element';
}

function lastQualifiedNameSegment(value?: string | null): string {
  const text = String(value || '');
  const parts = text.split('::');
  return parts[parts.length - 1] || '';
}

async function officialOutlineContentHash(files: WorkspaceFile[]): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const source = files
    .map((file) => `// file: ${file.path}\n${String(file.content || '').replace(/^\uFEFF/, '')}`)
    .join('\n\n');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function buildMuiModelTreeItems(symbols: SysmlSymbol[], activePath: string): MuiModelTreeItem[] {
  const groups = [
    {
      key: 'package',
      title: 'package',
      label: '模型包',
      predicate: (symbol: SysmlSymbol) => symbol.kind === 'package',
      children: (groupSymbols: SysmlSymbol[]) => modelSymbolTreeLeaves(groupSymbols)
    },
    {
      key: 'definition',
      title: 'definition / def',
      label: '类型定义',
      predicate: (symbol: SysmlSymbol) => isDefinitionSymbol(symbol),
      children: (groupSymbols: SysmlSymbol[]) => groupedModelSymbolTreeLeaves(
        groupSymbols,
        (symbol) => definitionTypeGroupKey(symbol),
        (key) => definitionTypeGroupLabel(key),
        'definition'
      )
    },
    {
      key: 'usage',
      title: 'usage',
      label: '模型使用',
      predicate: (symbol: SysmlSymbol) => symbol.kind !== 'package' && !isDefinitionSymbol(symbol),
      children: (groupSymbols: SysmlSymbol[]) => groupedModelSymbolTreeLeaves(
        groupSymbols,
        (symbol) => usageTypeGroupKey(symbol),
        (key) => usageTypeGroupLabel(key),
        'usage'
      )
    }
  ];
  const children: MuiModelTreeItem[] = [];
  groups.forEach((group) => {
    const groupSymbols = symbols.filter(group.predicate).sort((left, right) => left.from - right.from);
    if (!groupSymbols.length) return;
    children.push({
      id: `group:${group.key}`,
      label: `${group.title}  ${group.label} ${groupSymbols.length}`,
      children: group.children(groupSymbols)
    });
  });
  return [{
    id: 'file:active',
    label: activePath || 'main.sysml',
    children
  }];
}

function modelSymbolTreeLeaves(symbols: SysmlSymbol[]): MuiModelTreeItem[] {
  return symbols.map((symbol) => ({
    id: modelSymbolTreeId(symbol.id),
    label: modelSymbolTreeLabel(symbol)
  }));
}

function groupedModelSymbolTreeLeaves(
  symbols: SysmlSymbol[],
  groupKey: (symbol: SysmlSymbol) => string,
  groupLabel: (key: string) => string,
  parentKey: string
): MuiModelTreeItem[] {
  const buckets = new Map<string, SysmlSymbol[]>();
  symbols.forEach((symbol) => {
    const key = groupKey(symbol);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)?.push(symbol);
  });
  return Array.from(buckets.entries())
    .sort((left, right) => left[1][0].from - right[1][0].from)
    .map(([key, bucket]) => ({
      id: `group:${parentKey}:${key}`,
      label: `${groupLabel(key)}  ${bucket.length}`,
      children: modelSymbolTreeLeaves(bucket.sort((left, right) => left.from - right.from))
    }));
}

function isDefinitionSymbol(symbol: SysmlSymbol): boolean {
  return /\bdef\b/.test(symbol.kind) || symbol.kind === 'use case def';
}

function definitionTypeGroupKey(symbol: SysmlSymbol): string {
  const match = symbol.kind.match(/^(.+?)\s+def$/);
  return normalizeModelTreeGroupKey(match?.[1] || symbol.kind);
}

function usageTypeGroupKey(symbol: SysmlSymbol): string {
  return normalizeModelTreeGroupKey(symbol.typeName || symbol.kind);
}

function normalizeModelTreeGroupKey(value: string): string {
  return String(value || 'other').trim().replace(/\s+/g, ' ') || 'other';
}

function definitionTypeGroupLabel(key: string): string {
  return `${key} def`;
}

function usageTypeGroupLabel(key: string): string {
  return `${key} usage`;
}

function modelSymbolTreeId(symbolId: string): string {
  return `symbol:${symbolId}`;
}

function modelSymbolTreeLabel(symbol: SysmlSymbol): string {
  const typeName = symbol.typeName ? `  ${symbol.typeName}` : '';
  return `${outlineSymbolIcon(symbol.kind)}  ${symbol.name}  ${symbol.kind}${typeName}  :${symbol.line}`;
}

function ReferencePanel({ symbolName, rows, onSelect }: {
  symbolName: string;
  rows: ReferenceRow[];
  onSelect: (row: ReferenceRow) => void;
}) {
  if (!symbolName) return <p className="muted">把光标放在模型名称上，再点击“查找引用”。</p>;
  return (
    <>
      <div className="modelReferencesHeader">
        <strong>{symbolName}</strong>
        <span>{rows.length} 处</span>
      </div>
      {rows.length ? rows.map((row, index) => (
        <button
          key={`${row.group}-${row.from}-${index}`}
          type="button"
          className="modelReferenceItem"
          data-reference-item
          data-reference-from={row.from}
          data-reference-to={row.to}
          onClick={() => onSelect(row)}
        >
          <span>{row.group}</span>
          <strong>{row.name}</strong>
          <em>main.sysml:{row.line}</em>
        </button>
      )) : <p className="muted">当前文件内没有找到引用。</p>}
    </>
  );
}

function ValidationPanel({ diagnostics, activeDiagnosticId, onFocus }: {
  diagnostics: ValidationFinding[];
  activeDiagnosticId: string | null;
  onFocus: (diagnostic: ValidationFinding, diagnosticId: string) => void;
}) {
  return (
    <section className="courseDiagnostics" data-course-diagnostics hidden={!diagnostics.length} aria-live="polite">
      <h3>诊断与课程目标提示</h3>
      <div data-diagnostics className="srOnly">{diagnostics.map((item) => item.message).join('\n') || '无诊断。'}</div>
      {diagnostics.slice(0, 5).map((diagnostic, index) => {
        const diagnosticId = aiTeacherDiagnosticId(diagnostic);
        return <button
          key={diagnosticId}
          type="button"
          className={`diagnostic diagnostic-${diagnostic.severity || 'error'}`}
          data-course-focus
          data-diagnostic-id={diagnosticId}
          data-diagnostic-source={diagnostic.source || ''}
          data-course-line={diagnostic.line || 1}
          data-diagnostic-line={diagnostic.line || 1}
          aria-pressed={activeDiagnosticId === diagnosticId}
          onClick={() => onFocus(diagnostic, diagnosticId)}
        >
          <strong>{diagnostic.source === 'course-rule' ? '课程任务未完成' : diagnostic.severity || 'error'}</strong>
          <span>{diagnostic.message || '校验诊断'}</span>
          <em>{diagnostic.line ? `line ${diagnostic.line}` : 'workspace'}</em>
        </button>;
      })}
    </section>
  );
}

function LearningGuide({ entity }: { entity: Lesson }) {
  const tasks = entity.tasks || [];
  const blocks = entity.learningBlocks || [];
  return (
    <div className="learningGuideList">
      {tasks.slice(0, 3).map((task, index) => (
        <article key={task.id || index}>
          <strong>{task.title || `任务 ${index + 1}`}</strong>
          <p>{task.prompt || task.description}</p>
        </article>
      ))}
      {blocks.slice(0, 2).map((block, index) => (
        <article key={`${block.type || 'block'}-${index}`}>
          <strong>{block.type || '学习材料'}</strong>
          <p>{block.content || block.body || block.text}</p>
        </article>
      ))}
    </div>
  );
}

function referenceRows(index: ReturnType<typeof buildSysmlNavigationIndex>, name: string): ReferenceRow[] {
  const symbolName = String(name || '').trim();
  if (!symbolName) return [];
  const definitions = index.definitionsByName.get(symbolName) || [];
  const references = findSysmlReferences(index, symbolName);
  return [
    ...definitions.map((item) => ({ ...item, group: '定义' })),
    ...references.map((item) => ({ ...item, group: referenceKindLabel(item.kind) }))
  ].sort((left, right) => left.from - right.from);
}

function referenceKindLabel(kind: SysmlReference['kind']): string {
  const labels: Record<string, string> = {
    flow: 'flow 引用',
    expose: 'expose 引用',
    satisfy: 'satisfy 引用',
    verify: 'verify 引用',
    subject: 'subject 引用',
    return: 'return 引用',
    'member access': '成员访问',
    'type reference': '类型引用'
  };
  return labels[kind] || '引用';
}

function normalizeDiagnostics(validation: ValidationResult | null): ValidationFinding[] {
  const items = validation?.diagnostics || validation?.findings || [];
  return Array.isArray(items) ? items as ValidationFinding[] : [];
}

function ensureValidationDiagnostics(result: ValidationResult, passed: boolean, file: string): ValidationResult {
  if (passed || normalizeDiagnostics(result).length) return result;
  return {
    ...result,
    diagnostics: [{
      file,
      line: 1,
      column: 1,
      severity: 'error',
      source: 'platform',
      message: result.syntaxValid && result.semanticValid
        ? '课程规则未通过，但校验服务没有返回具体规则诊断。请检查 TODO 和课程目标提示。'
        : '严格语法或语义校验未通过，但校验服务没有返回具体位置。请先检查当前编辑器中的不完整语句、括号和分号。'
    }]
  };
}

function scenarioText(entity: Lesson): string {
  const scenario = entity.scenario?.body;
  if (typeof scenario === 'string' && scenario.trim()) return scenario;
  return '在 React Workbench 中编辑 SysML v2 代码，使用补全、模型导航和校验反馈完成练习。';
}

function outlineSymbolIcon(kind: string): string {
  if (kind === 'package') return '{}';
  if (/\bdef\b/.test(kind) || kind === 'use case def') return '◇';
  if (/^(part|item|attribute|port|end|subject|in|out|return)\b/.test(kind)) return '↳';
  if (/^(flow|satisfy|verify|expose)\b/.test(kind)) return '→';
  return '•';
}

function lineColumnToOffset(content: string, line: number, column: number): number {
  const lines = content.split(/\r?\n/);
  const safeLine = Math.max(1, Math.min(Number(line || 1), lines.length));
  const prefixLength = lines.slice(0, safeLine - 1).reduce((sum, item) => sum + item.length + 1, 0);
  return prefixLength + Math.max(0, Math.min(Number(column || 1) - 1, lines[safeLine - 1]?.length || 0));
}
