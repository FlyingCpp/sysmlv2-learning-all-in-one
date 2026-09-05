import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from '@assistant-ui/react';
import { ArrowDown, BookOpenText, Bot, Check, Copy, LoaderCircle, Maximize2, MessageCircle, Minimize2, Network, PanelLeftClose, PanelLeftOpen, Plus, Send, Square, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';
import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import { useTranslation } from 'react-i18next';
import remarkGfm from 'remark-gfm';
import { useCoursePackStore } from '../../app/course-pack-store';
import { useRuntimeConfigStore } from '../../app/runtime-config-store';
import { useSessionStore } from '../../app/session-store';
import { useAppApiClient } from '../../app/use-api-client';
import type { Lesson, ValidationResult, WorkspaceSnapshot } from '../../lib/course/types';
import {
  buildAiTeacherEnvelope,
  sanitizeTeacherUiText,
  type AiTeacherCodeBlockValidation,
  type AiTeacherEditorContext,
  type AiTeacherPatch,
  type AiTeacherResponse,
  type AiTeacherStreamEvent
} from '../../lib/ai-teacher/envelope';
import { applySingleLinePatchToContent, isAiTeacherPatchApplyReady, teacherPatchStatusLabel } from '../../lib/ai-teacher/patch';
import { latestRecoverableTeacherRun, orderTeacherConversationMessages } from '../../lib/ai-teacher/conversation';
import { AI_TEACHER_PANEL_EVENT, consumePendingAiTeacherPanelAction, type AiTeacherPanelAction } from '../../lib/ai-teacher/ui-events';
import {
  friendlyPlantUmlError,
  plantUmlMetadataNotes,
  plantUmlRequestBody,
  plantUmlViewOptions,
  type PlantUmlRenderResult
} from '../../lib/view/plantuml';
import { PlantUmlViewport } from '../workbench/ViewPane';

interface AiTeacherPanelProps {
  lesson?: Lesson | null;
  workspace: WorkspaceSnapshot;
  activeFilePath?: string;
  validation?: ValidationResult | null;
  activeDiagnosticId?: string | null;
  editorState?: string;
  editorContext?: AiTeacherEditorContext | null;
  modelNavigation?: ReactNode;
  defaultOpen?: boolean;
  launcherMode?: 'floating' | 'none' | 'docked';
  presentation?: 'panel' | 'knowledge-page';
  knowledgeWorkspace?: { spaceCount: number; spaces: ReactNode };
  onApplyPatch?: (filePath: string, content: string, validationResult?: ValidationResult) => void;
}

interface AiTeacherMessage {
  id: string;
  role: 'user' | 'assistant' | 'process';
  title: string;
  text: string;
  details?: string;
  activities?: AiTeacherActivity[];
  response?: AiTeacherResponse;
  state?: 'working' | 'done' | 'error' | 'cancelled';
  runId?: string;
  startedAtMs?: number;
  completedAtMs?: number;
}

interface AiTeacherActivityItem {
  title: string;
  detail?: string;
  url?: string;
}

interface AiTeacherActivity {
  activityId: string;
  kind: 'context' | 'knowledge' | 'web' | 'skill' | 'validator' | 'repair';
  status: 'running' | 'complete' | 'error';
  message: string;
  count?: number;
  items?: AiTeacherActivityItem[];
}

interface AiTeacherPersistedSession {
  open: boolean;
  question: string;
  status: string;
  tone: 'idle' | 'ok' | 'warn' | 'fail';
  messages: AiTeacherMessage[];
  threadId: string;
  clarificationCheckpointId: string;
  dockWidth: number;
  running: boolean;
  activeRunId: string;
  activeRunEventSeq: number;
  activeUserMessageId: string;
  activeProcessMessageId: string;
  activeAssistantMessageId: string;
}

interface AiTeacherComposerContext {
  kind: 'none' | 'engineering_feedback' | 'clarification_answer';
  sourceRunId?: string;
  questionId?: string;
  suggestions?: Array<{ publicSuggestionId?: string; summary: string }>;
}

interface EngineeringVersionPreview {
  files: Array<{ filePath: string; content: string }>;
}

interface TeacherThreadMessage {
  messageId?: string;
  runId?: string;
  requestId?: string;
  role?: string;
  content?: string;
  response?: AiTeacherResponse | null;
  createdAt?: string;
  status?: string;
}

interface TeacherThreadMessagesResponse {
  threadId?: string;
  messages?: TeacherThreadMessage[];
}

interface TeacherThreadSummary {
  threadId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  contextUsage: {
    estimatedTokens: number;
    limitTokens: number;
    ratio: number;
    state: 'normal' | 'approaching' | 'critical';
  };
}

interface TeacherThreadListResponse {
  threads?: TeacherThreadSummary[];
}

interface TeacherRunEvent {
  eventId?: string;
  runId?: string;
  seq?: number;
  type?: string;
  payload?: AiTeacherStreamEvent | AiTeacherResponse | Record<string, unknown> | null;
  createdAt?: string;
}

interface TeacherRunEventsResponse {
  runId?: string;
  events?: TeacherRunEvent[];
}

interface TeacherRunStatusResponse {
  run?: {
    runId?: string;
    status?: string;
    errorCode?: string;
    errorMessage?: string;
  };
}

type AiTeacherSubmissionPhase = 'idle' | 'creating_thread' | 'starting_run' | 'running';

const SCOPED_THREAD_STORAGE_PREFIX = 'sysmlv2.aiTeacher.threadId.react.';
const DEFAULT_AI_TEACHER_STATUS = '使用当前课程、代码和诊断上下文回答。';
const MIN_DOCK_WIDTH = 340;
const MAX_DOCK_WIDTH = 620;
const DEFAULT_DOCK_WIDTH = MAX_DOCK_WIDTH;
const AI_TEACHER_CHECK_NOTICE = 'AI-Teacher 也可能会犯错。请核查重要信息。';
const MANUAL_CONTINUATION_SOURCE_LIMIT = 20_000;
const MANUAL_CONTINUATION_DISPLAY_TEXT = '继续完成剩余工作';
const AI_TEACHER_SESSION_CHANNEL = 'sysmlv2.aiTeacher.session.v1';
const AI_TEACHER_THREAD_REQUEST_TIMEOUT_MS = 10_000;
const aiTeacherSessions = new Map<string, AiTeacherPersistedSession>();
const aiTeacherSessionListeners = new Set<(sessionKey: string, originId: string) => void>();
const aiTeacherSessionBroadcastTimers = new Map<string, number>();
const aiTeacherRunControllers = new Map<string, AbortController>();
const aiTeacherSessionChannel = createAiTeacherSessionChannel();

export function AiTeacherPanel({
  lesson,
  workspace,
  activeFilePath,
  validation,
  activeDiagnosticId,
  editorState,
  editorContext,
  modelNavigation,
  defaultOpen = false,
  launcherMode = 'none',
  presentation = 'panel',
  knowledgeWorkspace,
  onApplyPatch
}: AiTeacherPanelProps) {
  const { t, i18n } = useTranslation('workbench');
  const api = useAppApiClient();
  const config = useRuntimeConfigStore((state) => state.config);
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  const currentUserId = useSessionStore((state) => state.user?.id || 'signed-out');
  const hasPermission = useSessionStore((state) => state.hasPermission);
  const scopeSessionKey = aiTeacherSessionKey(currentUserId, activeCoursePackId, lesson, workspace, activeFilePath);
  const initialThreadId = readThreadId(scopeSessionKey);
  const initialSessionKey = aiTeacherThreadSessionKey(scopeSessionKey, initialThreadId);
  const initialSession = getAiTeacherThreadSession(scopeSessionKey, initialThreadId, defaultOpen);
  const [sessionKey, setSessionKey] = useState(initialSessionKey);
  const [open, setOpen] = useState(initialSession.open);
  const [question, setQuestion] = useState(initialSession.question);
  const [status, setStatus] = useState(initialSession.status);
  const [tone, setTone] = useState<'idle' | 'ok' | 'warn' | 'fail'>(initialSession.tone);
  const [messages, setMessages] = useState<AiTeacherMessage[]>(initialSession.messages);
  const [running, setRunning] = useState(initialSession.running);
  const [submissionPhase, setSubmissionPhase] = useState<AiTeacherSubmissionPhase>(initialSession.running ? 'running' : 'idle');
  const [busyHint, setBusyHint] = useState('');
  const [threadId, setThreadId] = useState(initialSession.threadId);
  const [threads, setThreads] = useState<TeacherThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState('');
  const [deletingThreadId, setDeletingThreadId] = useState('');
  const [dockWidth, setDockWidth] = useState(initialSession.dockWidth);
  const [activePanelTab, setActivePanelTab] = useState<'teacher' | 'diagnostics' | 'model'>('teacher');
  const [composerContext, setComposerContext] = useState<AiTeacherComposerContext>({ kind: 'none' });
  const [engineeringVersionPreview, setEngineeringVersionPreview] = useState<EngineeringVersionPreview | null>(null);
  const [confirmVersionRestore, setConfirmVersionRestore] = useState(false);
  const questionInputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeRunId = useRef(initialSession.activeRunId);
  const statusLanguageRef = useRef(i18n.resolvedLanguage);
  const panelInstanceId = useRef(`ai-teacher-panel-${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`);
  const panelRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const busyHintTimer = useRef<number | null>(null);
  const runEventTimer = useRef<number | null>(null);
  const submissionPhaseRef = useRef<AiTeacherSubmissionPhase>(initialSession.running ? 'running' : 'idle');
  const teacherSubmissionController = useRef<AbortController | null>(null);
  const activeSessionKey = useRef(sessionKey);

  useEffect(() => {
    if (statusLanguageRef.current === i18n.resolvedLanguage) return;
    statusLanguageRef.current = i18n.resolvedLanguage;
    setStatus(t(running ? 'aiPanel.statusRunning' : 'aiPanel.statusReady'));
  }, [i18n.resolvedLanguage]);
  const activeScopeSessionKey = useRef(scopeSessionKey);
  const skipSessionPersist = useRef(false);
  const restoredThreadKey = useRef('');
  const threadsRequestController = useRef<AbortController | null>(null);
  const threadsRequestSequence = useRef(0);
  const canUseTeacher = Boolean(config?.aiTeacherEnabled && hasPermission('ai.teacher.use'));
  const panelOpen = presentation === 'knowledge-page' || launcherMode === 'docked' || open;
  const submissionBusy = submissionPhase !== 'idle';
  const interactionBusy = running || submissionBusy;
  const teacherDiagnostics = (validation?.diagnostics || validation?.findings || []);

  useEffect(() => {
    const onPanelRequest = (event: Event) => {
      const action = ((event as CustomEvent<{ action?: AiTeacherPanelAction }>).detail?.action || 'toggle');
      consumePendingAiTeacherPanelAction();
      setOpen((current) => action === 'open' ? true : action === 'close' ? false : !current);
    };
    window.addEventListener(AI_TEACHER_PANEL_EVENT, onPanelRequest);
    return () => window.removeEventListener(AI_TEACHER_PANEL_EVENT, onPanelRequest);
  }, []);

  useEffect(() => {
    const pendingAction = consumePendingAiTeacherPanelAction();
    if (!pendingAction) return;
    setOpen((current) => pendingAction === 'open' ? true : pendingAction === 'close' ? false : !current);
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [panelOpen]);

  useEffect(() => {
    if (!panelOpen || !messages.length) return;
    const frame = window.requestAnimationFrame(() => {
      scrollConversationToBottom(running ? 'auto' : 'smooth');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, panelOpen, running]);

  useEffect(() => {
    if (activeScopeSessionKey.current === scopeSessionKey) return;
    const previousSessionKey = activeSessionKey.current;
    teacherSubmissionController.current?.abort();
    teacherSubmissionController.current = null;
    setSubmissionPhaseForPanel('idle');
    aiTeacherRunControllers.get(previousSessionKey)?.abort();
    aiTeacherRunControllers.delete(previousSessionKey);
    purgeAiTeacherSessionsForOtherUsers(currentUserId);
    const nextThreadId = readThreadId(scopeSessionKey);
    const nextSessionKey = aiTeacherThreadSessionKey(scopeSessionKey, nextThreadId);
    const nextSession = getAiTeacherThreadSession(scopeSessionKey, nextThreadId, defaultOpen);
    skipSessionPersist.current = true;
    activeScopeSessionKey.current = scopeSessionKey;
    activeSessionKey.current = nextSessionKey;
    setSessionKey(nextSessionKey);
    restoredThreadKey.current = '';
    activeRunId.current = nextSession.activeRunId;
    setRunning(nextSession.running);
    setBusyHint('');
    setOpen(nextSession.open);
    setQuestion(nextSession.question);
    setStatus(nextSession.status);
    setTone(nextSession.tone);
    setMessages(nextSession.messages);
    setThreadId(nextSession.threadId);
    setDockWidth(nextSession.dockWidth);
  }, [currentUserId, defaultOpen, scopeSessionKey]);

  useEffect(() => subscribeAiTeacherSession((changedSessionKey, originId) => {
    if (changedSessionKey !== activeSessionKey.current || originId === panelInstanceId.current) return;
    const nextSession = getAiTeacherSession(changedSessionKey, defaultOpen);
    skipSessionPersist.current = true;
    activeRunId.current = nextSession.activeRunId;
    setOpen(nextSession.open);
    setQuestion(nextSession.question);
    setStatus(nextSession.status);
    setTone(nextSession.tone);
    setMessages(nextSession.messages);
    setThreadId(nextSession.threadId);
    setDockWidth(nextSession.dockWidth);
    setRunning(nextSession.running);
  }), [defaultOpen, sessionKey]);

  useEffect(() => {
    if (skipSessionPersist.current) {
      skipSessionPersist.current = false;
      return;
    }
    rememberAiTeacherSession(activeSessionKey.current, {
      open,
      question,
      status,
      tone,
      messages: messages.slice(-50),
      threadId,
      dockWidth,
      running,
      activeRunId: activeRunId.current,
      activeRunEventSeq: getAiTeacherSession(activeSessionKey.current, defaultOpen).activeRunEventSeq,
      activeUserMessageId: getAiTeacherSession(activeSessionKey.current, defaultOpen).activeUserMessageId,
      activeProcessMessageId: getAiTeacherSession(activeSessionKey.current, defaultOpen).activeProcessMessageId,
      activeAssistantMessageId: getAiTeacherSession(activeSessionKey.current, defaultOpen).activeAssistantMessageId,
      clarificationCheckpointId: getAiTeacherSession(activeSessionKey.current, defaultOpen).clarificationCheckpointId
    }, panelInstanceId.current);
  }, [defaultOpen, dockWidth, messages, open, question, running, status, threadId, tone]);

  useEffect(() => {
    if (!threadId || messages.length || running || !canUseTeacher) return;
    const restoreKey = `${sessionKey}:${threadId}`;
    if (restoredThreadKey.current === restoreKey) return;
    restoredThreadKey.current = restoreKey;
    let cancelled = false;
    let retryTimer: number | null = null;
    setStatus('正在恢复 AI 教师历史对话...');
    setTone('warn');
    const retryRestore = (attempt: number) => {
      if (cancelled) return;
      retryTimer = window.setTimeout(() => void restoreThread(attempt + 1), 500);
    };
    const restoreThread = async (attempt: number) => {
      try {
        const payload = await api.request<TeacherThreadMessagesResponse>(
          `/api/teacher/threads/${encodeURIComponent(threadId)}/messages?${teacherContextQuery(lesson, { limit: 50 })}`
        );
      if (cancelled || activeSessionKey.current !== sessionKey) return;
        const restored = teacherThreadMessagesToPanelMessages(payload.messages || []);
        if (!restored.length) {
          if (attempt < 12) {
            retryRestore(attempt);
            return;
          }
          setStatus(DEFAULT_AI_TEACHER_STATUS);
          setTone('idle');
          return;
        }
        const waitingCheckpointId = latestWaitingClarificationCheckpoint(payload.messages || []);
        const recoverableMessage = latestRecoverableTeacherRun(payload.messages || []);
        const recoverableRunId = String(recoverableMessage?.runId || '');
        if (recoverableMessage && recoverableRunId) {
          const processMessageId = `restored-process-${recoverableRunId}`;
          const recoveredRunStartedAtMs = teacherTimestampMs(recoverableMessage.createdAt);
          const recoveredMessages: AiTeacherMessage[] = [
            ...restored,
            {
              id: processMessageId,
              role: 'process',
              title: 'AI 教师处理流程',
              text: '正在恢复后台回答',
              details: '页面已重新连接，AI 教师会继续完成本轮处理。',
              state: 'working',
              runId: recoverableRunId,
              startedAtMs: recoveredRunStartedAtMs
            }
          ];
          activeRunId.current = recoverableRunId;
          setMessages(recoveredMessages);
          setRunning(true);
          setStatus('正在恢复后台回答...');
          setTone('warn');
          updateAiTeacherSession(sessionKey, (session) => ({
            ...session,
            messages: recoveredMessages,
            running: true,
            activeRunId: recoverableRunId,
            activeRunEventSeq: 0,
            activeUserMessageId: recoverableMessage.messageId || '',
            activeProcessMessageId: processMessageId,
            activeAssistantMessageId: '',
            clarificationCheckpointId: waitingCheckpointId
          }), panelInstanceId.current);
          return;
        }
        setMessages(restored);
        updateAiTeacherSession(sessionKey, (session) => ({
          ...session,
          messages: restored,
          running: false,
          activeRunId: '',
          activeRunEventSeq: 0,
          activeUserMessageId: '',
          activeProcessMessageId: '',
          activeAssistantMessageId: '',
          clarificationCheckpointId: waitingCheckpointId
        }), panelInstanceId.current);
        setStatus(AI_TEACHER_CHECK_NOTICE);
        setTone('ok');
      } catch (error) {
        if (cancelled || activeSessionKey.current !== sessionKey) return;
        if (isThreadOwnerMismatch(error)) {
          forgetAiTeacherSessionThread(sessionKey, panelInstanceId.current);
          forgetAiTeacherSessionThread(scopeSessionKey, panelInstanceId.current);
          setThreadId('');
          restoredThreadKey.current = '';
          setStatus('检测到账号已切换，已清除上一账号的对话引用。下次提问会自动创建当前账号的新对话。');
          setTone('warn');
          return;
        }
        if (attempt < 12) {
          retryRestore(attempt);
          return;
        }
        setStatus(DEFAULT_AI_TEACHER_STATUS);
        setTone('idle');
      }
    };
    void restoreThread(0);
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [api, canUseTeacher, lesson?.id, messages.length, running, sessionKey, threadId]);

  useEffect(() => {
    if (!canUseTeacher || !running || !activeRunId.current || aiTeacherRunControllers.has(sessionKey)) return;
    let cancelled = false;
    const pollRunEvents = async () => {
      if (cancelled || !activeRunId.current) return;
      const runId = activeRunId.current;
      try {
        const session = getAiTeacherSession(sessionKey, defaultOpen);
        const eventsPayload = await api.request<TeacherRunEventsResponse>(
          `/api/teacher/runs/${encodeURIComponent(runId)}/events?${teacherContextQuery(lesson, {
            afterSeq: session.activeRunEventSeq || 0
          })}`
        );
        if (cancelled || activeSessionKey.current !== sessionKey) return;
        const terminalEventConsumed = applyRunEventsToVisibleSession(eventsPayload.events || []);
        const statusPayload = await api.request<TeacherRunStatusResponse>(
          `/api/teacher/runs/${encodeURIComponent(runId)}?${teacherContextQuery(lesson)}`
        );
        if (cancelled || activeSessionKey.current !== sessionKey) return;
        const runStatus = String(statusPayload.run?.status || '');
        if (runStatus === 'succeeded' && !terminalEventConsumed) {
          runEventTimer.current = window.setTimeout(pollRunEvents, 600);
          return;
        }
        if (runStatus && runStatus !== 'running') {
          finishActiveRunFromStatus(runId, runStatus, statusPayload.run?.errorMessage || '');
          return;
        }
      } catch {
        if (cancelled || activeSessionKey.current !== sessionKey) return;
      }
      runEventTimer.current = window.setTimeout(pollRunEvents, 1800);
    };
    void pollRunEvents();
    return () => {
      cancelled = true;
      if (runEventTimer.current) {
        window.clearTimeout(runEventTimer.current);
        runEventTimer.current = null;
      }
    };
  }, [api, canUseTeacher, defaultOpen, lesson?.id, running, sessionKey]);

  const refreshThreads = useCallback(async () => {
    const requestSequence = threadsRequestSequence.current + 1;
    threadsRequestSequence.current = requestSequence;
    threadsRequestController.current?.abort();
    threadsRequestController.current = null;
    if (!canUseTeacher || presentation !== 'knowledge-page') {
      setThreads([]);
      setThreadsLoading(false);
      setThreadsError('');
      return [];
    }
    const controller = new AbortController();
    const requestScopeSessionKey = scopeSessionKey;
    threadsRequestController.current = controller;
    setThreadsLoading(true);
    setThreadsError('');
    try {
      const payload = await api.request<TeacherThreadListResponse>(
        `/api/teacher/threads?${teacherContextQuery(lesson, { scope: 'current', limit: 50 })}`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted
        || requestSequence !== threadsRequestSequence.current
        || activeScopeSessionKey.current !== requestScopeSessionKey) return [];
      const nextThreads = Array.isArray(payload.threads) ? payload.threads : [];
      setThreads(nextThreads);
      return nextThreads;
    } catch {
      if (controller.signal.aborted || requestSequence !== threadsRequestSequence.current) return [];
      setThreadsError('历史对话暂时无法加载。');
      return [];
    } finally {
      if (requestSequence === threadsRequestSequence.current) {
        if (threadsRequestController.current === controller) threadsRequestController.current = null;
        setThreadsLoading(false);
      }
    }
  }, [api, canUseTeacher, lesson?.courseId, lesson?.id, presentation, scopeSessionKey]);

  useEffect(() => {
    if (presentation !== 'knowledge-page') return;
    void refreshThreads();
  }, [presentation, refreshThreads]);

  useEffect(() => {
    return () => {
      if (busyHintTimer.current) window.clearTimeout(busyHintTimer.current);
      if (runEventTimer.current) window.clearTimeout(runEventTimer.current);
      teacherSubmissionController.current?.abort();
      teacherSubmissionController.current = null;
      submissionPhaseRef.current = 'idle';
      threadsRequestController.current?.abort();
      threadsRequestController.current = null;
    };
  }, []);

  const runTeacher = async (
    questionOverride?: string,
    manualContinuationSourceRunId?: string,
    manualContinuationKind?: 'engineering_feedback'
  ) => {
    if (running || submissionPhaseRef.current !== 'idle') {
      notifyTeacherBusy();
      return;
    }
    if (!canUseTeacher) {
      setOpen(true);
      setStatus(config?.aiTeacherEnabled ? '当前账号暂未开放 AI 教师权限。' : '当前环境未启用 AI 教师。');
      setTone('fail');
      return;
    }
    const effectiveManualSourceRunId = manualContinuationSourceRunId
      || (composerContext.kind === 'engineering_feedback' ? composerContext.sourceRunId : '');
    const effectiveManualKind = manualContinuationKind
      || (composerContext.kind === 'engineering_feedback' ? 'engineering_feedback' : undefined);
    const text = (questionOverride ?? question).trim();
    if (!text) {
      setOpen(true);
      setStatus('请输入希望 AI 教师处理的问题。');
      setTone('warn');
      return;
    }
    if (effectiveManualSourceRunId
      && !/^run_[a-zA-Z0-9-]{8,160}$/.test(effectiveManualSourceRunId)) {
      setStatus('当前续跑入口已失效，请重新提交原任务。');
      setTone('warn');
      return;
    }
    const submissionScopeKey = activeScopeSessionKey.current;
    const preRunController = new AbortController();
    teacherSubmissionController.current?.abort();
    teacherSubmissionController.current = preRunController;
    let requestThreadId = threadId;
    if (!requestThreadId) {
      const timeoutSignal = AbortSignal.timeout(AI_TEACHER_THREAD_REQUEST_TIMEOUT_MS);
      const requestSignal = AbortSignal.any([preRunController.signal, timeoutSignal]);
      setSubmissionPhaseForPanel('creating_thread');
      try {
        setStatus('正在创建新对话...');
        setTone('warn');
        const created = await api.request<{ threadId?: string }>(
          `/api/teacher/threads?${teacherContextQuery(lesson)}`,
          { method: 'POST', signal: requestSignal }
        );
        if (preRunController.signal.aborted || activeScopeSessionKey.current !== submissionScopeKey) return;
        requestThreadId = String(created.threadId || '');
        if (!requestThreadId) throw new Error('Teacher thread id is missing');
        rememberThreadId(requestThreadId);
        await refreshThreads();
      } catch {
        if (activeScopeSessionKey.current !== submissionScopeKey) return;
        setStatus(timeoutSignal.aborted
          ? '创建新对话超时，本次没有启动 AI 教师，请重试。'
          : preRunController.signal.aborted
            ? '已取消本次提交，没有启动 AI 教师。'
            : '无法创建新对话，请稍后重试。');
        setTone('fail');
        return;
      } finally {
        if (teacherSubmissionController.current === preRunController) {
          teacherSubmissionController.current = null;
          setSubmissionPhaseForPanel('idle');
        }
      }
    }
    if (preRunController.signal.aborted || activeScopeSessionKey.current !== submissionScopeKey) return;
    if (teacherSubmissionController.current === preRunController) teacherSubmissionController.current = null;
    setSubmissionPhaseForPanel('starting_run');
    setOpen(true);
    setQuestionForSession(activeSessionKey.current, '');
    const controller = new AbortController();
    const runSessionKey = activeSessionKey.current;
    const runStartedAtMs = Date.now();
    aiTeacherRunControllers.set(runSessionKey, controller);
    activeRunId.current = '';
    setRunningForSession(runSessionKey, true);
    setSubmissionPhaseForPanel('running');
    setStatusForSession(runSessionKey, 'AI 教师正在结合当前模型上下文回答...', 'warn');
    const userId = appendMessage({
      role: 'user',
      title: '你',
      text: effectiveManualKind === 'engineering_feedback'
        ? text
        : effectiveManualSourceRunId ? MANUAL_CONTINUATION_DISPLAY_TEXT : text,
      startedAtMs: runStartedAtMs
    }, runSessionKey);
    const processId = appendMessage({
      role: 'process',
      title: 'AI 教师处理流程',
      text: '问题已提交，正在建立本轮运行。',
      details: '问题已提交，正在建立本轮运行。',
      activities: [],
      state: 'working',
      startedAtMs: runStartedAtMs
    }, runSessionKey);
    let assistantId = appendMessage({
      role: 'assistant',
      title: 'AI 教师',
      text: '',
      state: 'working',
      startedAtMs: runStartedAtMs
    }, runSessionKey);
    updateAiTeacherSession(runSessionKey, (session) => ({
      ...session,
      activeRunId: '',
      activeRunEventSeq: 0,
      activeUserMessageId: userId,
      activeProcessMessageId: processId,
      activeAssistantMessageId: assistantId
    }), panelInstanceId.current);
    let runIdForRequest = '';
    try {
      let envelope = buildAiTeacherEnvelope({
        questionText: text,
        threadId: requestThreadId,
        clarificationCheckpointId: effectiveManualSourceRunId
          ? undefined
          : getAiTeacherSession(runSessionKey, defaultOpen).clarificationCheckpointId,
        manualContinuationSourceRunId: effectiveManualSourceRunId || undefined,
        manualContinuationKind: effectiveManualKind,
        coursePackId: activeCoursePackId,
        lesson,
        workspace,
        activeFilePath,
        validation,
        activeDiagnosticId,
        editorState,
        editorContext
      });
      const onTeacherEvent = (event: AiTeacherStreamEvent) => {
        if (event.threadId) rememberThreadId(event.threadId, runSessionKey);
        if (event.runId) {
          runIdForRequest = event.runId;
          rememberActiveRun(event.runId, runSessionKey, userId, processId, assistantId);
        }
        if ((event.type === 'answer_delta' || event.type === 'delta') && event.text) {
          if (!assistantId) {
            assistantId = appendMessage({
              role: 'assistant',
              title: 'AI 教师',
              text: '',
              state: 'working',
              startedAtMs: runStartedAtMs
            }, runSessionKey);
            rememberActiveAssistant(runSessionKey, assistantId, runIdForRequest);
          }
          updateMessage(assistantId, (message) => ({
            ...message,
            runId: runIdForRequest || message.runId,
            text: appendStreamText(message.text, event.text),
            state: 'working'
          }), runSessionKey);
        }
        if (event.type === 'activity') {
          const activity = normalizeTeacherActivity(event);
          if (activity) {
            updateMessage(processId, (message) => ({
              ...message,
              text: activity.message,
              details: appendProcessDetail(message.details || message.text, activity.message),
              activities: upsertTeacherActivity(message.activities, activity)
            }), runSessionKey);
          }
        }
        if (event.type === 'status' && event.message) {
          updateMessage(processId, (message) => ({
            ...message,
            text: sanitizeTeacherUiText(event.message),
            details: appendProcessDetail(message.details || message.text, event.message)
          }), runSessionKey);
        }
        if (event.type === 'continuation_started' && event.message) {
          updateMessage(processId, (message) => ({
            ...message,
            text: sanitizeTeacherUiText(event.message),
            details: appendProcessDetail(message.details || message.text, event.message)
          }), runSessionKey);
          setStatusForSession(runSessionKey, '首轮达到执行时限，AI 教师正在自动续跑第 2/2 轮。', 'warn');
        }
        if (event.type === 'thinking' && event.message) {
          updateMessage(processId, (message) => ({
            ...message,
            text: sanitizeTeacherUiText(event.message),
            details: appendProcessDetail(message.details || message.text, event.message)
          }), runSessionKey);
        }
        if (event.type === 'stage' && event.message) {
          if (isGenericLifecycleStage(event.stage)) return;
          updateMessage(processId, (message) => ({
            ...message,
            text: sanitizeTeacherUiText(event.message),
            details: appendProcessDetail(message.details || message.text, event.message)
          }), runSessionKey);
        }
      };
      let response: AiTeacherResponse;
      try {
        response = await requestTeacher(envelope, controller.signal, onTeacherEvent);
      } catch (error) {
        if (!isThreadOwnerMismatch(error) || effectiveManualSourceRunId) throw error;
        clearAiTeacherSessionThreadReference(runSessionKey, panelInstanceId.current);
        clearAiTeacherSessionThreadReference(scopeSessionKey, panelInstanceId.current);
        if (activeSessionKey.current === runSessionKey) setThreadId('');
        restoredThreadKey.current = '';
        updateMessage(processId, (message) => ({
          ...message,
          text: '账号已切换，正在创建当前账号的新对话。',
          details: appendProcessDetail(message.details || message.text, '已清除上一账号的线程引用。')
        }), runSessionKey);
        const replacementThread = await api.request<{ threadId?: string }>(
          `/api/teacher/threads?${teacherContextQuery(lesson)}`,
          { method: 'POST' }
        );
        requestThreadId = String(replacementThread.threadId || '');
        if (!requestThreadId) throw new Error('Teacher thread id is missing');
        rememberThreadId(requestThreadId, runSessionKey);
        envelope = buildAiTeacherEnvelope({
          questionText: text,
          threadId: requestThreadId,
          coursePackId: activeCoursePackId,
          lesson,
          workspace,
          activeFilePath,
          validation,
          activeDiagnosticId,
          editorState,
          editorContext
        });
        response = await requestTeacher(envelope, controller.signal, onTeacherEvent);
      }
      if (response.threadId) rememberThreadId(response.threadId, runSessionKey);
      if (response.runId && typeof response.runId === 'string') {
        runIdForRequest = response.runId;
        rememberActiveRun(response.runId, runSessionKey, userId, processId, assistantId);
      }
      const validated = await validatePatches(response, envelope, controller.signal);
      if (activeSessionKey.current === runSessionKey) {
        setComposerContext(validated.clarification?.status === 'waiting'
          ? {
              kind: 'clarification_answer',
              questionId: validated.clarification.questionId || validated.clarification.checkpointId,
            }
          : { kind: 'none' });
      }
      const runCompletedAtMs = Date.now();
      const finalProcess = finalProcessPresentation(validated);
      updateAiTeacherSession(runSessionKey, (session) => ({
        ...session,
        clarificationCheckpointId: validated.clarification?.status === 'waiting'
          ? String(validated.clarification.checkpointId || '')
          : ''
      }), panelInstanceId.current);
      updateMessage(processId, (message) => ({
        ...message,
        runId: runIdForRequest || message.runId,
        text: finalProcess.text,
        details: appendProcessDetail(message.details || message.text, finalProcess.detail),
        state: 'done',
        startedAtMs: message.startedAtMs || runStartedAtMs,
        completedAtMs: runCompletedAtMs
      }), runSessionKey);
      const finalText = responseToText(validated);
      if (assistantId) {
        updateMessage(assistantId, (message) => ({
          ...message,
          title: validated.title || 'AI 教师',
          text: finalText,
          response: validated,
          runId: runIdForRequest || message.runId,
          state: 'done',
          startedAtMs: message.startedAtMs || runStartedAtMs,
          completedAtMs: runCompletedAtMs
        }), runSessionKey);
      } else {
        appendMessage({
          role: 'assistant',
          title: validated.title || 'AI 教师',
          text: finalText,
          response: validated,
          runId: runIdForRequest,
          state: 'done',
          startedAtMs: runStartedAtMs,
          completedAtMs: runCompletedAtMs
        }, runSessionKey);
      }
      setStatusForSession(
        runSessionKey,
        validated.clarification?.status === 'waiting' ? 'AI 教师正在等待你的补充信息。' : AI_TEACHER_CHECK_NOTICE,
        validated.clarification?.status === 'waiting' ? 'warn' : 'ok'
      );
      clearActiveRun(runSessionKey);
    } catch (error) {
      const runCompletedAtMs = Date.now();
      const errorText = friendlyTeacherError(error);
      const actionableValidationFailure = isActionableValidationFailure(errorText);
      if (!isAbortError(error) && !actionableValidationFailure) removeMessages([userId], runSessionKey);
      if (assistantId) {
        updateMessage(assistantId, (message) => ({
          ...message,
          text: message.text || '本轮回答未生成可见内容。',
          runId: runIdForRequest || message.runId,
          state: isAbortError(error) ? 'cancelled' : 'error',
          startedAtMs: message.startedAtMs || runStartedAtMs,
          completedAtMs: runCompletedAtMs
        }), runSessionKey);
      }
      updateMessage(processId, (message) => ({
        ...message,
        text: errorText,
        details: appendProcessDetail(message.details || message.text, errorText),
        runId: runIdForRequest || message.runId,
        state: isAbortError(error) ? 'cancelled' : 'error',
        startedAtMs: message.startedAtMs || runStartedAtMs,
        completedAtMs: runCompletedAtMs
      }), runSessionKey);
      setStatusForSession(
        runSessionKey,
        isAbortError(error)
          ? '已停止本轮回答，后端运行已取消。'
          : isQuotaTeacherError(error) || actionableValidationFailure
            ? errorText
            : 'AI 教师暂时不可用，请稍后重试。',
        isAbortError(error) ? 'warn' : actionableValidationFailure ? 'warn' : 'fail'
      );
      if (!isAbortError(error)) clearActiveRun(runSessionKey);
    } finally {
      setSubmissionPhaseForPanel('idle');
      if (aiTeacherRunControllers.get(runSessionKey) === controller) aiTeacherRunControllers.delete(runSessionKey);
      const finishedSession = getAiTeacherSession(runSessionKey, defaultOpen);
      if (!finishedSession.activeRunId || !finishedSession.running) setRunningForSession(runSessionKey, false);
      void refreshThreads();
    }
  };

  const stopTeacher = () => {
    if (submissionPhaseRef.current === 'creating_thread' || submissionPhaseRef.current === 'starting_run') {
      teacherSubmissionController.current?.abort();
      teacherSubmissionController.current = null;
      setSubmissionPhaseForPanel('idle');
      setStatus('已取消本次提交，没有启动 AI 教师。');
      setTone('warn');
      return;
    }
    const runSessionKey = activeSessionKey.current;
    const runId = activeRunId.current || getAiTeacherSession(runSessionKey, defaultOpen).activeRunId;
    aiTeacherRunControllers.get(runSessionKey)?.abort();
    aiTeacherRunControllers.delete(runSessionKey);
    if (runId) markRunMessages(runId, 'cancelled', '后端运行已取消。');
    clearActiveRun(runSessionKey);
    setStatusForSession(runSessionKey, runId ? '已停止本轮回答，正在取消后端运行。' : '已停止本轮回答。', 'warn');
    if (!runId) return;
    void api.request(
      `/api/teacher/runs/${encodeURIComponent(runId)}/cancel?${teacherContextQuery(lesson)}`,
      { method: 'POST' }
    ).then(() => {
      setStatusForSession(runSessionKey, '已停止本轮回答，后端运行已取消。', 'warn');
    }).catch(() => {
      setStatusForSession(runSessionKey, '本地回答已停止；后端取消状态暂未确认。', 'warn');
    });
  };

  const handlePatchAction = async (action: string, patch: AiTeacherPatch) => {
    const operation = patch.operations?.[0];
    if (action === 'discard') {
      setMessages((current) => current.map((message) => message.response ? {
        ...message,
        response: {
          ...message.response,
          patches: (message.response.patches || []).filter((item) => item.patchId !== patch.patchId)
        }
      } : message));
      setStatus('已放弃这条单行建议。');
      setTone('warn');
      return;
    }
    if (action === 'copy') {
      await copyText(operation?.replacement || patch.previewText || '');
      setStatus('已复制单行建议。');
      setTone('ok');
      return;
    }
    if (action !== 'apply') return;
    if (!onApplyPatch || !operation || !patch.baseFilePath) {
      setStatus('当前页面不能直接应用这条建议，可先复制后手动调整。');
      setTone('fail');
      return;
    }
    const target = workspace.files.find((file) => file.path === patch.baseFilePath);
    if (!target) {
      setStatus('建议对应的文件不在当前工作区。');
      setTone('fail');
      return;
    }
    const result = await applySingleLinePatchToContent(target.content || '', patch);
    if (!result.ok || result.content === undefined) {
      setStatus(result.message);
      setTone('fail');
      return;
    }
    onApplyPatch(patch.baseFilePath, result.content, result.validationResult);
    appendMessage({
      role: 'assistant',
      title: '应用复盘',
      text: `${result.message}\n${patch.learningCard?.validationSummary || '这条建议在应用前已通过 patch 验证链路。'}`
    });
    setStatus(result.message);
    setTone('ok');
  };

  const rememberThreadId = (value: string, targetSessionKey = activeSessionKey.current) => {
    const isVisibleSession = activeSessionKey.current === targetSessionKey;
    if (isVisibleSession) setThreadId(value);
    updateAiTeacherSession(targetSessionKey, (session) => ({ ...session, threadId: value }), panelInstanceId.current);
    try {
      localStorage.setItem(scopedThreadStorageKey(targetSessionKey), value);
      if (isVisibleSession) localStorage.setItem(scopedThreadStorageKey(scopeSessionKey), value);
    } catch {
      // Storage can be unavailable; the current in-memory thread still works.
    }
  };

  const activateThread = (value: string, nextStatus: string, skipRestore = false) => {
    const targetSessionKey = aiTeacherThreadSessionKey(scopeSessionKey, value);
    const targetSession = getAiTeacherThreadSession(scopeSessionKey, value, defaultOpen);
    skipSessionPersist.current = true;
    activeSessionKey.current = targetSessionKey;
    setSessionKey(targetSessionKey);
    setMessages(skipRestore ? [] : targetSession.messages);
    setQuestion(targetSession.question);
    setRunning(targetSession.running);
    activeRunId.current = targetSession.activeRunId;
    restoredThreadKey.current = skipRestore && value ? `${targetSessionKey}:${value}` : '';
    setComposerContext({ kind: 'none' });
    rememberThreadId(value, targetSessionKey);
    setStatus(targetSession.running ? targetSession.status : nextStatus);
    setTone(targetSession.running ? targetSession.tone : value ? 'warn' : 'idle');
  };

  const startNewConversation = async () => {
    if (deletingThreadId) return;
    if (running || submissionPhaseRef.current !== 'idle') {
      notifyTeacherBusy();
      return;
    }
    const current = threads.find((thread) => thread.threadId === threadId);
    if (current?.messageCount === 0 && messages.length === 0) {
      setStatus('当前已经是一个新对话。');
      setTone('idle');
      return;
    }
    setStatus('正在创建新对话...');
    setTone('warn');
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(AI_TEACHER_THREAD_REQUEST_TIMEOUT_MS);
    teacherSubmissionController.current = controller;
    setSubmissionPhaseForPanel('creating_thread');
    try {
      const created = await api.request<{ threadId?: string }>(
        `/api/teacher/threads?${teacherContextQuery(lesson)}`,
        { method: 'POST', signal: AbortSignal.any([controller.signal, timeoutSignal]) }
      );
      if (controller.signal.aborted) return;
      const nextThreadId = String(created.threadId || '');
      if (!nextThreadId) throw new Error('Teacher thread id is missing');
      activateThread(nextThreadId, '已开始新对话，原对话保留在历史记录中。', true);
      await refreshThreads();
    } catch {
      setStatus(timeoutSignal.aborted
        ? '创建新对话超时，请重试。'
        : controller.signal.aborted
          ? '已取消创建新对话。'
          : '无法创建新对话，请稍后重试。');
      setTone('fail');
    } finally {
      if (teacherSubmissionController.current === controller) {
        teacherSubmissionController.current = null;
        setSubmissionPhaseForPanel('idle');
      }
    }
  };

  const selectConversation = (nextThreadId: string) => {
    if (deletingThreadId || nextThreadId === threadId) return;
    const target = threads.find((thread) => thread.threadId === nextThreadId);
    activateThread(nextThreadId, target?.messageCount ? '正在恢复历史对话...' : DEFAULT_AI_TEACHER_STATUS, target?.messageCount === 0);
  };

  const deleteConversation = async (targetThreadId: string) => {
    if (deletingThreadId) return;
    setDeletingThreadId(targetThreadId);
    try {
      await api.request(
        `/api/teacher/threads/${encodeURIComponent(targetThreadId)}?${teacherContextQuery(lesson)}`,
        { method: 'DELETE' }
      );
      const remaining = await refreshThreads();
      if (targetThreadId === threadId) {
        const next = remaining.find((thread) => thread.threadId !== targetThreadId);
        activateThread(
          next?.threadId || '',
          next?.messageCount ? '正在恢复上一条历史对话...' : DEFAULT_AI_TEACHER_STATUS,
          next?.messageCount === 0
        );
      }
      setStatus('历史对话已删除。');
      setTone('ok');
    } catch {
      setStatus('无法删除该对话；若回答仍在运行，请先停止后重试。');
      setTone('fail');
    } finally {
      setDeletingThreadId('');
    }
  };

  const clearConversation = async () => {
    if (running || submissionPhaseRef.current !== 'idle') stopTeacher();
    const waiting = getAiTeacherSession(activeSessionKey.current, defaultOpen);
    if (waiting.clarificationCheckpointId && waiting.threadId) {
      await api.request(
        `/api/teacher/clarifications/${encodeURIComponent(waiting.clarificationCheckpointId)}/cancel?${teacherContextQuery(lesson)}`,
        { method: 'POST', body: { threadId: waiting.threadId } }
      ).catch(() => ({}));
    }
    setMessages([]);
    setQuestion('');
    setThreadId('');
    activeRunId.current = '';
    restoredThreadKey.current = '';
    forgetAiTeacherSessionThread(activeSessionKey.current, panelInstanceId.current);
    forgetAiTeacherSessionThread(scopeSessionKey, panelInstanceId.current);
    setStatus('对话已清空。');
    setTone('warn');
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = dockWidth;
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const maxWidth = Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, window.innerWidth - 160));
    handle.setPointerCapture?.(pointerId);
    document.documentElement.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX;
      setDockWidth(Math.min(maxWidth, Math.max(MIN_DOCK_WIDTH, nextWidth)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      document.documentElement.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const maxWidth = Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, window.innerWidth - 160));
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = Math.min(maxWidth, dockWidth + 24);
    if (event.key === 'ArrowRight') nextWidth = Math.max(MIN_DOCK_WIDTH, dockWidth - 24);
    if (event.key === 'Home') nextWidth = MIN_DOCK_WIDTH;
    if (event.key === 'End') nextWidth = maxWidth;
    if (nextWidth === null) return;
    event.preventDefault();
    setDockWidth(nextWidth);
  };

  const recordMessageFeedback = async (message: AiTeacherMessage, outcome: 'resolved' | 'unresolved') => {
    const messageId = String(message.response?.messageId || '');
    if (!messageId) throw new Error('当前消息尚未取得可记录的服务端标识。');
    await api.request(`/api/teacher/messages/${encodeURIComponent(messageId)}/feedback?${teacherContextQuery(lesson)}`, {
      method: 'POST',
      body: {
        outcome,
        reasonCodes: [],
        judgeVersion: message.response?.alignmentReview?.version || '',
        judgeLabel: message.response?.alignmentReview?.label || ''
      }
    });
  };

  const prepareEngineeringFeedback = (response?: AiTeacherResponse) => {
    const sourceRunId = String(response?.engineeringReview?.sourceRunId || '');
    if (!/^run_[a-zA-Z0-9-]{8,160}$/.test(sourceRunId)) {
      setStatus('当前改进版本引用已失效，请刷新对话后重试。');
      setTone('warn');
      return;
    }
    setComposerContext({
      kind: 'engineering_feedback',
      sourceRunId,
      suggestions: (response?.engineeringReview?.openSuggestions || []).slice(0, 4).map((item) => ({
        publicSuggestionId: item.publicSuggestionId,
        summary: sanitizeTeacherUiText(item.summary || '').slice(0, 500)
      })).filter((item) => item.summary)
    });
    setQuestion('');
    window.setTimeout(() => questionInputRef.current?.focus(), 0);
  };

  const viewPreviousEngineeringVersion = (response?: AiTeacherResponse) => {
    const version = response?.engineeringReview?.previousVersion;
    const files = version?.available === true
      ? (version.files || []).slice(0, 20).flatMap((file) => {
        const filePath = sanitizeTeacherUiText(file.filePath || '').slice(0, 160);
        const content = typeof file.content === 'string' ? file.content : '';
        return filePath && content ? [{ filePath, content }] : [];
      })
      : [];
    if (!files.length) {
      setStatus('当前候选未保存可安全恢复的完整版本，可继续查看本轮回答。');
      setTone('warn');
      return;
    }
    setConfirmVersionRestore(false);
    setEngineeringVersionPreview({ files });
  };

  const restorePreviousEngineeringVersion = () => {
    if (!engineeringVersionPreview || !onApplyPatch) return;
    for (const file of engineeringVersionPreview.files) onApplyPatch(file.filePath, file.content);
    setConfirmVersionRestore(false);
    setEngineeringVersionPreview(null);
    setStatus(`已恢复改进前版本（${engineeringVersionPreview.files.length} 个文件）。`);
    setTone('ok');
  };

  const engineeringVersionDialog = (
    <EngineeringVersionDialog
      preview={engineeringVersionPreview}
      canRestore={Boolean(onApplyPatch)}
      confirmRestore={confirmVersionRestore}
      onRequestRestore={() => setConfirmVersionRestore(true)}
      onCancelRestore={() => setConfirmVersionRestore(false)}
      onRestore={restorePreviousEngineeringVersion}
      onClose={() => {
        setConfirmVersionRestore(false);
        setEngineeringVersionPreview(null);
      }}
    />
  );

  const activeExecutionThreadId = running
    ? threadId
    : threads.find((thread) => getAiTeacherThreadSession(scopeSessionKey, thread.threadId, false).running)?.threadId || '';

  if (presentation === 'knowledge-page') {
    return (
      <>
        <KnowledgeAssistantSurface
          messages={messages}
          threads={threads}
          activeThreadId={threadId}
          threadsLoading={threadsLoading}
          threadsError={threadsError}
          deletingThreadId={deletingThreadId}
          activeExecutionThreadId={activeExecutionThreadId}
          running={running}
          status={status}
          tone={tone}
          canUseTeacher={canUseTeacher}
          onSubmit={runTeacher}
          onCancel={stopTeacher}
          onStartNew={startNewConversation}
          onSelectThread={selectConversation}
          onDeleteThread={deleteConversation}
          onPatchAction={handlePatchAction}
          onMessageFeedback={recordMessageFeedback}
          composerContext={composerContext}
          onPrepareEngineeringFeedback={prepareEngineeringFeedback}
          onViewPreviousEngineeringVersion={viewPreviousEngineeringVersion}
          onCancelComposerContext={() => setComposerContext({ kind: 'none' })}
          knowledgeWorkspace={knowledgeWorkspace}
        />
        {engineeringVersionDialog}
      </>
    );
  }

  return (
    <>
      {!panelOpen && launcherMode === 'floating' ? (
        <button
          type="button"
          className="aiTeacherFloatingLauncher"
          data-ai-teacher-launcher
          aria-label={t('aiPanel.open')}
          onClick={() => setOpen(true)}
        >
          <span className="aiTeacherLauncherSpiral" aria-hidden="true">
            <svg viewBox="0 0 48 48" focusable="false">
              <path d="M6 36 A30 30 0 0 1 36 6 A18.5 18.5 0 0 1 42 28 A11.5 11.5 0 0 1 25 35 A7 7 0 0 1 24 22 A4 4 0 0 1 30 25 A2.4 2.4 0 0 1 26 28" />
            </svg>
          </span>
          <span className="aiTeacherLauncherText">AI</span>
        </button>
      ) : null}
      <div
        className="aiTeacherWidget phase4AiTeacher"
        data-ai-teacher-widget
        data-ai-teacher-open={panelOpen ? 'true' : 'false'}
        data-ai-teacher-launcher-mode={launcherMode}
        data-feature="ai-teacher"
        style={{ '--ai-teacher-dock-width': `${dockWidth}px` } as CSSProperties}
      >
      {panelOpen ? (
        <button
          type="button"
          className="aiTeacherResizeHandle"
          data-ai-teacher-resize
          aria-label={t('aiPanel.resizeAria')}
          title={t('aiPanel.resizeTitle')}
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
        />
      ) : null}
      <section
        ref={panelRef}
        className="aiTeacherPanelReact"
        data-ai-teacher-panel
        tabIndex={-1}
        hidden={!panelOpen}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && launcherMode !== 'docked') setOpen(false);
        }}
      >
        <header className="aiTeacherPanelHeader">
          <div>
            <h3>{t('aiPanel.title')}</h3>
            <p data-ai-teacher-status data-ai-teacher-state={tone}>{status}</p>
          </div>
          {launcherMode !== 'docked' ? (
            <button type="button" data-ai-teacher-toggle aria-label={t('aiPanel.close')} onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          ) : null}
        </header>
        <nav className="aiTeacherPanelTabs" role="tablist" aria-label={t('aiPanel.tabsAria')}>
          <button type="button" role="tab" aria-selected={activePanelTab === 'teacher'} onClick={() => setActivePanelTab('teacher')}>{t('aiPanel.teacherTab')}</button>
          <button type="button" role="tab" aria-selected={activePanelTab === 'model'} onClick={() => setActivePanelTab('model')}>{t('aiPanel.modelTab')}</button>
          <button type="button" role="tab" aria-selected={activePanelTab === 'diagnostics'} onClick={() => setActivePanelTab('diagnostics')}>{t('aiPanel.diagnosticsTab')}{teacherDiagnostics.length ? ` ${teacherDiagnostics.length}` : ''}</button>
        </nav>
        {!canUseTeacher ? (
          <div className="lockedFeature" data-ai-teacher-locked>
            <strong>{t(config?.aiTeacherEnabled ? 'aiPanel.accountUnavailable' : 'aiPanel.disabled')}</strong>
            <p>{t('aiPanel.unavailableBody')}</p>
          </div>
        ) : null}
        <div className="aiTeacherBody" data-ai-teacher-body>
          {activePanelTab === 'teacher' ? (
            <>
          <div ref={conversationRef} className="aiTeacherConversation" data-ai-teacher-answer data-ai-teacher-conversation aria-live="polite">
            {messages.length ? messages.map((message) => (
              <AiTeacherMessageView
                key={message.id}
                message={message}
                onPatchAction={handlePatchAction}
                onMessageFeedback={(outcome) => recordMessageFeedback(message, outcome)}
                onContinueExecution={() => runTeacher(
                  manualContinuationQuestion(messages, message.id),
                  message.response?.continuation?.sourceRunId
                )}
                onContinueEngineering={() => prepareEngineeringFeedback(message.response)}
                onViewPreviousVersion={() => viewPreviousEngineeringVersion(message.response)}
                onClarificationOption={(label) => void runTeacher(label)}
              />
            )) : (
              <div className="aiTeacherConversationEmpty">
                <strong>{submissionPhase === 'creating_thread'
                  ? t('aiPanel.creatingThread')
                  : submissionPhase === 'starting_run'
                    ? t('aiPanel.startingRun')
                    : t('aiPanel.readyTitle')}</strong>
                <p>{submissionPhase === 'creating_thread'
                  ? t('aiPanel.creatingBody')
                  : submissionPhase === 'starting_run'
                    ? t('aiPanel.startingBody')
                    : t('aiPanel.readyBody')}</p>
              </div>
            )}
          </div>
          <div className="aiTeacherQuickPrompts" aria-label={t('aiPanel.quickAria')}>
            <button type="button" onClick={() => setQuestion(t('aiPanel.quickExplainPrompt'))}>{t('aiPanel.quickExplain')}</button>
            <button type="button" onClick={() => setQuestion(t('aiPanel.quickHintPrompt'))}>{t('aiPanel.quickHint')}</button>
            <button type="button" onClick={() => setQuestion(t('aiPanel.quickModelPrompt'))}>{t('aiPanel.quickModel')}</button>
          </div>
          {busyHint ? (
            <div className="aiTeacherBusyTip" data-ai-teacher-busy-tip role="status">
              {busyHint}
            </div>
          ) : null}
          <div className="aiTeacherComposer">
            {composerContext.kind !== 'none' ? (
              <section className="aiTeacherComposerContext" data-ai-teacher-composer-context={composerContext.kind}>
                <div>
                  <strong>{composerContext.kind === 'engineering_feedback'
                    ? t('aiPanel.engineeringContext')
                    : t('aiPanel.clarificationContext')}</strong>
                  {composerContext.kind === 'engineering_feedback' && composerContext.suggestions?.length ? (
                    <ul>{composerContext.suggestions.map((item, index) => (
                      <li key={item.publicSuggestionId || `suggestion-${index}`}>{item.summary}</li>
                    ))}</ul>
                  ) : null}
                </div>
                <button type="button" onClick={() => setComposerContext({ kind: 'none' })}>{t('aiPanel.cancelContext')}</button>
              </section>
            ) : null}
            <span className="aiTeacherComposerLabel">{t('aiPanel.askLabel')}</span>
            <label className="aiTeacherAskRow">
              <textarea
                ref={questionInputRef}
                data-ai-teacher-question
                rows={3}
                value={question}
                placeholder={composerContext.kind === 'engineering_feedback'
                  ? t('aiPanel.engineeringPlaceholder')
                  : composerContext.kind === 'clarification_answer'
                    ? t('aiPanel.clarificationPlaceholder')
                    : t('aiPanel.placeholder')}
                onChange={(event) => setQuestion(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!interactionBusy) void runTeacher();
                }}
              />
            </label>
            <div className="aiTeacherComposerFooter">
              <small>{t('aiPanel.keyboardHint')}</small>
              <span className="aiTeacherAskActions">
                <button type="button" data-ai-teacher-clear aria-label={t('aiPanel.clear')} title={t('aiPanel.clear')} onClick={() => void clearConversation()}>
                  <Trash2 size={15} />
                </button>
                <button
                  type="button"
                  className="primary aiTeacherSendButton"
                  data-ai-teacher-ask
                  data-ai-teacher-running={running}
                  data-ai-teacher-submission-phase={submissionPhase}
                  aria-label={t(running ? 'aiPanel.stop' : submissionBusy ? 'aiPanel.cancelSubmit' : 'aiPanel.send')}
                  title={t(running ? 'aiPanel.stop' : submissionBusy ? 'aiPanel.cancelSubmit' : 'aiPanel.send')}
                  onClick={() => interactionBusy ? stopTeacher() : void runTeacher()}
                >
                  {interactionBusy ? <Square size={14} /> : <Send size={14} />}
                </button>
              </span>
            </div>
          </div>
            </>
          ) : activePanelTab === 'model' ? (
            <div className="aiTeacherUtilityPanel aiTeacherModelNavigationPanel" data-ai-teacher-model-navigation>
              {modelNavigation || (
                <div className="aiTeacherUtilityPanel" data-ai-teacher-model-summary>
                  <header><strong>{t('aiPanel.workspace')}</strong><span>{t('aiPanel.fileCount', { count: workspace.files.length })}</span></header>
                  {workspace.files.map((file) => (
                    <article key={file.path} data-severity={file.editable === false ? 'readonly' : 'editable'}>
                      <strong>{file.path}</strong>
                      <p>{t(file.editable === false ? 'aiPanel.referenceFile' : 'aiPanel.editableFile')}</p>
                      <span>{t('aiPanel.lineCount', { count: String(file.content || '').split(/\r?\n/).length })}</span>
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="aiTeacherUtilityPanel" data-ai-teacher-diagnostics>
              <header><strong>{t('aiPanel.currentDiagnostics')}</strong><span>{t('aiPanel.itemCount', { count: teacherDiagnostics.length })}</span></header>
              {teacherDiagnostics.length ? teacherDiagnostics.slice(0, 12).map((diagnostic, index) => (
                <article key={`${diagnostic.file || activeFilePath}-${diagnostic.line || 1}-${index}`} data-severity={diagnostic.severity || 'error'}>
                  <strong>{diagnostic.source === 'course-rule' ? t('aiPanel.courseTask') : diagnostic.severity || 'error'}</strong>
                  <p>{String(diagnostic.message || t('aiPanel.diagnosticFallback'))}</p>
                  <span>{String(diagnostic.file || activeFilePath || 'main.sysml')}:{String(diagnostic.line || 1)}</span>
                </article>
              )) : <div className="aiTeacherUtilityEmpty"><strong>{t('aiPanel.noDiagnostics')}</strong><p>{t('aiPanel.noDiagnosticsBody')}</p></div>}
            </div>
          )}
        </div>
      </section>
      </div>
      {engineeringVersionDialog}
    </>
  );

  function appendMessage(message: Omit<AiTeacherMessage, 'id'>, targetSessionKey = activeSessionKey.current): string {
    const id = `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionKeyForMessage = targetSessionKey;
    updateAiTeacherSession(sessionKeyForMessage, (session) => ({
      ...session,
      messages: [...session.messages, { ...message, id }].slice(-50)
    }), panelInstanceId.current);
    if (activeSessionKey.current === sessionKeyForMessage) setMessages((current) => [...current, { ...message, id }]);
    return id;
  }

  function updateMessage(id: string, updater: (message: AiTeacherMessage) => AiTeacherMessage, targetSessionKey = activeSessionKey.current) {
    const sessionKeyForMessage = targetSessionKey;
    updateAiTeacherSession(sessionKeyForMessage, (session) => ({
      ...session,
      messages: session.messages.map((message) => message.id === id ? updater(message) : message)
    }), panelInstanceId.current);
    if (activeSessionKey.current === sessionKeyForMessage) {
      setMessages((current) => current.map((message) => message.id === id ? updater(message) : message));
    }
  }

  function removeMessages(ids: string[], targetSessionKey = activeSessionKey.current) {
    const idSet = new Set(ids);
    const sessionKeyForMessage = targetSessionKey;
    updateAiTeacherSession(sessionKeyForMessage, (session) => ({
      ...session,
      messages: session.messages.filter((message) => !idSet.has(message.id))
    }), panelInstanceId.current);
    if (activeSessionKey.current === sessionKeyForMessage) setMessages((current) => current.filter((message) => !idSet.has(message.id)));
  }

  function scrollConversationToBottom(behavior: ScrollBehavior = 'auto') {
    const node = conversationRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }

  function notifyTeacherBusy() {
    setOpen(true);
    setBusyHint(submissionPhaseRef.current === 'creating_thread'
      ? '正在创建新对话，请取消或等待完成。'
      : submissionPhaseRef.current === 'starting_run'
        ? '正在启动 AI 教师，请取消或等待完成。'
        : 'AI 教师正在生成，请先停止或等待完成。');
    if (busyHintTimer.current) window.clearTimeout(busyHintTimer.current);
    busyHintTimer.current = window.setTimeout(() => setBusyHint(''), 2200);
  }

  function setSubmissionPhaseForPanel(value: AiTeacherSubmissionPhase) {
    submissionPhaseRef.current = value;
    setSubmissionPhase(value);
  }

  function setQuestionForSession(targetSessionKey: string, value: string) {
    updateAiTeacherSession(targetSessionKey, (session) => ({ ...session, question: value }), panelInstanceId.current);
    if (activeSessionKey.current === targetSessionKey) setQuestion(value);
  }

  function setStatusForSession(targetSessionKey: string, value: string, nextTone?: 'idle' | 'ok' | 'warn' | 'fail') {
    updateAiTeacherSession(targetSessionKey, (session) => ({
      ...session,
      status: value,
      tone: nextTone || session.tone
    }), panelInstanceId.current);
    if (activeSessionKey.current === targetSessionKey) {
      setStatus(value);
      if (nextTone) setTone(nextTone);
    }
  }

  function setRunningForSession(targetSessionKey: string, value: boolean) {
    updateAiTeacherSession(targetSessionKey, (session) => ({ ...session, running: value }), panelInstanceId.current);
    if (activeSessionKey.current === targetSessionKey) setRunning(value);
  }

  function rememberActiveRun(runId: string, targetSessionKey: string, userId: string, processId: string, assistantId: string) {
    if (activeSessionKey.current === targetSessionKey) activeRunId.current = runId;
    updateAiTeacherSession(targetSessionKey, (session) => ({
      ...session,
      running: true,
      activeRunId: runId,
      activeUserMessageId: userId,
      activeProcessMessageId: processId,
      activeAssistantMessageId: assistantId || session.activeAssistantMessageId,
      messages: session.messages.map((message) => (
        message.id === userId || message.id === processId || (assistantId && message.id === assistantId)
          ? { ...message, runId }
          : message
      ))
    }), panelInstanceId.current);
    if (activeSessionKey.current === targetSessionKey) {
      setRunning(true);
      setMessages((current) => current.map((message) => (
        message.id === userId || message.id === processId || (assistantId && message.id === assistantId)
          ? { ...message, runId }
          : message
      )));
    }
  }

  function rememberActiveAssistant(targetSessionKey: string, assistantId: string, runId = '') {
    updateAiTeacherSession(targetSessionKey, (session) => ({
      ...session,
      activeAssistantMessageId: assistantId,
      messages: session.messages.map((message) => message.id === assistantId ? { ...message, runId: runId || message.runId } : message)
    }), panelInstanceId.current);
  }

  function clearActiveRun(targetSessionKey: string) {
    aiTeacherRunControllers.delete(targetSessionKey);
    if (activeSessionKey.current === targetSessionKey) activeRunId.current = '';
    updateAiTeacherSession(targetSessionKey, (session) => ({
      ...session,
      running: false,
      activeRunId: '',
      activeRunEventSeq: 0,
      activeUserMessageId: '',
      activeProcessMessageId: '',
      activeAssistantMessageId: ''
    }), panelInstanceId.current);
    if (activeSessionKey.current === targetSessionKey) setRunning(false);
  }

  function applyRunEventsToVisibleSession(events: TeacherRunEvent[]): boolean {
    if (!events.length) return false;
    const runId = events.find((event) => event.runId)?.runId || activeRunId.current;
    const session = getAiTeacherSession(sessionKey, defaultOpen);
    const processId = session.activeProcessMessageId || session.messages.find((message) => message.runId === runId && message.role === 'process')?.id || '';
    let assistantId = session.activeAssistantMessageId || session.messages.find((message) => message.runId === runId && message.role === 'assistant')?.id || '';
    let assistantText = session.messages.find((message) => message.id === assistantId)?.text || '';
    let processText = session.messages.find((message) => message.id === processId)?.text || 'AI 教师处理中';
    let processDetails = session.messages.find((message) => message.id === processId)?.details || processText;
    let processActivities = session.messages.find((message) => message.id === processId)?.activities || [];
    let finalResponse: AiTeacherResponse | null = null;
    let errorMessage = '';
    let maxSeq = session.activeRunEventSeq || 0;
    const existingRunStartedAtMs = session.messages
      .filter((message) => message.runId === runId)
      .map((message) => message.startedAtMs || 0)
      .find((value) => value > 0) || 0;
    const eventTimestamps = events.map((event) => teacherTimestampMs(event.createdAt)).filter((value) => value > 0);
    const runStartedAtMs = existingRunStartedAtMs || (eventTimestamps.length ? Math.min(...eventTimestamps) : Date.now());
    let runCompletedAtMs = 0;

    for (const event of events) {
      maxSeq = Math.max(maxSeq, Number(event.seq || 0));
      const payload = event.payload || {};
      if (event.type === 'start') {
        const payloadRunId = typeof payload.runId === 'string' ? payload.runId : runId;
        if (payloadRunId) activeRunId.current = payloadRunId;
      }
      if ((event.type === 'answer_delta' || event.type === 'delta') && typeof payload.text === 'string') {
        assistantText = appendStreamText(assistantText, payload.text);
      }
      if (event.type === 'activity') {
        const activity = normalizeTeacherActivity(payload as AiTeacherStreamEvent);
        if (activity) {
          processText = activity.message;
          processDetails = appendProcessDetail(processDetails, activity.message);
          processActivities = upsertTeacherActivity(processActivities, activity);
        }
      }
      if ((event.type === 'thinking' || event.type === 'stage') && typeof payload.message === 'string') {
        if (event.type !== 'stage' || !isGenericLifecycleStage(payload.stage)) {
          processText = sanitizeTeacherUiText(payload.message);
          processDetails = appendProcessDetail(processDetails, payload.message);
        }
      }
      if (event.type === 'final') {
        finalResponse = normalizeFinalStreamResponse({ type: 'final', data: payload } as AiTeacherStreamEvent);
        runCompletedAtMs = teacherTimestampMs(event.createdAt) || Date.now();
      }
      if (event.type === 'error' || event.type === 'cancelled') {
        errorMessage = typeof payload.message === 'string' ? payload.message : 'AI 教师运行已结束。';
        runCompletedAtMs = teacherTimestampMs(event.createdAt) || Date.now();
      }
    }

    const finalText = finalResponse ? responseToText(finalResponse) : '';
    if ((assistantText || finalResponse) && !assistantId) {
      assistantId = appendMessage({
        role: 'assistant',
        title: finalResponse?.title || 'AI 教师',
        text: finalText || assistantText,
        response: finalResponse || undefined,
        state: finalResponse ? 'done' : 'working',
        runId,
        startedAtMs: runStartedAtMs,
        completedAtMs: finalResponse ? runCompletedAtMs : undefined
      });
      rememberActiveAssistant(sessionKey, assistantId, runId);
    }
    if (assistantId && (assistantText || finalResponse)) {
      updateMessage(assistantId, (message) => ({
        ...message,
        runId,
        text: finalText || assistantText,
        state: finalResponse ? 'done' : 'working',
        response: finalResponse || message.response,
        title: finalResponse?.title || message.title,
        startedAtMs: message.startedAtMs || runStartedAtMs,
        completedAtMs: finalResponse ? runCompletedAtMs : message.completedAtMs
      }));
    }
    if (processId) {
      const finalProcess = finalResponse ? finalProcessPresentation(finalResponse) : null;
      updateMessage(processId, (message) => ({
        ...message,
        runId,
        text: finalProcess?.text || errorMessage || processText,
        details: finalProcess ? appendProcessDetail(processDetails, finalProcess.detail) : processDetails,
        activities: processActivities,
        state: finalResponse ? 'done' : errorMessage ? 'error' : 'working',
        startedAtMs: message.startedAtMs || runStartedAtMs,
        completedAtMs: finalResponse || errorMessage ? runCompletedAtMs : message.completedAtMs
      }));
    }
    if (finalResponse && session.activeUserMessageId) {
      updateMessage(session.activeUserMessageId, (message) => ({ ...message, state: 'done' }));
    }
    updateAiTeacherSession(sessionKey, (current) => ({ ...current, activeRunEventSeq: maxSeq }), panelInstanceId.current);
    if (finalResponse) {
      setStatusForSession(sessionKey, AI_TEACHER_CHECK_NOTICE, 'ok');
      clearActiveRun(sessionKey);
    } else if (errorMessage) {
      setStatusForSession(sessionKey, friendlyTeacherError(new Error(errorMessage)), 'fail');
      clearActiveRun(sessionKey);
    }
    return Boolean(finalResponse || errorMessage);
  }

  function finishActiveRunFromStatus(runId: string, runStatus: string, errorMessage: string) {
    if (runStatus === 'succeeded') {
      return;
    } else if (runStatus === 'cancelled') {
      setStatusForSession(sessionKey, '已停止本轮回答，后端运行已取消。', 'warn');
      markRunMessages(runId, 'cancelled', '后端运行已取消。');
    } else {
      setStatusForSession(sessionKey, friendlyTeacherError(new Error(errorMessage || 'AI teacher run failed')), 'fail');
      markRunMessages(runId, 'error', errorMessage || 'AI 教师运行失败。');
    }
    clearActiveRun(sessionKey);
  }

  function markRunMessages(runId: string, state: 'error' | 'cancelled', text: string) {
    const session = getAiTeacherSession(sessionKey, defaultOpen);
    const completedAtMs = Date.now();
    for (const message of session.messages.filter((item) => item.runId === runId && item.state === 'working')) {
      updateMessage(message.id, (current) => ({
        ...current,
        text: current.text || text,
        details: current.role === 'process' ? appendProcessDetail(current.details || current.text, text) : current.details,
        state,
        completedAtMs
      }));
    }
  }

  async function requestTeacher(
    envelope: unknown,
    signal: AbortSignal,
    onEvent: (event: AiTeacherStreamEvent) => void
  ): Promise<AiTeacherResponse> {
    const streamRoute = '/api/teacher/answer-stream';
    let finalResponse: AiTeacherResponse | null = null;
    try {
      await api.stream<AiTeacherStreamEvent>(streamRoute, {
        method: 'POST',
        body: envelope,
        signal,
          onEvent(event) {
          onEvent(event);
          if (event.type === 'final') finalResponse = normalizeFinalStreamResponse(event);
          if (event.type === 'error') throw new Error(event.error || event.message || 'AI teacher stream failed');
        }
      });
      if (finalResponse) return finalResponse;
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw error;
    }
    throw new Error('AI teacher stream ended before the final response.');
  }

  async function validatePatches(response: AiTeacherResponse, envelope: unknown, signal: AbortSignal): Promise<AiTeacherResponse> {
    const patches = Array.isArray(response.patches) ? response.patches : [];
    if (!patches.length) return response;
    const validated: AiTeacherPatch[] = [];
    for (const patch of patches.slice(0, 3)) {
      try {
        const result = await api.request<{ patch?: AiTeacherPatch }>('/api/teacher/validate-patch', {
          method: 'POST',
          body: { context: envelope, patch },
          signal
        });
        validated.push(result.patch || patch);
      } catch (error) {
        validated.push({
          ...patch,
          validatorStatus: 'validator_unavailable',
          applyPolicy: 'copy_only',
          warnings: [...(patch.warnings || []), error instanceof Error ? error.message : 'patch_validation_failed']
        });
      }
    }
    return { ...response, patches: validated };
  }
}

const KNOWLEDGE_ASSISTANT_SUGGESTION_KEYS = ['sysmlComparison', 'traceability', 'simpleVehicle', 'aiEngineering'] as const;

function convertKnowledgeAssistantMessage(message: AiTeacherMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: [{ type: 'text', text: message.text }]
  };
}

function EngineeringVersionDialog({
  preview,
  canRestore,
  confirmRestore,
  onRequestRestore,
  onCancelRestore,
  onRestore,
  onClose
}: {
  preview: EngineeringVersionPreview | null;
  canRestore: boolean;
  confirmRestore: boolean;
  onRequestRestore: () => void;
  onCancelRestore: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [selectedFile, setSelectedFile] = useState(0);
  useEffect(() => {
    if (!preview) return undefined;
    setSelectedFile(0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [preview, onClose]);
  if (!preview || typeof document === 'undefined') return null;
  const file = preview.files[Math.min(selectedFile, preview.files.length - 1)];
  return createPortal(
    <div className="aiTeacherVersionBackdrop" data-ai-teacher-version-backdrop onMouseDown={onClose}>
      <section
        className="aiTeacherVersionDialog"
        data-ai-teacher-version-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-teacher-version-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="ai-teacher-version-title">改进前版本</h2>
            <p>这是本轮工程改进开始前、已经通过 Official Validator 的完整版本。</p>
          </div>
          <button type="button" aria-label="关闭版本查看" onClick={onClose}><X size={18} /></button>
        </header>
        {preview.files.length > 1 ? (
          <nav aria-label="版本文件">
            {preview.files.map((item, index) => (
              <button key={item.filePath} type="button" aria-current={index === selectedFile ? 'page' : undefined} onClick={() => setSelectedFile(index)}>{item.filePath}</button>
            ))}
          </nav>
        ) : null}
        <div className="aiTeacherVersionCode">
          <div><strong>{file.filePath}</strong><button type="button" onClick={() => void copyText(file.content)}>复制</button></div>
          <pre><code>{file.content}</code></pre>
        </div>
        <footer>
          {confirmRestore ? (
            <div className="aiTeacherVersionConfirm" role="alert">
              <p>恢复会用改进前内容覆盖当前对应文件。这个操作不会修改服务端历史版本。</p>
              <button type="button" onClick={onCancelRestore}>取消</button>
              <button type="button" className="isDanger" onClick={onRestore}>确认恢复</button>
            </div>
          ) : (
            <>
              <span>{canRestore ? `可恢复 ${preview.files.length} 个文件` : '当前页面仅支持查看和复制'}</span>
              <button type="button" onClick={onClose}>关闭</button>
              {canRestore ? <button type="button" className="isPrimary" onClick={onRequestRestore}>恢复此版本</button> : null}
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body
  );
}

function KnowledgeAssistantSurface({
  messages,
  threads,
  activeThreadId,
  threadsLoading,
  threadsError,
  deletingThreadId,
  activeExecutionThreadId,
  running,
  status,
  tone,
  canUseTeacher,
  onSubmit,
  onCancel,
  onStartNew,
  onSelectThread,
  onDeleteThread,
  onPatchAction,
  onMessageFeedback,
  composerContext,
  onPrepareEngineeringFeedback,
  onViewPreviousEngineeringVersion,
  onCancelComposerContext,
  knowledgeWorkspace
}: {
  messages: AiTeacherMessage[];
  threads: TeacherThreadSummary[];
  activeThreadId: string;
  threadsLoading: boolean;
  threadsError: string;
  deletingThreadId: string;
  activeExecutionThreadId: string;
  running: boolean;
  status: string;
  tone: 'idle' | 'ok' | 'warn' | 'fail';
  canUseTeacher: boolean;
  onSubmit: (questionOverride?: string, manualContinuationSourceRunId?: string, manualContinuationKind?: 'engineering_feedback') => Promise<void>;
  onCancel: () => void;
  onStartNew: () => Promise<void>;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => Promise<void>;
  onPatchAction: (action: string, patch: AiTeacherPatch) => void | Promise<void>;
  onMessageFeedback: (message: AiTeacherMessage, outcome: 'resolved' | 'unresolved') => Promise<void>;
  composerContext: AiTeacherComposerContext;
  onPrepareEngineeringFeedback: (response?: AiTeacherResponse) => void;
  onViewPreviousEngineeringVersion: (response?: AiTeacherResponse) => void;
  onCancelComposerContext: () => void;
  knowledgeWorkspace?: { spaceCount: number; spaces: ReactNode };
}) {
  const { t, i18n } = useTranslation('knowledge');
  const [deleteTarget, setDeleteTarget] = useState<TeacherThreadSummary | null>(null);
  const [activeSection, setActiveSection] = useState<'assistant' | 'spaces'>('assistant');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches);
  const [scrollButtonHost, setScrollButtonHost] = useState<HTMLDivElement | null>(null);
  const visibleMessages = useMemo(() => messages, [messages]);
  const messageById = useMemo(() => new Map(visibleMessages.map((message) => [message.id, message])), [visibleMessages]);
  const handleNew = useCallback(async (message: AppendMessage) => {
    const input = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.type === 'text' ? part.text : '')
      .join('\n')
      .trim();
    if (!input) throw new Error(t('assistant.inputRequired'));
    await onSubmit(
      input,
      composerContext.kind === 'engineering_feedback' ? composerContext.sourceRunId : undefined,
      composerContext.kind === 'engineering_feedback' ? 'engineering_feedback' : undefined
    );
  }, [composerContext, onSubmit, t]);
  const runtime = useExternalStoreRuntime({
    messages: visibleMessages,
    convertMessage: convertKnowledgeAssistantMessage,
    isRunning: running,
    onNew: handleNew,
    onCancel: async () => onCancel()
  });
  const hasConversation = visibleMessages.length > 0;
  const activeThread = useMemo(
    () => threads.find((thread) => thread.threadId === activeThreadId) || null,
    [activeThreadId, threads]
  );
  const hasBackgroundExecution = Boolean(activeExecutionThreadId && activeExecutionThreadId !== activeThreadId);
  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) await onDeleteThread(target.threadId);
  }, [deleteTarget, onDeleteThread]);

  useEffect(() => {
    if (!deleteTarget) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeleteTarget(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [deleteTarget]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className={`knowledgeWorkspace${sidebarCollapsed ? ' isSidebarCollapsed' : ''}`} data-knowledge-workspace data-knowledge-section={activeSection}>
        <aside className="knowledgeWorkspaceSidebar" aria-label={t('assistant.sidebarAria')}>
          <header className="knowledgeWorkspaceSidebarHeader">
            <span className="knowledgeWorkspaceBrand"><Network size={20} /></span>
            <strong>{t('assistant.library')}</strong>
            <button type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={t(sidebarCollapsed ? 'assistant.expandSidebar' : 'assistant.collapseSidebar')}>
              {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </header>
          <nav className="knowledgeWorkspaceSections" aria-label={t('assistant.sectionsAria')}>
            <button type="button" title={t('assistant.aiQa')} className={activeSection === 'assistant' ? 'isActive' : ''} aria-current={activeSection === 'assistant' ? 'page' : undefined} onClick={() => setActiveSection('assistant')}>
              <MessageCircle size={19} /><span>{t('assistant.aiQa')}</span>
            </button>
            <button type="button" title={t('assistant.spaces')} className={activeSection === 'spaces' ? 'isActive' : ''} aria-current={activeSection === 'spaces' ? 'page' : undefined} onClick={() => setActiveSection('spaces')}>
              <BookOpenText size={19} /><span>{t('assistant.spaces')}</span><small>{knowledgeWorkspace?.spaceCount || 0}</small>
            </button>
          </nav>
          <div className="knowledgeWorkspaceSidebarDivider" />
          <button className="knowledgeWorkspaceNewConversation" type="button" onClick={() => {
            setActiveSection('assistant');
            void onStartNew();
          }} disabled={Boolean(deletingThreadId)} title={t('assistant.newConversation')}>
            <Plus size={18} /><span>{t('assistant.newConversation')}</span>
          </button>
          <section className="knowledgeWorkspaceHistory" aria-label={t('assistant.history')}>
            <header><span>{t('assistant.history')}</span><small>{threads.length}</small></header>
            {threadsLoading ? <p>{t('assistant.loading')}</p> : null}
            {threadsError ? <p role="status">{threadsError}</p> : null}
            {!threadsLoading && !threadsError && !threads.length ? <p>{t('assistant.noHistory')}</p> : null}
            <div className="knowledgeWorkspaceHistoryList">
              {threads.map((thread) => (
                <div className="knowledgeWorkspaceHistoryItem" key={thread.threadId}>
                  <button
                    type="button"
                    className={thread.threadId === activeThreadId ? 'isActive' : ''}
                    onClick={() => {
                      setActiveSection('assistant');
                      onSelectThread(thread.threadId);
                    }}
                    title={thread.title}
                    aria-current={thread.threadId === activeThreadId ? 'page' : undefined}
                  >
                    <span>{thread.title}</span>
                    {activeExecutionThreadId === thread.threadId ? (
                      <LoaderCircle size={12} className="spin" aria-label={t('assistant.backgroundAnswer')} />
                    ) : null}
                    <small>{formatThreadUpdatedAt(thread.updatedAt, i18n.resolvedLanguage || 'zh-CN')}</small>
                  </button>
                  <button
                    type="button"
                    className="knowledgeWorkspaceHistoryDelete"
                    onClick={() => setDeleteTarget(thread)}
                    disabled={activeExecutionThreadId === thread.threadId || Boolean(deletingThreadId)}
                    aria-label={t('assistant.deleteNamed', { title: thread.title })}
                    title={t('assistant.delete')}
                  >
                    {deletingThreadId === thread.threadId ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <main className="knowledgeWorkspaceMain">
          {activeSection === 'spaces' ? (
            <div className="knowledgeWorkspaceSpacesPanel" data-knowledge-spaces-panel>{knowledgeWorkspace?.spaces}</div>
          ) : (
          <section
            className={`knowledgeAssistant${hasConversation ? ' hasConversation' : ' isEmpty'}`}
            data-knowledge-assistant
            data-assistant-ui-runtime="external-store"
          >
          <ThreadPrimitive.Root className="knowledgeAssistantThread">
          <ThreadPrimitive.Viewport
            className="knowledgeAssistantViewport"
            turnAnchor="top"
            autoScroll
            scrollToBottomOnInitialize
          >
            {!hasConversation ? (
              <div className="knowledgeAssistantWelcome">
                <span className="knowledgeAssistantWelcomeMark"><Bot size={28} /></span>
                <h1>{t('assistant.welcomeTitle')}</h1>
                <p>{t('assistant.welcomeBody')}</p>
              </div>
            ) : (
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  const sourceMessage = messageById.get(message.id);
                  if (!sourceMessage) return null;
                  return (
                    <MessagePrimitive.Root
                      className={`knowledgeAssistantTurn knowledgeAssistantTurn-${sourceMessage.role}`}
                      data-knowledge-assistant-message={sourceMessage.role}
                    >
                      <AiTeacherMessageView
                        message={sourceMessage}
                        onPatchAction={onPatchAction}
                        onMessageFeedback={(outcome) => onMessageFeedback(sourceMessage, outcome)}
                        onContinueExecution={() => onSubmit(
                          manualContinuationQuestion(messages, sourceMessage.id),
                          sourceMessage.response?.continuation?.sourceRunId
                        )}
                        onContinueEngineering={() => onPrepareEngineeringFeedback(sourceMessage.response)}
                        onViewPreviousVersion={() => onViewPreviousEngineeringVersion(sourceMessage.response)}
                        onClarificationOption={(label) => void onSubmit(label)}
                      />
                    </MessagePrimitive.Root>
                  );
                }}
              </ThreadPrimitive.Messages>
            )}

            {!hasConversation ? (
              <div className="knowledgeAssistantSuggestions" aria-label={t('assistant.suggestionsAria')}>
                {KNOWLEDGE_ASSISTANT_SUGGESTION_KEYS.map((key) => {
                  const prompt = t(`assistant.suggestions.${key}`);
                  return (
                  <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send disabled={!canUseTeacher}>
                    {prompt}
                  </ThreadPrimitive.Suggestion>
                  );
                })}
              </div>
            ) : null}

            {hasConversation && scrollButtonHost ? createPortal(
              <ThreadPrimitive.ScrollToBottom
                className="workbenchViewJumpButton knowledgeAssistantScrollButton"
                aria-label={t('assistant.scrollLatest')}
                title={t('assistant.scrollLatest')}
              >
                <ArrowDown size={24} strokeWidth={1.8} aria-hidden="true" />
              </ThreadPrimitive.ScrollToBottom>,
              scrollButtonHost
            ) : null}
          </ThreadPrimitive.Viewport>

          <div
            ref={setScrollButtonHost}
            className="knowledgeAssistantScrollButtonHost"
            data-knowledge-scroll-button-host
          />

          <div className="knowledgeAssistantComposerDock" data-knowledge-composer-dock>
            <div className="knowledgeAssistantComposerSurface">
              {composerContext.kind !== 'none' ? (
                <section className="aiTeacherComposerContext" data-ai-teacher-composer-context={composerContext.kind}>
                  <div>
                    <strong>{composerContext.kind === 'engineering_feedback'
                      ? t('assistant.engineeringContext')
                      : t('assistant.clarificationContext')}</strong>
                    {composerContext.kind === 'engineering_feedback' && composerContext.suggestions?.length ? (
                      <ul>{composerContext.suggestions.map((item, index) => (
                        <li key={item.publicSuggestionId || `knowledge-suggestion-${index}`}>{item.summary}</li>
                      ))}</ul>
                    ) : null}
                  </div>
                  <button type="button" onClick={onCancelComposerContext}>{t('assistant.cancelContext')}</button>
                </section>
              ) : null}
              {activeThread && activeThread.contextUsage.state !== 'normal' ? (
                <div
                  className="knowledgeAssistantContextNotice"
                  data-state={activeThread.contextUsage.state}
                  role="status"
                >
                  <span>{activeThread.contextUsage.state === 'critical'
                    ? t('assistant.contextCritical')
                    : t('assistant.contextWarning')}</span>
                  <button type="button" onClick={() => void onStartNew()} disabled={Boolean(deletingThreadId)}>{t('assistant.startAnother')}</button>
                </div>
              ) : null}
              {hasBackgroundExecution ? (
                <div className="knowledgeAssistantBackgroundRunNotice" role="status">
                  <span>{t('assistant.backgroundNotice')}</span>
                  <button type="button" onClick={() => onSelectThread(activeExecutionThreadId)}>{t('assistant.returnRunning')}</button>
                </div>
              ) : null}
              {!canUseTeacher ? (
                <div className="knowledgeAssistantNotice" data-state="fail" role="status">
                  {t('assistant.teacherUnavailable')}
                </div>
              ) : hasConversation && tone !== 'idle' ? (
                <div className="knowledgeAssistantNotice" data-state={tone} role="status">{status}</div>
              ) : null}
              <ComposerPrimitive.Root className="knowledgeAssistantComposer">
                <ComposerPrimitive.Input
                  className="knowledgeAssistantInput"
                  placeholder={t('assistant.placeholder')}
                  submitMode="enter"
                  unstable_insertNewlineOnTouchEnter
                  disabled={!canUseTeacher || hasBackgroundExecution}
                  aria-label={t('assistant.askAria')}
                />
                {running ? (
                  <ComposerPrimitive.Cancel className="knowledgeAssistantSend" aria-label={t('assistant.stop')} title={t('assistant.stop')}>
                    <Square size={15} />
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send className="knowledgeAssistantSend" disabled={!canUseTeacher || hasBackgroundExecution} aria-label={t('assistant.send')} title={t('assistant.send')}>
                    <Send size={17} />
                  </ComposerPrimitive.Send>
                )}
              </ComposerPrimitive.Root>
              <div className="knowledgeAssistantComposerMeta">
                <small>{t('assistant.notice')}</small>
                <button type="button" data-browse-knowledge-spaces onClick={() => setActiveSection('spaces')}><BookOpenText size={14} aria-hidden="true" />{t('assistant.browseSpaces')}</button>
              </div>
            </div>
          </div>
        </ThreadPrimitive.Root>
          </section>
          )}
        </main>

        {deleteTarget ? (
          <div className="knowledgeAssistantDialogBackdrop" role="presentation" onMouseDown={() => setDeleteTarget(null)}>
            <section
              className="knowledgeAssistantDialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="knowledge-assistant-delete-title"
              aria-describedby="knowledge-assistant-delete-description"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <span className="knowledgeAssistantDialogMark"><Trash2 size={18} /></span>
              <div>
                <h2 id="knowledge-assistant-delete-title">{t('assistant.deleteTitle')}</h2>
                <p id="knowledge-assistant-delete-description">{t('assistant.deleteDescription', { title: deleteTarget.title })}</p>
              </div>
              <footer>
                <button type="button" onClick={() => setDeleteTarget(null)}>{t('assistant.cancel')}</button>
                <button type="button" className="isDanger" onClick={() => void confirmDelete()}>{t('assistant.delete')}</button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </AssistantRuntimeProvider>
  );
}

function AiTeacherMessageView({
  message,
  onPatchAction,
  onMessageFeedback,
  onContinueExecution,
  onContinueEngineering,
  onViewPreviousVersion,
  onClarificationOption
}: {
  message: AiTeacherMessage;
  onPatchAction: (action: string, patch: AiTeacherPatch) => void | Promise<void>;
  onMessageFeedback: (outcome: 'resolved' | 'unresolved') => Promise<void>;
  onContinueExecution: () => void | Promise<void>;
  onContinueEngineering: () => void | Promise<void>;
  onViewPreviousVersion: () => void;
  onClarificationOption: (label: string) => void | Promise<void>;
}) {
  const [feedbackState, setFeedbackState] = useState<'idle' | 'saving' | 'resolved' | 'unresolved' | 'failed'>('idle');
  const alignment = message.response?.alignmentReview;
  const alignmentLabel = alignment?.label === 'high'
    ? '自信'
    : alignment?.label === 'medium'
      ? '大概完成'
      : alignment?.label === 'uncertain' ? '可能要讨论' : '';
  const isClarificationQuestion = message.response?.clarification?.status === 'waiting';
  const canRecordFeedback = Boolean(message.response?.messageId) && !isClarificationQuestion;
  const hasAnswerStatus = message.response?.validatorStatus === 'validated_passed' || Boolean(alignmentLabel);
  const recordFeedback = async (outcome: 'resolved' | 'unresolved') => {
    setFeedbackState('saving');
    try {
      await onMessageFeedback(outcome);
      setFeedbackState(outcome);
    } catch {
      setFeedbackState('failed');
    }
  };
  return (
    <article className={`aiTeacherMessage aiTeacherMessage-${message.role}`} data-ai-teacher-message-id={message.id} data-state={message.state || 'done'}>
      <div className="aiTeacherMessageMeta">
        <span>
          {message.role === 'process' && message.state === 'working' ? <ThinkingBotIndicator /> : null}
          {message.title}
          {message.role === 'assistant' ? <AiTeacherElapsedTime message={message} /> : null}
        </span>
      </div>
      {message.role === 'process'
        ? <ProcessMessageBody message={message} />
        : <MessageText id={message.id} text={message.text} codeBlockValidations={message.response?.codeBlockValidations} />}
      {message.role === 'user' && message.state && message.state !== 'done' ? (
        <small className="aiTeacherUserMessageState" data-state={message.state} role="status">
          {message.state === 'working'
            ? '回答生成中，刷新页面后会继续恢复。'
            : message.state === 'cancelled'
              ? '回答已停止，问题已保留。'
              : '回答失败，问题已保留。'}
        </small>
      ) : null}
      {visibleResponseSections(message.response).length ? (
        <div className="aiTeacherSections">
          {visibleResponseSections(message.response).slice(0, 6).map((section, index) => (
            <section key={`${message.id}-section-${index}`}>
              <strong>{sanitizeTeacherUiText(section.title || section.kind || '说明')}</strong>
              <MessageText id={`${message.id}-section-${index}`} text={String(section.content || '')} />
            </section>
          ))}
        </div>
      ) : null}
      {isClarificationQuestion && message.response?.clarification?.options?.length ? (
        <section className="aiTeacherQuestionCard" data-ai-teacher-question-card aria-label="AI 教师问题选项">
          <strong>{sanitizeTeacherUiText(message.response.clarification.question || '请选择一个选项')}</strong>
          <div role="group" aria-label="可选回答">
            {message.response.clarification.options.slice(0, 5).map((option, index) => (
              <button
                type="button"
                key={option.optionId || `${message.id}-option-${index}`}
                onClick={() => void onClarificationOption(String(option.label || ''))}
              >{sanitizeTeacherUiText(option.label || '')}</button>
            ))}
          </div>
        </section>
      ) : null}
      {message.response?.engineeringReview ? (
        <section className="aiTeacherEngineeringReviewCard" data-ai-teacher-engineering-review>
          <header>
            <strong>{message.response.engineeringReview.revisionDelivered
              ? '已交付一轮工程改进'
              : '当前模型已保留'}</strong>
            <span>{message.response.engineeringReview.engineeringResolution === 'resolved'
              ? '工程建议已解决'
              : message.response.engineeringReview.engineeringResolution === 'unresolved'
                ? '仍有工程改进建议'
                : message.response.engineeringReview.engineeringResolution === 'unknown'
                  ? '工程复核状态未知'
                  : '未进行工程复核'}</span>
          </header>
          {message.response.engineeringReview.openSuggestions?.length ? (
            <ul>{message.response.engineeringReview.openSuggestions.slice(0, 4).map((item, index) => (
              <li key={item.publicSuggestionId || `${message.id}-engineering-${index}`}>
                {sanitizeTeacherUiText(item.summary || '')}
              </li>
            ))}</ul>
          ) : null}
          {message.response.engineeringReview.previousVersion?.available ? (
            <button className="aiTeacherVersionAction" type="button" onClick={onViewPreviousVersion}>查看改进前版本</button>
          ) : null}
          {message.response.engineeringReview.canContinue
            && /^run_[a-zA-Z0-9-]{8,160}$/.test(String(message.response.engineeringReview.sourceRunId || '')) ? (
            <footer>
              <p>可以补充优先级、约束或希望保留的内容，再开始下一轮。</p>
              <button className="aiTeacherContinuationAction" type="button" onClick={() => void onContinueEngineering()}>继续改进</button>
            </footer>
          ) : null}
        </section>
      ) : null}
      {message.response?.continuation?.autoContinuationUsed ? (
        <section className="aiTeacherContinuationCard" data-ai-teacher-continuation>
          <header>
            <strong>{message.response.continuation.status === 'complete' ? '自动续跑已完成' : '自动续跑已结束'}</strong>
            <span>最多自动续跑 1 轮</span>
          </header>
          {message.response.continuation.completedItems?.length ? (
            <div>
              <h4>已完成</h4>
              <ul>{message.response.continuation.completedItems.map((item, index) => (
                <li key={`${message.id}-continuation-completed-${index}`}>
                  <strong>{sanitizeTeacherUiText(item.title || '')}</strong>
                  {item.detail ? <span>{sanitizeTeacherUiText(item.detail)}</span> : null}
                </li>
              ))}</ul>
            </div>
          ) : null}
          {message.response.continuation.remainingItems?.length ? (
            <div>
              <h4>尚未完成</h4>
              <ul>{message.response.continuation.remainingItems.map((item, index) => (
                <li key={`${message.id}-continuation-remaining-${index}`}>
                  <strong>{sanitizeTeacherUiText(item.title || '')}</strong>
                  {item.detail ? <span>{sanitizeTeacherUiText(item.detail)}</span> : null}
                </li>
              ))}</ul>
            </div>
          ) : null}
          {message.response.continuation.canContinue
            && /^run_[a-zA-Z0-9-]{8,160}$/.test(String(message.response.continuation.sourceRunId || '')) ? (
            <footer>
              <p>是否继续完成剩余工作？</p>
              <button className="aiTeacherContinuationAction" type="button" onClick={() => void onContinueExecution()}>继续完成剩余工作</button>
            </footer>
          ) : null}
        </section>
      ) : null}
      {message.response?.patches?.length ? (
        <div className="aiTeacherPatchList">
          {message.response.patches.map((patch) => (
            <PatchCard key={patch.patchId || patch.title} patch={patch} onAction={onPatchAction} />
          ))}
        </div>
      ) : null}
      {message.role === 'assistant' && message.state !== 'working' && (hasAnswerStatus || canRecordFeedback) ? (
        <footer className="aiTeacherMessageFooter">
          <div className="aiTeacherAlignmentStatus" aria-label="本轮修复状态">
            {message.response?.validatorStatus === 'validated_passed' ? (
              <span data-kind="validator">官方 Validator 已通过</span>
            ) : null}
            {alignmentLabel ? (
              <span data-kind="alignment" data-level={alignment?.label} title={alignment?.summary || ''}>
                {alignmentLabel}
              </span>
            ) : null}
          </div>
          {canRecordFeedback ? (
            <div
              className="aiTeacherTurnFeedback"
              role="group"
              aria-label="评价这次回答"
              aria-busy={feedbackState === 'saving'}
            >
              <button
                type="button"
                data-feedback-outcome="resolved"
                data-selected={feedbackState === 'resolved'}
                aria-label="有帮助，问题已解决"
                aria-pressed={feedbackState === 'resolved'}
                title="已解决"
                disabled={feedbackState === 'saving'}
                onClick={() => void recordFeedback('resolved')}
              >
                <ThumbsUp aria-hidden="true" size={15} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                data-feedback-outcome="unresolved"
                data-selected={feedbackState === 'unresolved'}
                aria-label="没帮助，问题还没解决"
                aria-pressed={feedbackState === 'unresolved'}
                title="还没解决"
                disabled={feedbackState === 'saving'}
                onClick={() => void recordFeedback('unresolved')}
              >
                <ThumbsDown aria-hidden="true" size={15} strokeWidth={1.8} />
              </button>
              {feedbackState === 'failed' ? <small role="status">记录失败，可重试</small> : null}
            </div>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

function ProcessMessageBody({ message }: { message: AiTeacherMessage }) {
  const detail = sanitizeTeacherUiText(message.details || '');
  const lines = processDetailLines(detail);
  const isWorking = message.state === 'working';
  const [expanded, setExpanded] = useState(isWorking);

  useEffect(() => {
    setExpanded(isWorking);
  }, [isWorking]);

  return (
    <details
      className="aiTeacherStreamDrawer aiTeacherProcessDrawer"
      data-state={message.state || 'done'}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="aiTeacherStreamLabel" data-ai-teacher-process-summary>
          <span>{sanitizeTeacherUiText(message.text) || '处理中...'}</span>
        </span>
        <small>{expanded ? '收起过程' : isWorking ? '思考中' : '查看过程'}</small>
      </summary>
      <div className="aiTeacherStreamBody">
        {message.activities?.length ? (
          <ol className="aiTeacherActivityList" aria-label="AI Teacher 查询与验证活动" data-ai-teacher-activity-list>
            {message.activities.map((activity) => (
              <li key={activity.activityId} data-kind={activity.kind} data-status={activity.status} data-ai-teacher-activity>
                <span className="aiTeacherActivityState" aria-hidden="true">
                  {activity.status === 'running'
                    ? <LoaderCircle className="aiTeacherStepSpinner" size={13} />
                    : activity.status === 'error' ? <X size={12} /> : <Check size={12} />}
                </span>
                <span className="aiTeacherActivityContent">
                  <strong>{activity.message}</strong>
                  {activity.items?.length ? (
                    <span className="aiTeacherActivityItems">
                      {activity.items.map((item, index) => item.url ? (
                        <a key={`${activity.activityId}-${index}`} href={item.url} target="_blank" rel="noreferrer">
                          {item.title}{item.detail ? <small>{item.detail}</small> : null}
                        </a>
                      ) : (
                        <span key={`${activity.activityId}-${index}`}>
                          {item.title}{item.detail ? <small>{item.detail}</small> : null}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {detail ? (
          <div className="aiTeacherProcessTimelineWrap">
            <ol className="aiTeacherProcessTimeline" aria-label="AI 教师处理过程">
              {lines.map((line, index) => {
                const active = isWorking && index === lines.length - 1;
                const complete = message.state === 'done' || index < lines.length - 1;
                return (
                  <li
                    key={`${message.id}-process-${index}`}
                    data-active={active ? 'true' : 'false'}
                    data-complete={complete ? 'true' : 'false'}
                  >
                    <span className="aiTeacherProcessDot" aria-hidden="true">
                      {complete ? <Check size={10} /> : <LoaderCircle className="aiTeacherStepSpinner" size={11} />}
                    </span>
                    <span>{line}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function isGenericLifecycleStage(value: unknown) {
  return value === 'step_started' || value === 'step_finished';
}

function ThinkingBotIndicator() {
  return (
    <span className="aiTeacherThinkingBot" aria-hidden="true">
      <Bot size={13} />
      <span><i /><i /><i /></span>
    </span>
  );
}

function AiTeacherElapsedTime({ message }: { message: AiTeacherMessage }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isWorking = message.state === 'working';
  useEffect(() => {
    if (!isWorking || !message.startedAtMs) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isWorking, message.startedAtMs]);
  if (!message.startedAtMs) return null;
  const endAtMs = message.completedAtMs || nowMs;
  const elapsedMs = Math.max(0, endAtMs - message.startedAtMs);
  return (
    <small
      className="aiTeacherMessageElapsed"
      data-ai-teacher-elapsed
      data-state={isWorking ? 'working' : 'complete'}
      role="timer"
      aria-live="off"
      title={`本轮总用时 ${formatAiTeacherElapsed(elapsedMs, isWorking)}`}
    >
      {isWorking ? '已用时' : '用时'} {formatAiTeacherElapsed(elapsedMs, isWorking)}
    </small>
  );
}

function formatAiTeacherElapsed(elapsedMs: number, isWorking = false): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const totalSeconds = isWorking ? elapsedSeconds + 1 : elapsedSeconds;
  if (totalSeconds < 1) return '<1 秒';
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
}

function MessageText({ id, text, codeBlockValidations }: { id: string; text: string; codeBlockValidations?: AiTeacherCodeBlockValidation[] }) {
  const normalized = sanitizeTeacherUiText(text).trim();
  if (!normalized) return null;
  return (
    <div className="aiTeacherText">
      {renderTeacherMarkdown(id, normalized, codeBlockValidations)}
    </div>
  );
}

function PatchCard({ patch, onAction }: { patch: AiTeacherPatch; onAction: (action: string, patch: AiTeacherPatch) => void | Promise<void> }) {
  const operation = patch.operations?.[0];
  return (
    <section className="aiTeacherPatchCard" data-ai-teacher-patch-id={patch.patchId || ''}>
      <div className="aiTeacherPatchHead">
        <strong>{patch.title || '单行代码建议'}</strong>
        <span data-status={patch.validatorStatus || 'not_validated'}>{teacherPatchStatusLabel(patch.validatorStatus)}</span>
      </div>
      <dl className="aiTeacherPatchMeta">
        <div><dt>文件</dt><dd>{patch.baseFilePath || operation?.filePath || ''}</dd></div>
        <div><dt>行</dt><dd>{operation?.startLine || ''}</dd></div>
      </dl>
      <pre className="aiTeacherPatchPreview"><code>{patch.previewText || operation?.replacement || ''}</code></pre>
      {patch.validationDiagnostics?.length ? (
        <ul className="aiTeacherPatchDiagnostics">
          {patch.validationDiagnostics.slice(0, 3).map((item, index) => <li key={index}>{item.message || String(item)}</li>)}
        </ul>
      ) : null}
      <div className="aiTeacherPatchActions">
        <button type="button" data-ai-teacher-patch-action="apply" data-patch-id={patch.patchId || ''} disabled={!isAiTeacherPatchApplyReady(patch)} onClick={() => void onAction('apply', patch)}>应用</button>
        <button type="button" data-ai-teacher-patch-action="copy" data-patch-id={patch.patchId || ''} onClick={() => void onAction('copy', patch)}><Copy size={13} />复制</button>
        <button type="button" data-ai-teacher-patch-action="discard" data-patch-id={patch.patchId || ''} onClick={() => void onAction('discard', patch)}>放弃</button>
      </div>
    </section>
  );
}

function responseToText(response: AiTeacherResponse): string {
  return sanitizeTeacherUiText(
    stripInternalTeacherBlocks(response.directAnswer || response.title || 'AI 教师已响应。')
  ).replace(/\s*\[source:[^\]\r\n]{1,320}\]/gu, '').trim();
}

function appendStreamText(current: string, delta: unknown): string {
  return `${current || ''}${sanitizeTeacherUiText(delta)}`;
}

function appendProcessDetail(current: string, next: unknown): string {
  const cleanCurrent = sanitizeTeacherUiText(current).trim();
  const cleanNext = sanitizeTeacherUiText(next).trim();
  if (!cleanNext) return cleanCurrent;
  if (!cleanCurrent) return cleanNext;
  return `${cleanCurrent}\n${cleanNext}`;
}

function normalizeTeacherActivity(event: AiTeacherStreamEvent): AiTeacherActivity | null {
  const allowedKinds = new Set<AiTeacherActivity['kind']>(['context', 'knowledge', 'web', 'skill', 'validator', 'repair']);
  const allowedStatuses = new Set<AiTeacherActivity['status']>(['running', 'complete', 'error']);
  const kind = allowedKinds.has(event.kind as AiTeacherActivity['kind'])
    ? event.kind as AiTeacherActivity['kind']
    : 'knowledge';
  const status = allowedStatuses.has(event.status as AiTeacherActivity['status'])
    ? event.status as AiTeacherActivity['status']
    : 'running';
  const message = sanitizeTeacherUiText(event.message || '').trim().slice(0, 240);
  const activityId = sanitizeTeacherUiText(event.activityId || '').trim().slice(0, 120);
  if (!message || !activityId) return null;
  const rawItems = Array.isArray(event.items) ? event.items : [];
  const items = rawItems.slice(0, 3).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const source = item as Record<string, unknown>;
    const title = sanitizeTeacherUiText(source.title || '').trim().slice(0, 180);
    if (!title) return null;
    const detail = sanitizeTeacherUiText(source.detail || '').trim().slice(0, 240);
    const url = normalizePublicTeacherUrl(source.url);
    return { title, ...(detail ? { detail } : {}), ...(url ? { url } : {}) };
  }).filter((item): item is AiTeacherActivityItem => Boolean(item));
  const count = Number(event.count);
  return {
    activityId,
    kind,
    status,
    message,
    ...(Number.isFinite(count) ? { count: Math.max(0, Math.min(999, Math.floor(count))) } : {}),
    ...(items.length ? { items } : {})
  };
}

function finalProcessPresentation(response: AiTeacherResponse): { text: string; detail: string } {
  if (response.clarification?.status === 'waiting') {
    return { text: '等待补充信息', detail: 'AI 教师正在等待你的补充信息。' };
  }
  if (response.validatorStatus === 'validated_failed') {
    return {
      text: '验证未通过，本轮已结束',
      detail: '本轮在修复预算内未形成通过官方 Validator 的候选。'
    };
  }
  if (response.answerCompletionStatus === 'incomplete') {
    return { text: '本轮未完成', detail: '本轮运行已结束，交付尚未完成。' };
  }
  return { text: '生成完成', detail: '已完成回答流程。' };
}

function upsertTeacherActivity(current: AiTeacherActivity[] | undefined, next: AiTeacherActivity): AiTeacherActivity[] {
  const activities = [...(current || [])];
  const index = activities.findIndex((activity) => activity.activityId === next.activityId);
  if (index >= 0) activities[index] = { ...activities[index], ...next };
  else activities.push(next);
  return activities.slice(-12);
}

function normalizePublicTeacherUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function processDetailLines(detail: string): string[] {
  const seen = new Set<string>();
  return sanitizeTeacherUiText(detail)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function normalizeFinalStreamResponse(event: AiTeacherStreamEvent): AiTeacherResponse | null {
  if (event.response) return event.response;
  if (event.data) return event.data;
  const { type, text, message, error, data, response, ...rest } = event;
  return rest as AiTeacherResponse;
}

function visibleResponseSections(response?: AiTeacherResponse): NonNullable<AiTeacherResponse['sections']> {
  return (response?.sections || [])
    .filter((section) => !isInternalTeacherSection(section))
    .map((section) => ({ ...section, content: stripInternalTeacherBlocks(section.content || '') }))
    .filter((section) => sanitizeTeacherUiText(section.content || section.title || section.kind).trim());
}

function isInternalTeacherSection(section: NonNullable<AiTeacherResponse['sections']>[number]): boolean {
  const label = sanitizeTeacherUiText(`${section.kind || ''} ${section.title || ''}`).toLowerCase();
  return label.includes('ai teacher generation')
    || label.includes('agentic teaching process')
    || label.includes('retrieved reviewed knowledge')
    || label.includes('llm provider')
    || label.includes('retrieval_context')
    || label.includes('retrieval context');
}

function stripInternalTeacherBlocks(value: unknown): string {
  const lines = sanitizeTeacherUiText(value).split(/\r?\n/);
  const firstInternalLine = lines.findIndex((line) => isInternalTeacherLine(line));
  return (firstInternalLine >= 0 ? lines.slice(0, firstInternalLine) : lines).join('\n').trim();
}

function isInternalTeacherLine(line: string): boolean {
  const normalized = line
    .replace(/^#+\s*/, '')
    .replace(/^[*-]\s*/, '')
    .trim()
    .toLowerCase();
  return normalized.startsWith('ai teacher generation')
    || normalized.startsWith('retrieved reviewed knowledge')
    || normalized.startsWith('ai teacher llm provider');
}

function renderTeacherMarkdown(id: string, value: string, codeBlockValidations?: AiTeacherCodeBlockValidation[]) {
  return <TeacherMarkdown key={id} value={value} codeBlockValidations={codeBlockValidations} />;
}

function TeacherMarkdown({ value, codeBlockValidations }: { value: string; codeBlockValidations?: AiTeacherCodeBlockValidation[] }) {
  const codeBlockIndexRef = useRef(0);
  const codeBlockValidationsRef = useRef(codeBlockValidations);
  codeBlockIndexRef.current = 0;
  codeBlockValidationsRef.current = codeBlockValidations;
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
      const language = String(child.props.className || '').replace(/^language-/, '').trim();
      const code = String(child.props.children || '').replace(/\n$/, '');
      const validation = codeBlockValidationAt(codeBlockValidationsRef.current, codeBlockIndexRef.current);
      codeBlockIndexRef.current += 1;
      if (language.toLowerCase() === 'mermaid') return <TeacherMermaidDiagram code={code} />;
      return <TeacherCodeBlock code={code} language={language} validation={validation} />;
    },
    table: ({ children, node: _node, ...props }) => (
      <div className="aiTeacherTableScroll" role="region" aria-label="回答表格，可横向滚动" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    input: ({ node: _node, ...props }) => <input {...props} disabled />
  }), []);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
      {value}
    </ReactMarkdown>
  );
}

function codeBlockValidationAt(validations: AiTeacherCodeBlockValidation[] | undefined, index: number): AiTeacherCodeBlockValidation | undefined {
  return validations?.find((item) => Number(item.index || 0) === index);
}

let mermaidConfigured = false;
let mermaidRenderSequence = 0;

function TeacherMermaidDiagram({ code }: { code: string }) {
  const sourceError = mermaidSourceError(code);
  const [state, setState] = useState<'working' | 'ok' | 'fail'>(sourceError ? 'fail' : 'working');
  const [documentMarkup, setDocumentMarkup] = useState('');
  const [errorMessage, setErrorMessage] = useState(sourceError);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialogTitleId = useId();
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (sourceError) return undefined;
    let disposed = false;
    const render = async () => {
      setState('working');
      setErrorMessage('');
      try {
        const { default: mermaid } = await import('mermaid');
        if (!mermaidConfigured) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
            secure: ['securityLevel', 'secure', 'startOnLoad', 'maxTextSize', 'flowchart'],
            flowchart: { htmlLabels: false }
          });
          mermaidConfigured = true;
        }
        const renderId = `ai-teacher-mermaid-${++mermaidRenderSequence}`;
        await mermaid.parse(code);
        const result = await mermaid.render(renderId, code);
        if (disposed) return;
        setDocumentMarkup(mermaidSandboxDocument(result.svg));
        setState('ok');
      } catch (error) {
        if (disposed) return;
        const detail = sanitizeTeacherUiText(error instanceof Error ? error.message : String(error)).slice(0, 500);
        setErrorMessage(detail || 'Mermaid 图表语法无法解析。');
        setState('fail');
      }
    };
    void render();
    return () => { disposed = true; };
  }, [code, sourceError]);

  useEffect(() => {
    if (!expanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      expandButtonRef.current?.focus({ preventScroll: true });
    };
  }, [expanded]);

  const copySource = async () => {
    await copyText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <figure className="aiTeacherMermaid" data-ai-teacher-mermaid data-state={state} data-expanded={expanded ? 'true' : 'false'}>
      <figcaption>
        <span><Network size={14} aria-hidden="true" />Mermaid 架构图</span>
        <span className="aiTeacherMermaidActions">
          {state === 'ok' ? (
            <button
              ref={expandButtonRef}
              type="button"
              data-ai-teacher-mermaid-expand
              aria-label="全屏查看架构图"
              aria-expanded={expanded}
              title="全屏查看架构图"
              onPointerDown={(event) => {
                event.preventDefault();
                setExpanded(true);
              }}
              onClick={() => setExpanded(true)}
            >
              <Maximize2 size={14} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label="复制 Mermaid 源码" title="复制 Mermaid 源码" onClick={() => void copySource()}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
        </span>
      </figcaption>
      {state === 'working' ? (
        <div className="aiTeacherMermaidStatus" role="status">
          <LoaderCircle className="aiTeacherStepSpinner" size={18} aria-hidden="true" />
          <span>正在渲染架构图…</span>
        </div>
      ) : null}
      {state === 'ok' ? (
        <iframe
          className="aiTeacherMermaidFrame"
          title="AI 教师回答中的 Mermaid 架构图"
          sandbox=""
          srcDoc={documentMarkup}
        />
      ) : null}
      {state === 'fail' ? (
        <div className="aiTeacherMermaidError" role="alert">
          <strong>架构图渲染失败，已保留源码</strong>
          <span>{errorMessage}</span>
          <pre><code>{code}</code></pre>
        </div>
      ) : null}
      {expanded && state === 'ok' && document.body ? createPortal(
        <div className="aiTeacherMermaidBackdrop" data-ai-teacher-mermaid-backdrop onMouseDown={() => setExpanded(false)}>
          <section
            className="aiTeacherMermaidDialog"
            data-ai-teacher-mermaid-dialog
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2 id={dialogTitleId}>Mermaid 架构图</h2>
                <p>全屏查看 AI 教师回答中的架构关系。</p>
              </div>
              <div className="aiTeacherMermaidDialogActions">
                <button type="button" aria-label="复制 Mermaid 源码" title="复制 Mermaid 源码" onClick={() => void copySource()}>
                  {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                </button>
                <button ref={closeButtonRef} type="button" aria-label="退出全屏" title="退出全屏" onClick={() => setExpanded(false)}>
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            </header>
            <iframe
              className="aiTeacherMermaidDialogFrame"
              title="全屏 Mermaid 架构图"
              sandbox=""
              srcDoc={documentMarkup}
            />
          </section>
        </div>,
        document.body
      ) : null}
    </figure>
  );
}

function mermaidSourceError(code: string): string {
  if (code.length > 20_000) return '图表源码超过 20,000 字符，已停止渲染。';
  if (/^\s*mindmap\b/im.test(code)) return '当前轻量渲染器不支持 mindmap，请改用 flowchart 表达同一结构。';
  if (/defaultRenderer\s*["']?\s*:\s*["']?elk/i.test(code)) return '当前轻量渲染器不支持 ELK 布局，请移除 defaultRenderer: elk 后重试。';
  return '';
}

function mermaidSandboxDocument(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;min-height:100%;background:#fff}body{display:grid;place-items:center;padding:12px;box-sizing:border-box;overflow:auto}svg{display:block;max-width:100%;height:auto;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}</style></head><body>${svg}</body></html>`;
}

function TeacherCodeBlock({ code, language, validation }: { code: string; language?: string; validation?: AiTeacherCodeBlockValidation }) {
  const api = useAppApiClient();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [renderOpen, setRenderOpen] = useState(false);
  const [isRenderMaximized, setIsRenderMaximized] = useState(false);
  const [renderState, setRenderState] = useState<'idle' | 'working' | 'ok' | 'fail'>('idle');
  const [renderResult, setRenderResult] = useState<PlantUmlRenderResult | null>(null);
  const [renderError, setRenderError] = useState('');
  const [selectedPlantUmlView, setSelectedPlantUmlView] = useState('');
  const plantUmlCacheRef = useRef(new Map<string, PlantUmlRenderResult>());
  const displayedPlantUmlViewRef = useRef('');
  const requestedPlantUmlViewRef = useRef('');
  const renderRequestRevisionRef = useRef(0);
  const dialogTitleId = useId();
  const viewCountId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cleanLanguage = sanitizeTeacherUiText(language || '').replace(/[^a-zA-Z0-9_+.-]/g, '').slice(0, 24);
  const showValidation = Boolean(validation) || /sysml/i.test(cleanLanguage) || /\bpackage\s+[A-Za-z_][\w]*\s*\{/.test(code);
  const canRenderPlantUml = /sysml/i.test(cleanLanguage) || /\b(?:package|part|port|interface|view)\b/.test(code);
  const plantUmlWorkspace = useMemo<WorkspaceSnapshot>(() => ({
    files: [{ path: 'main.sysml', content: code, loadPolicy: 'always' }],
    entryFile: 'main.sysml',
    activeFilePath: 'main.sysml'
  }), [code]);
  const plantUmlViews = useMemo(() => plantUmlViewOptions(plantUmlWorkspace), [plantUmlWorkspace]);
  const validationStatus = teacherCodeBlockValidationStatus(validation);
  const validationLabel = teacherCodeBlockValidationLabel(validation);
  const validationTitle = teacherCodeBlockValidationTitle(validation);
  const handleCopy = async () => {
    try {
      await copyText(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 1800);
  };
  const renderPlantUml = async (requestedViewName = selectedPlantUmlView) => {
    setRenderOpen(true);
    requestedPlantUmlViewRef.current = requestedViewName;
    const cached = plantUmlCacheRef.current.get(requestedViewName);
    if (cached?.ok && cached.svg) {
      displayedPlantUmlViewRef.current = requestedViewName;
      setRenderResult(cached);
      setRenderError('');
      setRenderState('ok');
      return;
    }
    const requestRevision = ++renderRequestRevisionRef.current;
    setRenderState('working');
    setRenderError('');
    try {
      const result = await api.request<PlantUmlRenderResult>('/api/plantuml', {
        method: 'POST',
        body: plantUmlRequestBody(plantUmlWorkspace, requestedViewName)
      });
      if (!result.ok || !result.svg) throw new Error(friendlyPlantUmlError(null, result));
      if (requestRevision !== renderRequestRevisionRef.current) return;
      plantUmlCacheRef.current.set(requestedViewName, result);
      if (plantUmlCacheRef.current.size > 12) {
        const oldest = plantUmlCacheRef.current.keys().next().value;
        if (oldest !== undefined) plantUmlCacheRef.current.delete(oldest);
      }
      displayedPlantUmlViewRef.current = requestedViewName;
      setRenderResult(result);
      setRenderState('ok');
    } catch (error) {
      if (requestRevision !== renderRequestRevisionRef.current) return;
      setRenderError(friendlyPlantUmlError(error));
      if (renderResult?.svg) setSelectedPlantUmlView(displayedPlantUmlViewRef.current);
      setRenderState('fail');
    }
  };
  const selectPlantUmlView = (viewName: string) => {
    setSelectedPlantUmlView(viewName);
    void renderPlantUml(viewName);
  };
  const closeRenderView = () => {
    setRenderOpen(false);
    setIsRenderMaximized(false);
  };

  useEffect(() => {
    renderRequestRevisionRef.current += 1;
    plantUmlCacheRef.current.clear();
    displayedPlantUmlViewRef.current = '';
    requestedPlantUmlViewRef.current = '';
    setSelectedPlantUmlView('');
    setRenderResult(null);
    setRenderError('');
    setRenderState('idle');
  }, [code]);

  useEffect(() => {
    if (!renderOpen) return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRenderView();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [renderOpen]);

  const modal = renderOpen && typeof document !== 'undefined' ? createPortal(
    <div
      className="aiTeacherPlantUmlBackdrop"
      data-ai-teacher-plantuml-backdrop
      data-maximized={isRenderMaximized}
      onMouseDown={closeRenderView}
    >
      <section
        className="aiTeacherPlantUmlDialog"
        data-ai-teacher-plantuml-dialog
        data-maximized={isRenderMaximized}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        aria-busy={renderState === 'working'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id={dialogTitleId}>PlantUML 模型视图</h2>
            <p>由当前回答中的 SysML v2 代码临时生成，不会修改课程或模型文件。</p>
          </div>
          <div className="aiTeacherPlantUmlHeaderActions">
            <button
              type="button"
              aria-label={isRenderMaximized ? '还原模型视图' : '最大化模型视图'}
              aria-pressed={isRenderMaximized}
              title={isRenderMaximized ? '还原' : '最大化'}
              onClick={() => setIsRenderMaximized((current) => !current)}
            >
              {isRenderMaximized ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}
            </button>
            <button ref={closeButtonRef} type="button" aria-label="关闭 PlantUML 视图" title="关闭" onClick={closeRenderView}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          {plantUmlViews.length > 1 ? (
            <div
              className="viewToolbar plantUmlViewSelectorToolbar aiTeacherPlantUmlViewSelectorToolbar"
              data-ai-teacher-plantuml-view-selector
            >
              <label className="plantUmlViewSelector">
                <span>模型 view</span>
                <select
                  data-ai-teacher-plantuml-view-select
                  aria-label="选择回答代码中的 PlantUML 模型 view"
                  aria-describedby={viewCountId}
                  value={selectedPlantUmlView}
                  disabled={renderState === 'working'}
                  onChange={(event) => selectPlantUmlView(event.currentTarget.value)}
                >
                  <option value="">自动选择</option>
                  {plantUmlViews.map((view) => (
                    <option key={view.qualifiedName} value={view.qualifiedName}>{view.name}</option>
                  ))}
                </select>
              </label>
              <span id={viewCountId} data-ai-teacher-plantuml-view-count>
                检测到 {plantUmlViews.length} 个显式 view；切换不会修改代码。
              </span>
            </div>
          ) : null}
        </header>
        <div className="aiTeacherPlantUmlBody" data-state={renderState}>
          {renderState === 'working' && !renderResult?.svg ? (
            <div className="aiTeacherPlantUmlStatus" role="status">
              <LoaderCircle className="aiTeacherStepSpinner" size={22} aria-hidden="true" />
              <strong>正在生成 PlantUML 视图…</strong>
              <span>官方渲染器会先检查当前代码，再返回 SVG。</span>
            </div>
          ) : null}
          {renderState === 'fail' && !renderResult?.svg ? (
            <div className="aiTeacherPlantUmlStatus isError" role="alert">
              <strong>视图生成失败</strong>
              <span>{renderError}</span>
              <button type="button" onClick={() => void renderPlantUml(requestedPlantUmlViewRef.current)}>重新生成</button>
            </div>
          ) : null}
          {renderResult?.svg ? (
            <div className="aiTeacherPlantUmlCanvas">
              <PlantUmlViewport svgMarkup={renderResult.svg} />
            </div>
          ) : null}
          {renderState === 'working' && renderResult?.svg ? (
            <div className="plantUmlSwitchingNotice" data-ai-teacher-plantuml-switching role="status">
              正在切换模型 view，当前图形会保留到新视图生成完成。
            </div>
          ) : null}
          {renderState === 'fail' && renderResult?.svg ? (
            <div className="plantUmlSwitchingNotice isError" data-ai-teacher-plantuml-switch-error role="alert">
              切换失败，已保留原视图：{renderError}
            </div>
          ) : null}
        </div>
        {renderResult ? (
          <footer>
            <strong>{renderResult.viewName || '当前模型'} 已生成</strong>
            {plantUmlMetadataNotes(renderResult).map((note) => <span key={note}>{note}</span>)}
          </footer>
        ) : null}
      </section>
    </div>,
    document.body
  ) : null;
  return (
    <>
      <figure className="aiTeacherCodeBlock" data-code-validation-status={validationStatus}>
        <figcaption>
          <span className="aiTeacherCodeBlockMeta">
            <span className="aiTeacherCodeLanguage">{cleanLanguage || 'code'}</span>
            {showValidation ? (
              <span className="aiTeacherCodeValidation" data-status={validationStatus} title={validationTitle}>
                <span className="aiTeacherCodeValidationLights" aria-hidden="true">
                  <i className="aiTeacherCodeLight-red" />
                  <i className="aiTeacherCodeLight-yellow" />
                  <i className="aiTeacherCodeLight-green" />
                </span>
                <span>{validationLabel}</span>
              </span>
            ) : null}
          </span>
          <span className="aiTeacherCodeActions">
            {canRenderPlantUml ? (
              <button type="button" data-ai-teacher-plantuml-action aria-label="渲染 PlantUML 视图" title="渲染 PlantUML 视图" onClick={() => void renderPlantUml()}>
                <Network size={14} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              data-copy-state={copyState}
              aria-label={copyState === 'copied' ? '代码块已复制' : copyState === 'failed' ? '代码块复制失败' : '复制代码块'}
              title={copyState === 'copied'
                ? '已复制代码块'
                : copyState === 'failed'
                  ? '复制失败，请检查浏览器剪贴板权限'
                  : validationStatus === 'failed'
                    ? '复制代码块：该代码未通过验证，需人工复查'
                    : '复制代码块'}
              onClick={() => void handleCopy()}
            >
              {copyState === 'copied' ? <Check size={14} aria-hidden="true" /> : copyState === 'failed' ? <X size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
            <span className="srOnly" role="status" aria-live="polite">
              {copyState === 'copied' ? '代码块已复制。' : copyState === 'failed' ? '代码块复制失败，请检查浏览器剪贴板权限。' : ''}
            </span>
          </span>
        </figcaption>
        <pre><code>{code}</code></pre>
      </figure>
      {modal}
    </>
  );
}

function teacherCodeBlockValidationStatus(validation?: AiTeacherCodeBlockValidation): 'passed' | 'failed' | 'pending' {
  const status = String(validation?.status || '').toLowerCase();
  if (status === 'validated_passed' || status === 'passed') return 'passed';
  if (status === 'validated_failed' || status === 'failed') return 'failed';
  return 'pending';
}

function teacherCodeBlockValidationLabel(validation?: AiTeacherCodeBlockValidation): string {
  const status = teacherCodeBlockValidationStatus(validation);
  if (status === 'passed') {
    const attempts = Number(validation?.attempts || 1);
    return attempts > 1 ? `已验证通过 · ${attempts}轮` : '已验证通过';
  }
  if (status === 'failed') return validation?.manualReviewRequired ? '验证未通过 · 需人工复查' : '验证未通过';
  return '未自动验证';
}

function teacherCodeBlockValidationTitle(validation?: AiTeacherCodeBlockValidation): string {
  const label = teacherCodeBlockValidationLabel(validation);
  const message = sanitizeTeacherUiText(validation?.message || '');
  const firstDiagnostic = Array.isArray(validation?.diagnostics) ? validation.diagnostics.find((item) => item?.message)?.message : '';
  return [label, message, firstDiagnostic ? `首要诊断：${firstDiagnostic}` : ''].filter(Boolean).join('\n');
}

function friendlyTeacherError(error: unknown): string {
  const quotaMessage = quotaTeacherErrorMessage(error);
  if (quotaMessage) return quotaMessage;
  const message = sanitizeTeacherUiText(error instanceof Error ? error.message : error);
  if (/abort/i.test(message)) return '本轮回答已停止。';
  if (/timeout/i.test(message)) return 'AI 教师请求超时，请稍后重试或缩小上下文。';
  if (/provider|unavailable|503/i.test(message)) return 'AI 教师服务暂不可用，请稍后重试。';
  return message || 'AI 教师暂时不可用。';
}

function isActionableValidationFailure(message: string): boolean {
  return /经过 3 次修订仍未|AI_TEACHER_CANDIDATE_VALIDATION_INCOMPLETE/u.test(message);
}

function isQuotaTeacherError(error: unknown): boolean {
  return Boolean(quotaTeacherErrorMessage(error));
}

function quotaTeacherErrorMessage(error: unknown): string {
  const code = String(readUnknownErrorProperty(error, 'code') || '');
  const status = Number(readUnknownErrorProperty(error, 'status') || 0);
  const message = sanitizeTeacherUiText(error instanceof Error ? error.message : error);
  const payload = readUnknownErrorProperty(error, 'payload');
  const payloadMessage = sanitizeTeacherUiText(
    readUnknownErrorProperty(error, 'message')
    || readUnknownErrorProperty(payload, 'message')
    || readUnknownErrorProperty(payload, 'error')
  );
  const combined = `${code} ${status} ${message} ${payloadMessage}`;
  if (/daily_quota_exceeded|daily token quota exceeded|今日 AI Teacher tokens 已用完/i.test(combined)) return '今日 AI Teacher tokens 已用完，明日重置后可继续使用。';
  if (/weekly_quota_exceeded|weekly token quota exceeded|本周 AI Teacher tokens 已用完/i.test(combined)) return '本周 AI Teacher tokens 已用完，下周重置后可继续使用。';
  if (code === 'AI_TEACHER_QUOTA_EXCEEDED' || /AI_TEACHER_QUOTA_EXCEEDED/.test(combined)) return 'AI Teacher tokens 已用完，请等待额度重置后继续使用。';
  return '';
}

function readUnknownErrorProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || /abort/i.test(String(error instanceof Error ? error.message : error || ''));
}

async function copyText(value: string): Promise<void> {
  const text = String(value || '');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard API 可能因权限、焦点或安全上下文被拒绝，继续使用同步复制降级路径。
    }
  }

  const selection = window.getSelection();
  const previousRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const buffer = document.createElement('textarea');
  buffer.value = text;
  buffer.setAttribute('readonly', 'true');
  buffer.style.position = 'fixed';
  buffer.style.left = '-9999px';
  buffer.style.top = '0';
  document.body.appendChild(buffer);
  try {
    buffer.focus({ preventScroll: true });
    buffer.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard copy was rejected.');
  } finally {
    document.body.removeChild(buffer);
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    previousActiveElement?.focus({ preventScroll: true });
  }
}

export function manualContinuationQuestion(
  messages: ReadonlyArray<{ id?: string; role?: string; text?: string }>,
  targetMessageId?: string
): string {
  const targetIndex = targetMessageId
    ? messages.findIndex((message) => message.id === targetMessageId)
    : messages.length;
  const searchEnd = targetIndex >= 0 ? targetIndex : messages.length;
  for (let index = searchEnd - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = String(message?.text || '').trim();
    if (message?.role === 'user' && text && text !== MANUAL_CONTINUATION_DISPLAY_TEXT) {
      return text.slice(0, MANUAL_CONTINUATION_SOURCE_LIMIT);
    }
  }
  return '';
}

function teacherContextQuery(
  lesson?: Lesson | null,
  extra: Record<string, string | number> = {}
): string {
  const params = new URLSearchParams({
    courseId: lesson?.courseId || '',
    lessonId: lesson?.id || ''
  });
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params.toString();
}

function aiTeacherSessionKey(
  userId: string,
  coursePackId: string,
  lesson?: Lesson | null,
  workspace?: WorkspaceSnapshot,
  activeFilePath?: string
): string {
  const lessonKey = lesson?.id || lesson?.courseId || 'scratch';
  const fileKey = activeFilePath || workspace?.activeFilePath || workspace?.entryFile || workspace?.files?.[0]?.path || 'main.sysml';
  return [userId || 'signed-out', coursePackId || 'default-pack', lessonKey, fileKey]
    .map((part) => encodeURIComponent(String(part || '')))
    .join(':');
}

function aiTeacherThreadSessionKey(scopeSessionKey: string, threadId: string): string {
  return threadId
    ? `${scopeSessionKey}:thread:${encodeURIComponent(threadId)}`
    : `${scopeSessionKey}:thread:new`;
}

function getAiTeacherThreadSession(
  scopeSessionKey: string,
  threadId: string,
  defaultOpen: boolean
): AiTeacherPersistedSession {
  const session = getAiTeacherSession(aiTeacherThreadSessionKey(scopeSessionKey, threadId), defaultOpen);
  return threadId && !session.threadId ? { ...session, threadId } : session;
}

function getAiTeacherSession(sessionKey: string, defaultOpen: boolean): AiTeacherPersistedSession {
  const existing = aiTeacherSessions.get(sessionKey);
  if (existing) return cloneAiTeacherSession(existing);
  return {
    open: defaultOpen,
    question: '',
    status: DEFAULT_AI_TEACHER_STATUS,
    tone: 'idle',
    messages: [],
    threadId: readThreadId(sessionKey),
    dockWidth: DEFAULT_DOCK_WIDTH,
    running: false,
    activeRunId: '',
    activeRunEventSeq: 0,
    activeUserMessageId: '',
    activeProcessMessageId: '',
    activeAssistantMessageId: '',
    clarificationCheckpointId: ''
  };
}

function rememberAiTeacherSession(sessionKey: string, session: AiTeacherPersistedSession, originId = '') {
  const snapshot = cloneAiTeacherSession(session);
  aiTeacherSessions.set(sessionKey, snapshot);
  notifyAiTeacherSessionListeners(sessionKey, originId);
  scheduleAiTeacherSessionBroadcast(sessionKey, snapshot, originId);
}

function updateAiTeacherSession(
  sessionKey: string,
  updater: (session: AiTeacherPersistedSession) => AiTeacherPersistedSession,
  originId = ''
) {
  const current = getAiTeacherSession(sessionKey, false);
  rememberAiTeacherSession(sessionKey, updater(current), originId);
}

function subscribeAiTeacherSession(listener: (sessionKey: string, originId: string) => void): () => void {
  aiTeacherSessionListeners.add(listener);
  return () => {
    aiTeacherSessionListeners.delete(listener);
  };
}

function notifyAiTeacherSessionListeners(sessionKey: string, originId: string) {
  for (const listener of aiTeacherSessionListeners) listener(sessionKey, originId);
}

function createAiTeacherSessionChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(AI_TEACHER_SESSION_CHANNEL);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const payload = event.data;
    if (!payload || typeof payload !== 'object') return;
    const message = payload as { sessionKey?: unknown; originId?: unknown; session?: unknown };
    if (typeof message.sessionKey !== 'string' || !message.session || typeof message.session !== 'object') return;
    try {
      const snapshot = cloneAiTeacherSession(message.session as AiTeacherPersistedSession);
      aiTeacherSessions.set(message.sessionKey, snapshot);
      notifyAiTeacherSessionListeners(message.sessionKey, String(message.originId || 'external-tab'));
    } catch {
      // Ignore malformed same-origin channel messages; server run replay remains authoritative.
    }
  });
  return channel;
}

function scheduleAiTeacherSessionBroadcast(
  sessionKey: string,
  session: AiTeacherPersistedSession,
  originId: string
) {
  if (!aiTeacherSessionChannel || typeof window === 'undefined') return;
  const existingTimer = aiTeacherSessionBroadcastTimers.get(sessionKey);
  if (existingTimer) window.clearTimeout(existingTimer);
  const timer = window.setTimeout(() => {
    aiTeacherSessionBroadcastTimers.delete(sessionKey);
    const latest = aiTeacherSessions.get(sessionKey) || session;
    aiTeacherSessionChannel.postMessage({
      sessionKey,
      originId,
      session: cloneAiTeacherSession(latest)
    });
  }, 80);
  aiTeacherSessionBroadcastTimers.set(sessionKey, timer);
}

function cloneAiTeacherSession(session: AiTeacherPersistedSession): AiTeacherPersistedSession {
  return {
    open: session.open,
    question: session.question || '',
    status: session.status || DEFAULT_AI_TEACHER_STATUS,
    tone: session.tone || 'idle',
    threadId: session.threadId || '',
    dockWidth: session.dockWidth || DEFAULT_DOCK_WIDTH,
    running: Boolean(session.running),
    activeRunId: session.activeRunId || '',
    activeRunEventSeq: Number(session.activeRunEventSeq || 0),
    activeUserMessageId: session.activeUserMessageId || '',
    activeProcessMessageId: session.activeProcessMessageId || '',
    activeAssistantMessageId: session.activeAssistantMessageId || '',
    clarificationCheckpointId: session.clarificationCheckpointId || '',
    messages: session.messages.map((message) => ({ ...message }))
  };
}

function teacherThreadMessagesToPanelMessages(messages: TeacherThreadMessage[]): AiTeacherMessage[] {
  const ordered = orderTeacherConversationMessages(messages);
  const runStartedAtById = new Map<string, number>();
  let latestUserStartedAtMs = 0;
  return ordered.map((message, index) => {
    const messageTimestampMs = teacherTimestampMs(message.createdAt);
    if (message.role !== 'assistant' && messageTimestampMs) {
      latestUserStartedAtMs = messageTimestampMs;
      if (message.runId) runStartedAtById.set(message.runId, messageTimestampMs);
    }
    const response = message.role === 'assistant' ? message.response || undefined : undefined;
    const startedAtMs = message.role === 'assistant'
      ? runStartedAtById.get(String(message.runId || '')) || latestUserStartedAtMs
      : messageTimestampMs;
    return {
      id: message.messageId || `restored-${index}`,
      role: message.role === 'assistant' ? 'assistant' : 'user',
      title: message.role === 'assistant' ? response?.title || 'AI 教师' : '你',
      text: message.role === 'assistant' && response ? responseToText(response) : sanitizeTeacherUiText(message.content || ''),
      response,
      runId: message.runId,
      state: teacherThreadMessageState(message),
      startedAtMs: startedAtMs || undefined,
      completedAtMs: message.role === 'assistant' ? messageTimestampMs || undefined : undefined
    };
  });
}

function teacherTimestampMs(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function teacherThreadMessageState(message: TeacherThreadMessage): AiTeacherMessage['state'] {
  if (message.role !== 'user') return 'done';
  if (message.status === 'received') return 'working';
  if (message.status === 'cancelled') return 'cancelled';
  if (message.status === 'failed' || message.status === 'timed_out') return 'error';
  return 'done';
}

function latestWaitingClarificationCheckpoint(messages: TeacherThreadMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === 'assistant');
  if (latest?.response?.clarification?.status !== 'waiting') return '';
  return String(latest?.response?.clarification?.checkpointId || '');
}

function formatThreadUpdatedAt(value: string, locale: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
}

function forgetAiTeacherSessionThread(sessionKey: string, originId = '') {
  const existing = aiTeacherSessions.get(sessionKey);
  if (existing) {
    rememberAiTeacherSession(sessionKey, {
      ...existing,
      question: '',
      messages: [],
      threadId: '',
      status: '对话已清空。',
      tone: 'warn',
      running: false,
      activeRunId: '',
      activeRunEventSeq: 0,
      activeUserMessageId: '',
      activeProcessMessageId: '',
      activeAssistantMessageId: '',
      clarificationCheckpointId: ''
    }, originId);
  }
  try {
    localStorage.setItem(scopedThreadStorageKey(sessionKey), '');
  } catch {
    // Storage can be unavailable; in-memory state still clears immediately.
  }
}

function clearAiTeacherSessionThreadReference(sessionKey: string, originId = '') {
  const existing = aiTeacherSessions.get(sessionKey);
  if (existing) {
    rememberAiTeacherSession(sessionKey, {
      ...existing,
      threadId: ''
    }, originId);
  }
  try {
    localStorage.setItem(scopedThreadStorageKey(sessionKey), '');
  } catch {
    // Storage can be unavailable; the in-memory ownership boundary still applies.
  }
}

function purgeAiTeacherSessionsForOtherUsers(currentUserId: string) {
  const currentUserPrefix = `${encodeURIComponent(currentUserId || 'signed-out')}:`;
  for (const sessionKey of aiTeacherSessions.keys()) {
    if (!sessionKey.startsWith(currentUserPrefix)) aiTeacherSessions.delete(sessionKey);
  }
}

function scopedThreadStorageKey(sessionKey: string): string {
  return `${SCOPED_THREAD_STORAGE_PREFIX}${sessionKey}`;
}

function readThreadId(sessionKey: string): string {
  try {
    return localStorage.getItem(scopedThreadStorageKey(sessionKey)) || '';
  } catch {
    return '';
  }
}

function isThreadOwnerMismatch(error: unknown): boolean {
  const code = String(readUnknownErrorProperty(error, 'code') || '');
  const payload = readUnknownErrorProperty(error, 'payload');
  const combined = [
    code,
    error instanceof Error ? error.message : error,
    readUnknownErrorProperty(payload, 'code'),
    readUnknownErrorProperty(payload, 'error')
  ].map((value) => String(value || '')).join(' ');
  return /AI_TEACHER_THREAD_OWNER_MISMATCH|thread belongs to another user/i.test(combined);
}
