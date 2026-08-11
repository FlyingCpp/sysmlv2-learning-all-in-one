import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Archive, ArrowDown, ArrowUp, Bot, Boxes, ExternalLink, Gauge, Info, KeyRound, MessageSquare, Network, RotateCcw, Settings2, SlidersHorizontal, Trash2, Upload, UsersRound } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAppApiClient } from '../../app/use-api-client';
import { useSessionStore } from '../../app/session-store';
import type { CoursePack, UserProfile } from '../../lib/course/types';
import { ErrorState, LoadingState } from '../shared/ui';
import { AgentResourcePolicyTab } from './AgentResourcePolicyTab';
import { AiTeacherModelAccessWorkbench } from './AiTeacherModelAccessWorkbench';

type AdminUser = UserProfile & {
  status?: string;
  createdAt?: string;
  lastLoginAt?: string;
  lastActivityAt?: string;
  activeDurationSeconds?: number;
};

type AdminUsersResponse = {
  total: number;
  users: AdminUser[];
};

type AdminUserSortKey = 'user' | 'createdAt' | 'lastLoginAt' | 'activeDurationSeconds' | 'tier' | 'status';
type SortDirection = 'ascending' | 'descending';

type AdminUserSort = {
  key: AdminUserSortKey;
  direction: SortDirection;
};

type AuthSettingsResponse = {
  settings: {
    registrationEnabled: boolean;
    guestLoginEnabled: boolean;
    updatedBy?: string;
    updatedAt?: string;
  };
};

type AdminCoursePacksResponse = {
  activeCoursePackId?: string;
  packs: Array<CoursePack & {
    status?: string;
    source?: string;
    uploadedAt?: string;
    archivedAt?: string;
    lineageId?: string;
    dataNamespaceId?: string;
    originalName?: string;
    versionCount?: number;
    versions?: Array<{
      version?: string;
      uploadedAt?: string;
      originalName?: string;
      contentVersionId?: string;
      contentHash?: string;
      lineageId?: string;
    }>;
  }>;
};

type PendingUpload = {
  pendingUploadId: string;
  uploadedAt?: string;
  originalName?: string;
  packSummary?: {
    id?: string;
    title?: string;
    version?: string;
    description?: string;
  };
  identity?: {
    schemaVersion?: string;
    coursePackId?: string;
    lineageId?: string;
    issuedAt?: string;
    issuedBy?: string;
    hasToken?: boolean;
    invalid?: boolean;
  } | null;
  contentHashShort?: string;
  decision?: {
    type?: string;
    reason?: string;
    matchedBy?: string;
    identityStatus?: string;
    willAssociateStudentData?: boolean;
    targetStatus?: string;
    lineageId?: string;
    dataNamespaceId?: string;
  };
  availableActions?: string[];
};

type PendingUploadsResponse = {
  pendingUploads: PendingUpload[];
};

type PageSize = 5 | 10 | 25;

type AiTeacherRuntimeResponse = {
  enabled: boolean;
  gateway?: string;
  providerMode?: string;
  modelGroup?: string;
  teacher?: {
    url?: string;
    status?: string;
    error?: string;
    provider?: {
      mode?: string;
      enabled?: boolean;
      gateway?: string;
      reason?: string;
    };
  };
  litellm?: {
    configured?: boolean;
    baseUrl?: string;
    status?: string;
  };
  limits?: {
    teacherTimeoutMs?: number;
  };
};

type AiTeacherTierPoliciesResponse = {
  resetPolicy: {
    weekStartAt?: string;
    weekEndAt?: string;
    nextWeeklyResetAt?: string;
    timezone?: string;
  };
  policies: Record<string, {
    enabled: boolean;
    dailyTokenLimit: number;
    weeklyTokenLimit: number;
  }>;
};

type AiTeacherTierPolicyDraft = {
  enabled: boolean;
  dailyTokenLimit: number;
  weeklyTokenLimit: number;
};

type AiTeacherProviderStatusResponse = {
  generatedAt: string;
  refreshAfterMs: number;
  sync?: {
    intervalMs: number;
    manualCooldownMs: number;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastCompletedAt?: string;
    nextScheduledAt?: string;
    lastTrigger?: string;
    lastOutcome?: string;
    errorCode?: string;
    inProgress: boolean;
  } | null;
  gateway: {
    status: string;
    source: string;
    configured: boolean;
    baseUrl?: string;
    httpStatus?: number;
  };
  capabilities: Array<{
    id: string;
    name: string;
    status: string;
    enabled: boolean;
    canEnable: boolean;
    configured: boolean;
    ready: boolean;
    reason?: string;
    source: string;
    checkedAt?: string;
    warningCode?: string;
    verificationStatus?: string;
    startupEnabled?: boolean;
    controlSource?: string;
    controlUpdatedAt?: string;
    probe?: {
      policyEnabled: boolean;
      status: string;
      inProgress: boolean;
      attemptCount: number;
      cooldownScheduleSeconds: number[];
      resetAfterSeconds: number;
      hourlyLimit: number;
      remainingHourlyAttempts: number;
      lastAttemptAt?: string;
      lastCheckedAt?: string;
      nextAllowedAt?: string;
      retryAfterMs: number;
      warningCode?: string;
      durationMs: number;
      sourceCount: number;
      searchRequestCount: number;
      lastTrigger?: string;
    };
  }>;
  providers: Array<{
    id: string;
    name: string;
    status: string;
    phase?: string;
    officialStatusUrl?: string;
    subscriptionAvailable: boolean;
    subscriptionChannels: string[];
    sourceFreshness: string;
    sourceCheckedAt?: string;
    errorCode?: string;
    note?: string;
    latestIncident?: {
      title: string;
      detail?: string;
      updatedAt?: string;
      url?: string;
    } | null;
  }>;
};

type AiTeacherUsageSummaryResponse = {
  userCount: number;
  messageCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  dailyTokens: number;
  weeklyTokens: number;
  quotaDeniedCount: number;
  nextWeeklyResetAt?: string;
};

type AiTeacherLiteLlmUsageSummaryResponse = {
  configured: boolean;
  status: string;
  source: string;
  path?: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  spend: number;
  currency?: string;
  error?: string;
};

type AiTeacherUsageUsersResponse = {
  users: AiTeacherUsageUserRow[];
};

type AiTeacherUsageUserRow = {
  user: Pick<AdminUser, 'id' | 'email' | 'displayName' | 'tier' | 'status'>;
  usage: {
    messageCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    dailyTokens: number;
    weeklyTokens: number;
    tokenQuota: {
      enabled: boolean;
      dailyTokenLimit: number;
      weeklyTokenLimit: number;
      dailyRemainingTokens: number | null;
      weeklyRemainingTokens: number | null;
      nextWeeklyResetAt?: string;
    };
  };
};

type AiTeacherQuotaEventsResponse = {
  events: Array<{
    id?: number;
    userId?: string;
    requestId?: string;
    capability?: string;
    decision?: string;
    reason?: string;
    dailyUsedTokens?: number;
    weeklyUsedTokens?: number;
    dailyLimitTokens?: number;
    weeklyLimitTokens?: number;
    createdAt?: string;
  }>;
};

type AiTeacherConversationsResponse = {
  conversations: AiTeacherConversation[];
};

type AiTeacherConversation = {
  threadId: string;
  user: Pick<AdminUser, 'id' | 'email' | 'displayName' | 'tier'>;
  lessonId?: string;
  title?: string;
  lastUserMessage?: string;
  messageCount?: number;
  totalTokens?: number;
  createdAt?: string;
  updatedAt?: string;
};

type AiTeacherConversationMessagesResponse = {
  messages: Array<{
    id: string;
    threadId: string;
    role: string;
    contentPreview: string;
    contentLength: number;
    model?: string;
    tokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
    };
    createdAt?: string;
  }>;
};

type AiTeacherFailureObservabilityResponse = {
  generatedAt: string;
  windowHours: number;
  refreshAfterMs: number;
  observationEnabled: boolean;
  status: 'healthy' | 'degraded' | 'incident' | 'unavailable';
  summary: {
    totalTerminalRuns: number;
    frontendResultReturned: number;
    complete: number;
    degraded: number;
    failed: number;
    timedOut: number;
    cancelled: number;
    frontendDeliveryRate: number;
    degradationRate: number;
  };
  reasonCounts: Array<{ reasonCode: string; count: number }>;
  recent: Array<{
    runId: string;
    requestId: string;
    status: string;
    frontendResultReturned: boolean;
    answerCompletionStatus: string;
    stopReason: string;
    validatorStatus: string;
    reasonCodes: string[];
    createdAt?: string;
  }>;
};

type AiTeacherAdminTab = 'status' | 'models' | 'resources' | 'policies' | 'usage' | 'logs';

const AI_TEACHER_ADMIN_REFRESH_MS = 60_000;

export function AdminPage() {
  const user = useSessionStore((state) => state.user);
  const canManageUsers = hasUserAdminAccess(user);
  const canManagePacks = hasCoursePackManage(user);
  const canAdmin = canManageUsers || canManagePacks;

  if (!canAdmin) {
    return (
      <section className="adminPage" data-admin-page data-admin-locked>
        <div className="phase4Hero">
          <span className="missionEyebrow">Admin Console</span>
          <h2>需要管理员权限</h2>
          <p>当前账号没有管理后台权限。请联系管理员开通 admin.console.access 权限。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="adminPage" data-admin-page>
      <div className="phase4Hero">
        <span className="missionEyebrow">Admin Console</span>
        <h2>平台管理后台</h2>
        <p>统一管理账号运营、内容生命周期、AI Teacher 与外部建模工具接入状态。</p>
        <AdminSectionNav canManageUsers={canManageUsers} canManagePacks={canManagePacks} active="users" />
      </div>
      {canManageUsers ? (
        <AdminUsersPanel />
      ) : (
        <section className="adminPanel" data-admin-users-locked>
          <header className="sectionHeader">
            <div>
              <span className="missionEyebrow">Users</span>
              <h2>账号运营</h2>
            </div>
          </header>
          <p className="muted">当前账号没有 admin.console.access 权限，账号运营接口不会被调用。</p>
        </section>
      )}
    </section>
  );
}

export function CoursePackAdminPage() {
  const user = useSessionStore((state) => state.user);
  const canManageUsers = hasUserAdminAccess(user);
  if (!hasCoursePackManage(user)) {
    return (
      <section className="adminPage" data-course-pack-admin data-admin-locked>
        <div className="phase4Hero">
          <span className="missionEyebrow">Course Pack Admin</span>
          <h2>需要课程包管理权限</h2>
          <p>当前账号没有 course.pack.manage 权限。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="adminPage" data-course-pack-admin>
      <div className="phase4Hero">
        <span className="missionEyebrow">Course Pack Admin</span>
        <h2>课程包管理</h2>
        <p>课程包独立于平台代码。上传包先进入 preview/pending 流程，系统会识别同一课程、旧课程恢复和身份冲突；确认后以停用状态加载，只有启用课程包会出现在学习端 Gallery。</p>
        <AdminSectionNav canManageUsers={canManageUsers} canManagePacks active="packs" />
      </div>
      <CoursePackAdminPanel />
    </section>
  );
}

export function AiTeacherAdminPage() {
  const user = useSessionStore((state) => state.user);
  const canManageUsers = hasUserAdminAccess(user);
  const canManagePacks = hasCoursePackManage(user);
  const [activeTab, setActiveTab] = useState<AiTeacherAdminTab>('status');
  if (!canManageUsers) {
    return (
      <section className="adminPage" data-ai-teacher-admin data-admin-locked>
        <div className="phase4Hero">
          <span className="missionEyebrow">AI Teacher Admin</span>
          <h2>需要管理员权限</h2>
          <p>当前账号没有 admin.console.access 权限，无法查看 AI Teacher 运行、用量和对话日志。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="adminPage aiTeacherAdminPage" data-ai-teacher-admin>
      <div className="phase4Hero" data-ai-teacher-admin-hero>
        <span className="missionEyebrow">AI Teacher Admin</span>
        <h2>AI Teacher 管理</h2>
        <p>统一查看模型接入、日/周 token 策略、用户用量和学生对话日志。配额控制以平台 ledger 为准，LiteLLM 用于 provider 侧代理与对账。</p>
        <AdminSectionNav canManageUsers={canManageUsers} canManagePacks={canManagePacks} active="ai-teacher" />
      </div>
      <AiTeacherAdminPanel activeTab={activeTab} onActiveTabChange={setActiveTab} />
    </section>
  );
}

export function AdminSectionNav({ active, canManagePacks, canManageUsers }: { active: 'users' | 'packs' | 'knowledge-packs' | 'ai-teacher' | 'external-modeling-tools'; canManagePacks: boolean; canManageUsers: boolean }) {
  return (
    <nav className="phase4Checklist adminSectionNav" aria-label="管理后台分区">
      {canManageUsers ? (
        <Link className={active === 'users' ? 'isActive' : ''} to="/admin" data-admin-section-link="users">
          <UsersRound size={14} />账号运营
        </Link>
      ) : null}
      {canManagePacks ? (
        <Link className={active === 'packs' ? 'isActive' : ''} to="/admin/course-packs" data-admin-section-link="course-packs">
          <Boxes size={14} />课程包管理
        </Link>
      ) : null}
      {canManagePacks ? (
        <Link className={active === 'knowledge-packs' ? 'isActive' : ''} to="/admin/knowledge-packs" data-admin-section-link="knowledge-packs">
          <Network size={14} />知识包管理
        </Link>
      ) : null}
      {canManageUsers ? (
        <Link className={active === 'ai-teacher' ? 'isActive' : ''} to="/admin/ai-teacher" data-admin-section-link="ai-teacher">
          <Bot size={14} />AI Teacher 管理
        </Link>
      ) : null}
      {canManageUsers ? (
        <Link className={active === 'external-modeling-tools' ? 'isActive' : ''} to="/admin/external-modeling-tools" data-admin-section-link="external-modeling-tools">
          <Network size={14} />外部建模工具接入
        </Link>
      ) : null}
    </nav>
  );
}

function AiTeacherAdminPanel({ activeTab, onActiveTabChange }: {
  activeTab: AiTeacherAdminTab;
  onActiveTabChange: (tab: AiTeacherAdminTab) => void;
}) {
  const api = useAppApiClient();
  const runtimeQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'runtime'],
    queryFn: () => api.request<AiTeacherRuntimeResponse>('/api/admin/ai-teacher/runtime'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const policiesQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'tier-policies'],
    queryFn: () => api.request<AiTeacherTierPoliciesResponse>('/api/admin/ai-teacher/tier-policies'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const summaryQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'usage', 'summary'],
    queryFn: () => api.request<AiTeacherUsageSummaryResponse>('/api/admin/ai-teacher/usage/summary'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });

  if (runtimeQuery.isLoading || policiesQuery.isLoading || summaryQuery.isLoading) return <LoadingState label="正在加载 AI Teacher 管理数据" />;
  if (runtimeQuery.error) return <ErrorState title="AI Teacher 运行状态加载失败" error={runtimeQuery.error} />;
  if (policiesQuery.error) return <ErrorState title="AI Teacher 等级策略加载失败" error={policiesQuery.error} />;
  if (summaryQuery.error) return <ErrorState title="AI Teacher 用量摘要加载失败" error={summaryQuery.error} />;

  const runtime = runtimeQuery.data;
  const policies = policiesQuery.data;
  const summary = summaryQuery.data;

  return (
    <div className="adminGrid aiTeacherAdminGrid">
      {activeTab !== 'resources' ? <section className="adminPanel aiTeacherStatusPanel" data-ai-teacher-admin-summary>
        <header className="sectionHeader">
          <div>
            <span className="missionEyebrow">Overview</span>
            <h2>运行摘要</h2>
          </div>
        </header>
        <div className="adminLifecycleSummary aiTeacherMetricGrid" aria-label="AI Teacher 运行摘要">
          <span><strong>{runtime?.gateway || 'unknown'}</strong> Gateway</span>
          <span><strong>{runtime?.teacher?.status || 'unknown'}</strong> Teacher</span>
          <span><strong>{formatNumber(summary?.dailyTokens)}</strong> 今日 tokens</span>
          <span><strong>{formatNumber(summary?.weeklyTokens)}</strong> 本周 tokens</span>
          <span><strong>{formatNumber(summary?.quotaDeniedCount)}</strong> Quota 拦截</span>
          <span><strong>{formatDateTime(summary?.nextWeeklyResetAt || policies?.resetPolicy?.nextWeeklyResetAt || '')}</strong> 周重置</span>
        </div>
      </section> : null}

      <nav className="phase4Checklist aiTeacherAdminTabs" aria-label="AI Teacher 管理视图">
        <button type="button" className={activeTab === 'status' ? 'isActive' : ''} onClick={() => onActiveTabChange('status')} data-ai-teacher-admin-tab="status">
          <Activity size={14} />模型状态
        </button>
        <button type="button" className={activeTab === 'models' ? 'isActive' : ''} onClick={() => onActiveTabChange('models')} data-ai-teacher-admin-tab="models">
          <KeyRound size={14} />模型接入
        </button>
        <button type="button" className={activeTab === 'resources' ? 'isActive' : ''} onClick={() => onActiveTabChange('resources')} data-ai-teacher-admin-tab="resources">
          <Settings2 size={14} />资源门禁
        </button>
        <button type="button" className={activeTab === 'policies' ? 'isActive' : ''} onClick={() => onActiveTabChange('policies')} data-ai-teacher-admin-tab="policies">
          <SlidersHorizontal size={14} />等级限额
        </button>
        <button type="button" className={activeTab === 'usage' ? 'isActive' : ''} onClick={() => onActiveTabChange('usage')} data-ai-teacher-admin-tab="usage">
          <Gauge size={14} />用量监控
        </button>
        <button type="button" className={activeTab === 'logs' ? 'isActive' : ''} onClick={() => onActiveTabChange('logs')} data-ai-teacher-admin-tab="logs">
          <MessageSquare size={14} />对话日志
        </button>
      </nav>

      {activeTab === 'status' ? <AiTeacherProviderStatusTab /> : null}
      {activeTab === 'models' ? <AiTeacherModelAccessWorkbench onOpenResourcePolicy={() => onActiveTabChange('resources')} /> : null}
      {activeTab === 'resources' ? <AgentResourcePolicyTab /> : null}
      {activeTab === 'policies' ? <AiTeacherTierPolicyTab policies={policies} /> : null}
      {activeTab === 'usage' ? <AiTeacherUsageTab /> : null}
      {activeTab === 'logs' ? <AiTeacherLogsTab /> : null}
    </div>
  );
}

function AiTeacherProviderStatusTab() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const [clockNow, setClockNow] = useState(() => Date.now());
  const statusQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'provider-status'],
    queryFn: () => api.request<AiTeacherProviderStatusResponse>('/api/admin/ai-teacher/provider-status'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const refreshMutation = useMutation({
    mutationFn: () => api.request<AiTeacherProviderStatusResponse>('/api/admin/ai-teacher/provider-status/refresh', {
      method: 'POST',
      body: {}
    }),
    onSuccess: (snapshot) => queryClient.setQueryData(['admin', 'ai-teacher', 'provider-status'], snapshot)
  });
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const webSearchEnableMutation = useMutation({
    mutationFn: () => api.request<AiTeacherProviderStatusResponse>('/api/admin/ai-teacher/domain-web-search', {
      method: 'PATCH',
      body: { enabled: true }
    }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['admin', 'ai-teacher', 'provider-status'] });
      const previous = queryClient.getQueryData<AiTeacherProviderStatusResponse>(['admin', 'ai-teacher', 'provider-status']);
      if (previous) {
        queryClient.setQueryData<AiTeacherProviderStatusResponse>(['admin', 'ai-teacher', 'provider-status'], {
          ...previous,
          capabilities: previous.capabilities.map((capability) => capability.id === 'deepseek-web-search'
            ? {
                ...capability,
                enabled: true,
                ready: false,
                verificationStatus: 'not_checked',
                probe: {
                  ...(capability.probe || emptyWebSearchProbeState()),
                  status: 'running',
                  inProgress: true
                }
              }
            : capability)
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['admin', 'ai-teacher', 'provider-status'], context.previous);
    },
    onSuccess: (snapshot) => queryClient.setQueryData(['admin', 'ai-teacher', 'provider-status'], snapshot)
  });
  const webSearchDisableMutation = useMutation({
    mutationFn: () => api.request<AiTeacherProviderStatusResponse>('/api/admin/ai-teacher/domain-web-search', {
      method: 'PATCH',
      body: { enabled: false }
    }),
    onSuccess: (snapshot) => queryClient.setQueryData(['admin', 'ai-teacher', 'provider-status'], snapshot)
  });
  const webSearchProbeMutation = useMutation({
    mutationFn: () => api.request<AiTeacherProviderStatusResponse>('/api/admin/ai-teacher/domain-web-search/probe', {
      method: 'POST',
      body: {}
    }),
    onSuccess: (snapshot) => queryClient.setQueryData(['admin', 'ai-teacher', 'provider-status'], snapshot)
  });

  if (statusQuery.isLoading) return <LoadingState label="正在加载模型服务状态" />;
  if (statusQuery.error) return <ErrorState title="模型服务状态加载失败" error={statusQuery.error} />;

  const snapshot = statusQuery.data;
  const capabilities = snapshot?.capabilities || [];
  const providers = snapshot?.providers || [];
  const sync = snapshot?.sync;
  const webSearchCapability = capabilities.find((capability) => capability.id === 'deepseek-web-search');
  const deepSeekProvider = providers.find((provider) => provider.id === 'deepseek');
  const webSearchEnabled = webSearchCapability?.enabled === true;
  const staleCount = providers.filter((provider) => provider.sourceFreshness === 'stale' || provider.sourceFreshness === 'unavailable').length;

  return (
    <section className="adminPanel aiTeacherProviderStatusPanel" data-ai-teacher-provider-status>
      <header className="sectionHeader">
        <div>
          <span className="missionEyebrow">Provider Observability</span>
          <h2>模型服务状态</h2>
          <p className="muted">同时查看 LiteLLM Gateway、Teacher 业务能力实测与厂商官方公告。厂商显示正常不代表当前账号、模型和具体工具一定可用。</p>
        </div>
        <div className="aiTeacherProviderHeaderActions">
          <span className="muted">官方快照 {formatDateTime(snapshot?.generatedAt || '')}</span>
          <button
            type="button"
            className="adminInlineAction"
            data-provider-status-refresh
            disabled={refreshMutation.isPending || sync?.inProgress}
            onClick={() => refreshMutation.mutate()}
          >
            <RotateCcw size={14} className={refreshMutation.isPending ? 'isSpinning' : ''} aria-hidden="true" />
            {refreshMutation.isPending ? '正在刷新' : '刷新官方状态'}
          </button>
        </div>
      </header>

      <div className="adminLifecycleSummary aiTeacherProviderMetricGrid" aria-label="模型服务状态摘要">
        <span><strong>{statusLabel(snapshot?.gateway?.status || 'unknown')}</strong>LiteLLM Gateway</span>
        <span className="aiTeacherStateLampCard" data-state={deepSeekProvider?.status || 'unknown'} data-deepseek-official-indicator>
          <i aria-hidden="true" />
          <strong>{statusLabel(deepSeekProvider?.status || 'unknown')}</strong>
          DeepSeek 官方服务
        </span>
        <span className="aiTeacherStateLampCard" data-state={webSearchEnabled ? 'enabled' : 'disabled'} data-web-search-switch-indicator>
          <i aria-hidden="true" />
          <strong>{webSearchEnabled ? '已开启' : '已关闭'}</strong>
          AI Teacher 搜索开关
        </span>
        <span><strong>{staleCount}</strong>过期或不可读状态源</span>
      </div>

      <p className="aiTeacherConfigNote">
        LiteLLM 存活只证明代理进程可访问；“DeepSeek 官方服务”与“AI Teacher 搜索开关”是两条独立状态。点击“开启并验证”会执行一次受冷却保护的最小付费搜索；官方公告仍由服务端每 10 分钟独立同步，“刷新官方状态”不会触发付费验证。
      </p>

      <div className="aiTeacherProviderSyncMeta" aria-label="官方状态订阅同步信息">
        <span><strong>最后尝试</strong>{formatDateTime(sync?.lastAttemptAt || '')}</span>
        <span><strong>最后成功</strong>{formatDateTime(sync?.lastSuccessAt || '')}</span>
        <span><strong>下次定时</strong>{formatDateTime(sync?.nextScheduledAt || '')}</span>
        <span><strong>官方订阅触发 / 结果</strong>{syncTriggerLabel(sync?.lastTrigger)} / {syncOutcomeLabel(sync?.lastOutcome)}</span>
      </div>
      {refreshMutation.error ? (
        <p className="aiTeacherProviderRefreshError" role="alert">{refreshMutation.error instanceof Error ? refreshMutation.error.message : '手动刷新失败，请稍后重试。'}</p>
      ) : null}
      {webSearchEnableMutation.error || webSearchDisableMutation.error || webSearchProbeMutation.error ? (
        <p className="aiTeacherProviderRefreshError" role="alert">
          {webSearchControlError(webSearchEnableMutation.error || webSearchDisableMutation.error || webSearchProbeMutation.error)}
        </p>
      ) : null}

      <div className="adminTableWrap">
        <table className="adminDataTable aiTeacherProviderTable aiTeacherRuntimeStatusTable">
          <thead>
            <tr>
              <th scope="col">服务层</th>
              <th scope="col">状态</th>
              <th scope="col">最近检查</th>
              <th scope="col">说明</th>
              <th scope="col">控制</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>LiteLLM Gateway</strong><span>{snapshot?.gateway?.baseUrl || 'not configured'}</span></td>
              <td><StatusPill status={snapshot?.gateway?.status || 'unknown'} /></td>
              <td>{snapshot?.gateway?.httpStatus ? `HTTP ${snapshot.gateway.httpStatus}` : '-'}</td>
              <td>来源：{snapshot?.gateway?.source || 'litellm_liveliness'}。只检查 Gateway 存活，不代表上游模型或搜索工具正常。</td>
              <td>-</td>
            </tr>
            {capabilities.map((capability) => {
              const display = webSearchCapabilityDisplay(capability);
              const cooldownSeconds = webSearchProbeCooldownSeconds(capability.probe, clockNow);
              const probeBusy = capability.probe?.inProgress === true || webSearchProbeMutation.isPending;
              return (
                <tr key={capability.id}>
                  <td><strong>{capability.name}</strong><span>{capability.source}</span></td>
                  <td><StatusPill status={display.status} label={display.label} /></td>
                  <td>{formatDateTime(capability.checkedAt || '')}</td>
                  <td>{display.description}</td>
                  <td>
                    <div className="aiTeacherWebSearchRowActions">
                      {capability.enabled ? (
                        <>
                          <button
                            type="button"
                            className="aiTeacherWebSearchRowAction"
                            data-ai-teacher-web-search-probe
                            disabled={probeBusy || cooldownSeconds > 0 || capability.probe?.policyEnabled === false}
                            onClick={() => webSearchProbeMutation.mutate()}
                          >
                            {probeBusy ? '验证中' : '重新验证'}
                          </button>
                          <button
                            type="button"
                            className="aiTeacherWebSearchRowAction isDisable"
                            data-ai-teacher-web-search-control
                            data-state="enabled"
                            aria-pressed="true"
                            disabled={webSearchDisableMutation.isPending}
                            onClick={() => webSearchDisableMutation.mutate()}
                          >
                            {webSearchDisableMutation.isPending ? '关闭中' : '关闭搜索'}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="aiTeacherWebSearchRowAction"
                          data-ai-teacher-web-search-control
                          data-state="disabled"
                          aria-pressed="false"
                          disabled={webSearchEnableMutation.isPending || capability.canEnable === false}
                          onClick={() => webSearchEnableMutation.mutate()}
                        >
                          {webSearchEnableMutation.isPending
                            ? '开启并验证中'
                            : capability.probe?.policyEnabled === false ? '开启搜索' : '开启并验证'}
                        </button>
                      )}
                    </div>
                    <span className="aiTeacherRuntimeDefaultHint">
                      {webSearchProbeControlHint(capability, cooldownSeconds)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="adminTableWrap">
        <table className="adminDataTable aiTeacherProviderTable" data-provider-bulletin-table>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">官方公告</th>
              <th scope="col">订阅</th>
              <th scope="col">最新事件</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id} data-provider-status={provider.status}>
                <td>
                  <strong>{provider.name}</strong>
                  <span>{provider.officialStatusUrl ? (
                    <a href={provider.officialStatusUrl} target="_blank" rel="noreferrer">官方状态页 <ExternalLink size={12} aria-hidden="true" /></a>
                  ) : '未发现公开官方状态页'}</span>
                </td>
                <td><StatusPill status={provider.status} /><span>{provider.phase ? `阶段：${provider.phase}` : statusLabel(provider.sourceFreshness)}</span></td>
                <td>
                  <strong>{provider.subscriptionAvailable ? provider.subscriptionChannels.join(' / ') : '不可用'}</strong>
                  <span>{statusLabel(provider.sourceFreshness)}{provider.sourceCheckedAt ? ` · ${formatDateTime(provider.sourceCheckedAt)}` : ''}{provider.errorCode ? ` · ${provider.errorCode}` : ''}</span>
                </td>
                <td>
                  <strong>{provider.latestIncident?.title || provider.note || '暂无可验证事件'}</strong>
                  <span>{formatDateTime(provider.latestIncident?.updatedAt || '')}</span>
                  {provider.latestIncident?.url ? (
                    <a href={provider.latestIncident.url} target="_blank" rel="noreferrer">查看官方事件 <ExternalLink size={12} aria-hidden="true" /></a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* Legacy schema-v1 model-access form retained temporarily for migration reference.
function AiTeacherModelAccessTab({ runtime }: { runtime?: AiTeacherRuntimeResponse }) {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const provider = runtime?.teacher?.provider || {};
  const activeQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'litellm', 'active'],
    queryFn: () => api.request<AiTeacherLiteLlmActiveResponse>('/api/admin/ai-teacher/litellm/config-versions/active'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const healthQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'litellm', 'health'],
    queryFn: () => api.request<AiTeacherLiteLlmHealthResponse>('/api/admin/ai-teacher/litellm/health'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const [form, setForm] = useState<AiTeacherModelAccessForm>(() => modelAccessFormFromVersion());
  const [publishResult, setPublishResult] = useState<AiTeacherLiteLlmPublishResponse | null>(null);

  useEffect(() => {
    if (activeQuery.data?.version) setForm(modelAccessFormFromVersion(activeQuery.data.version));
  }, [activeQuery.data?.version]);

  const publishMutation = useMutation({
    mutationFn: async (draft: AiTeacherModelAccessForm) => {
      const created = await api.request<AiTeacherLiteLlmActiveResponse>('/api/admin/ai-teacher/litellm/config-versions', {
        method: 'POST',
        body: {
          notes: draft.notes,
          config: modelAccessConfigFromForm(draft)
        }
      });
      return api.request<AiTeacherLiteLlmPublishResponse>(
        `/api/admin/ai-teacher/litellm/config-versions/${encodeURIComponent(created.version.versionId)}/publish`,
        { method: 'POST' }
      );
    },
    onSuccess: (result) => {
      setPublishResult(result);
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher'] });
    }
  });

  const updateField = <K extends keyof AiTeacherModelAccessForm>(key: K, value: AiTeacherModelAccessForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="adminPanel" data-ai-teacher-models>
      <header className="sectionHeader">
        <div>
          <span className="missionEyebrow">Model Gateway</span>
          <h2>模型接入管理</h2>
          <p className="muted">配置模型组、环境变量密钥引用和 provider 侧 RPM/TPM；发布后写入业务库并尝试通知 LiteLLM 管理接口。</p>
        </div>
      </header>
      <form className="aiTeacherConfigForm" onSubmit={(event) => {
        event.preventDefault();
        publishMutation.mutate(form);
      }}>
        <p className="aiTeacherConfigNote">
          真正的 LLM 服务 URL 不直接写在页面里。这里填写环境变量名，例如 <strong>DEEPSEEK_API_BASE</strong>；真实值在 Docker/.env 或运行环境中设置，发布前会通过下方 Env 就绪检查确认。
        </p>
        <div className="aiTeacherFormGrid">
          <label>
            <span>模型组 <HelpTip text="业务侧调用的统一模型名。Teacher 固定请求这个模型组，LiteLLM 在组内选择具体部署。" /></span>
            <input value={form.modelName} onChange={(event) => updateField('modelName', event.target.value)} />
          </label>
          <label>
            <span>部署 ID <HelpTip text="LiteLLM 配置中的单个 provider 部署标识。以后接入多个 key 或多个模型时用它区分。" /></span>
            <input value={form.deploymentId} onChange={(event) => updateField('deploymentId', event.target.value)} />
          </label>
          <label>
            <span>Provider <HelpTip text="LiteLLM provider 类型。DeepSeek 模型组使用 deepseek，让 LiteLLM 按 DeepSeek 适配 reasoning/content 字段。" /></span>
            <input value={form.provider} onChange={(event) => updateField('provider', event.target.value)} />
          </label>
          <label>
            <span>模型名 <HelpTip text="发送给 LiteLLM/provider 的实际模型标识，例如 deepseek/deepseek-v4-flash。模型组不等于实际模型名。" /></span>
            <input value={form.model} onChange={(event) => updateField('model', event.target.value)} />
          </label>
          <label>
            <span>API Base Env <HelpTip text="真实 LLM 服务 URL 所在的环境变量名，不是 URL 本身。例如 DEEPSEEK_API_BASE=https://api.deepseek.com。" /></span>
            <input value={form.apiBaseEnv} onChange={(event) => updateField('apiBaseEnv', event.target.value)} />
          </label>
          <label>
            <span>API Key Env <HelpTip text="真实 API Key 所在的环境变量名。页面只保存引用并显示脱敏状态，不保存或展示明文 key。" /></span>
            <input value={form.apiKeyRef} onChange={(event) => updateField('apiKeyRef', event.target.value)} />
          </label>
          <label>
            <span>RPM <HelpTip text="provider 侧每分钟请求数上限。0 表示不在该配置项上设置上限。" /></span>
            <input type="number" min={0} value={form.rpm} onChange={(event) => updateField('rpm', numberFromInput(event.target.value))} />
          </label>
          <label>
            <span>TPM <HelpTip text="provider 侧每分钟 tokens 上限，用于保护上游服务额度。" /></span>
            <input type="number" min={0} value={form.tpm} onChange={(event) => updateField('tpm', numberFromInput(event.target.value))} />
          </label>
          <label>
            <span>并发上限 <HelpTip text="provider 部署允许同时处理的最大请求数。0 表示不单独限制并发。" /></span>
            <input type="number" min={0} value={form.maxParallelRequests} onChange={(event) => updateField('maxParallelRequests', numberFromInput(event.target.value))} />
          </label>
          <label>
            <span>路由策略 <HelpTip text="同一模型组有多个部署时的选择策略。当前单部署时影响很小，后续 key pool/fallback 会用到。" /></span>
            <select value={form.routingStrategy} onChange={(event) => updateField('routingStrategy', event.target.value)}>
              <option value="simple-shuffle">simple-shuffle</option>
              <option value="least-busy">least-busy</option>
              <option value="usage-based-routing">usage-based-routing</option>
              <option value="latency-based-routing">latency-based-routing</option>
            </select>
          </label>
          <label>
            <span>重试次数 <HelpTip text="LiteLLM/provider 层失败后的重试次数。Teacher 业务拒答和校验逻辑不由这里控制。" /></span>
            <input type="number" min={0} value={form.numRetries} onChange={(event) => updateField('numRetries', numberFromInput(event.target.value))} />
          </label>
          <label>
            <span>冷却失败数 <HelpTip text="连续失败达到该数量后，路由会让该部署短暂冷却，减少打到异常 provider。" /></span>
            <input type="number" min={0} value={form.allowedFails} onChange={(event) => updateField('allowedFails', numberFromInput(event.target.value))} />
          </label>
          <label>
            <span>冷却秒数 <HelpTip text="触发冷却后的暂停秒数。冷却结束后该部署可重新参与路由。" /></span>
            <input type="number" min={0} value={form.cooldownTime} onChange={(event) => updateField('cooldownTime', numberFromInput(event.target.value))} />
          </label>
          <label className="aiTeacherToggleField">
            <span>部署状态 <HelpTip text="关闭后该部署不会被 LiteLLM 路由使用。模型组内至少应保留一个启用部署。" /></span>
            <input type="checkbox" checked={form.enabled} onChange={(event) => updateField('enabled', event.target.checked)} />
          </label>
          <label className="aiTeacherWideField">
            <span>发布备注 <HelpTip text="记录这次配置变更原因，便于审计、回滚和排查。" /></span>
            <input value={form.notes} onChange={(event) => updateField('notes', event.target.value)} />
          </label>
        </div>
        <div className="adminActions aiTeacherFormActions">
          <button type="submit" className="primary" disabled={publishMutation.isPending}>
            {publishMutation.isPending ? '发布中' : '发布并生效'}
          </button>
          <span className="muted">{activeQuery.data?.version ? `active ${shortId(activeQuery.data.version.versionId)} · ${shortId(activeQuery.data.version.checksum)}` : '未读取到 active 配置'}</span>
        </div>
        {publishMutation.error ? <p className="dangerText">{String((publishMutation.error as Error).message || publishMutation.error)}</p> : null}
        {publishResult ? (
          <p className="muted">
            发布 {shortId(publishResult.version.versionId)}，apply 状态：{publishResult.apply.status}
            {publishResult.health?.status ? `，health：${publishResult.health.status}` : ''}
            {publishResult.apply.message ? ` · ${publishResult.apply.message}` : ''}
          </p>
        ) : null}
      </form>
      <div className="adminTableWrap">
        <table className="adminDataTable aiTeacherRuntimeTable">
          <thead>
            <tr>
              <th scope="col">项目</th>
              <th scope="col">当前值</th>
              <th scope="col">状态</th>
              <th scope="col">说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Teacher 服务</strong><span>{runtime?.teacher?.url || '-'}</span></td>
              <td>{runtime?.teacher?.status || 'unknown'}</td>
              <td><StatusPill status={runtime?.teacher?.status || 'unknown'} /></td>
              <td>{runtime?.teacher?.error || 'API 通过 Teacher sidecar 访问模型。'}</td>
            </tr>
            <tr>
              <td><strong>Gateway</strong><span>direct / litellm</span></td>
              <td>{runtime?.gateway || '-'}</td>
              <td><StatusPill status={runtime?.gateway === 'litellm' ? 'active' : 'configured'} /></td>
              <td>LiteLLM 负责 provider 侧 key pool、routing、RPM/TPM 和 fallback。</td>
            </tr>
            <tr>
              <td><strong>Provider mode</strong><span>{provider.reason || 'runtime provider state'}</span></td>
              <td>{runtime?.providerMode || provider.mode || '-'}</td>
              <td><StatusPill status={provider.enabled === false ? 'disabled' : 'healthy'} /></td>
              <td>Teacher 对外只暴露安全状态，不暴露 API key 或 provider trace。</td>
            </tr>
            <tr>
              <td><strong>LiteLLM</strong><span>{runtime?.litellm?.baseUrl || 'not configured'}</span></td>
              <td>{healthQuery.data?.configured ? 'configured' : 'not configured'}</td>
              <td><StatusPill status={healthQuery.data?.status || runtime?.litellm?.status || 'unknown'} /></td>
              <td>{healthQuery.data?.error || '模型组发布时会先校验 env 引用、调用 LiteLLM 管理接口并通过健康检查，全部通过后才切换业务库 active 版本。'}</td>
            </tr>
            <tr>
              <td><strong>Timeout</strong><span>Teacher upstream timeout</span></td>
              <td>{formatNumber(runtime?.limits?.teacherTimeoutMs)} ms</td>
              <td><StatusPill status="configured" /></td>
              <td>超时、重试、队列和熔断仍由 Teacher/LiteLLM 共同保护。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="adminTableWrap">
        <table className="adminDataTable aiTeacherSecretTable">
          <thead>
            <tr>
              <th scope="col">Env 引用 <HelpTip text="这些是容器运行环境里的变量名，配置发布前会检查是否存在。" /></th>
              <th scope="col">用途</th>
              <th scope="col">就绪</th>
              <th scope="col">脱敏值 <HelpTip text="API key 只显示首尾脱敏。API Base 可用于确认 URL 指向，但不会把 key 明文暴露在页面上。" /></th>
            </tr>
          </thead>
          <tbody>
            {(healthQuery.data?.secrets || []).map((secret) => (
              <tr key={`${secret.role}:${secret.envName}`}>
                <td><strong>{secret.envName}</strong><span>{secret.required ? '必需' : '可选'}</span></td>
                <td>{secretRoleLabel(secret.role)}</td>
                <td><StatusPill status={secret.present ? 'ready' : secret.required ? 'missing' : 'optional'} /></td>
                <td>{secret.maskedValue || (secret.present ? '已配置' : '-')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!(healthQuery.data?.secrets || []).length ? <p className="muted">当前配置没有可展示的 env 引用状态。</p> : null}
      </div>
    </section>
  );
}
*/

function AiTeacherTierPolicyTab({ policies }: { policies?: AiTeacherTierPoliciesResponse }) {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const tiers = ['guest', 'free', 'plus'];
  const [draft, setDraft] = useState<Record<string, AiTeacherTierPolicyDraft>>(() => tierPolicyDraftFromResponse(policies));

  useEffect(() => {
    if (policies) setDraft(tierPolicyDraftFromResponse(policies));
  }, [policies]);

  const mutation = useMutation({
    mutationFn: (nextDraft: Record<string, AiTeacherTierPolicyDraft>) => api.request<AiTeacherTierPoliciesResponse>('/api/admin/ai-teacher/tier-policies', {
      method: 'PATCH',
      body: { policies: nextDraft }
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher'] });
    }
  });

  const updateTier = (tier: string, patch: Partial<AiTeacherTierPolicyDraft>) => {
    setDraft((current) => ({
      ...current,
      [tier]: { ...(current[tier] || emptyTierPolicyDraft()), ...patch }
    }));
  };

  return (
    <section className="adminPanel" data-ai-teacher-policies>
      <header className="sectionHeader">
        <div>
          <span className="missionEyebrow">Tier Policies</span>
          <h2>用户等级限额管理</h2>
          <p className="muted">只配置每日与每周 tokens。周窗口以服务端自然周为准。</p>
        </div>
      </header>
      <div className="adminLifecycleSummary aiTeacherPolicyWindow">
        <span><strong>{formatDateTime(policies?.resetPolicy.weekStartAt || '')}</strong> 本周开始</span>
        <span><strong>{formatDateTime(policies?.resetPolicy.weekEndAt || '')}</strong> 本周结束</span>
        <span><strong>{formatDateTime(policies?.resetPolicy.nextWeeklyResetAt || '')}</strong> 下次周重置</span>
        <span><strong>{policies?.resetPolicy.timezone || 'local'}</strong> 时区</span>
      </div>
      <div className="adminTableWrap">
        <table className="adminDataTable aiTeacherPolicyTable">
          <thead>
            <tr>
              <th scope="col">等级</th>
              <th scope="col">日限额</th>
              <th scope="col">周限额</th>
              <th scope="col">AI Teacher</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => {
              const policy = draft[tier] || emptyTierPolicyDraft();
              return (
                <tr key={tier}>
                  <td><strong>{tier}</strong><span>{tierPolicyDescription(tier)}</span></td>
                  <td>
                    <input
                      className="aiTeacherPolicyInput"
                      type="number"
                      min={0}
                      value={policy.dailyTokenLimit}
                      onChange={(event) => updateTier(tier, { dailyTokenLimit: numberFromInput(event.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      className="aiTeacherPolicyInput"
                      type="number"
                      min={0}
                      value={policy.weeklyTokenLimit}
                      onChange={(event) => updateTier(tier, { weeklyTokenLimit: numberFromInput(event.target.value) })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="aiTeacherTierToggleButton"
                      data-ai-teacher-tier-toggle={tier}
                      data-state={policy.enabled ? 'enabled' : 'disabled'}
                      aria-pressed={policy.enabled}
                      onClick={() => updateTier(tier, { enabled: !policy.enabled })}
                    >
                      <Bot size={14} />
                      <span>{policy.enabled ? '已开启' : '未开启'}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="adminActions aiTeacherFormActions">
          <button type="button" className="primary" disabled={mutation.isPending} onClick={() => mutation.mutate(draft)}>
            {mutation.isPending ? '保存中' : '保存限额策略'}
          </button>
          <span className="muted">右侧按钮会授予或撤销该等级的 AI Teacher 使用权；0 表示不设 token 上限。</span>
        </div>
        {mutation.error ? <p className="dangerText">{String((mutation.error as Error).message || mutation.error)}</p> : null}
      </div>
    </section>
  );
}

function AiTeacherUsageTab() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'ai-teacher', 'usage', 'users', search],
    queryFn: () => api.request<AiTeacherUsageUsersResponse>(`/api/admin/ai-teacher/usage/users?limit=100&search=${encodeURIComponent(search)}`),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const liteLlmUsageQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'litellm', 'usage-summary'],
    queryFn: () => api.request<AiTeacherLiteLlmUsageSummaryResponse>('/api/admin/ai-teacher/litellm/usage-summary'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const resetQuota = useMutation({
    mutationFn: (userId: string) => api.request(`/api/admin/ai-teacher/usage/users/${encodeURIComponent(userId)}/reset`, { method: 'POST' }),
    onSuccess: async () => {
      setNotice('该账号的今日与本周 AI Teacher 已用额度已同时重置。');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'usage'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'quota-events'] })
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : '重置 AI Teacher 配额失败')
  });

  if (query.isLoading) return <LoadingState label="正在加载用户 token 用量" />;
  if (query.error) return <ErrorState title="用户 token 用量加载失败" error={query.error} />;
  const rows = query.data?.users || [];

  return (
    <section className="adminPanel" data-ai-teacher-usage>
      <header className="sectionHeader">
        <div>
          <span className="missionEyebrow">Usage</span>
          <h2>用户 tokens 用量监控</h2>
          <p className="muted">用量来自平台 ledger，展示今日与本周窗口；LiteLLM/provider 数据用于后续对账。</p>
        </div>
        <label className="glossarySearch adminSearch">
          <span className="srOnly">搜索 AI Teacher 用量用户</span>
          <input value={search} placeholder="搜索用户、邮箱或 ID" onChange={(event) => setSearch(event.target.value)} />
        </label>
      </header>
      <div className="adminLifecycleSummary aiTeacherMetricGrid" aria-label="LiteLLM 用量摘要">
        <span><strong>{liteLlmUsageQuery.data?.status || 'unknown'}</strong> LiteLLM 统计</span>
        <span><strong>{formatNumber(liteLlmUsageQuery.data?.totalTokens)}</strong> LiteLLM tokens</span>
        <span><strong>{formatCurrency(liteLlmUsageQuery.data?.spend, liteLlmUsageQuery.data?.currency)}</strong> LiteLLM spend</span>
        <span><strong>{liteLlmUsageQuery.data?.configured ? '只读对账' : '未配置'}</strong> 配额仍由平台控制 <HelpTip text="日/周 token 拦截以平台 ledger 为准。LiteLLM spend logs 用于核对 provider 侧实际消耗。" /></span>
      </div>
      {liteLlmUsageQuery.error ? <p className="dangerText">LiteLLM 用量摘要加载失败：{String((liteLlmUsageQuery.error as Error).message || liteLlmUsageQuery.error)}</p> : null}
      {liteLlmUsageQuery.data?.error ? <p className="muted">LiteLLM 用量摘要不可用：{liteLlmUsageQuery.data.error}</p> : null}
      {notice ? <p className="adminActionNotice" role="status">{notice}</p> : null}
      <div className="adminTableWrap">
        <table className="adminDataTable aiTeacherUsageTable">
          <thead>
            <tr>
              <th scope="col">用户</th>
              <th scope="col">等级</th>
              <th scope="col">今日 tokens <HelpTip text="格式为 已用 / 限额。未设上限表示该等级没有配置日 token 拦截。" /></th>
              <th scope="col">本周 tokens <HelpTip text="格式为 已用 / 限额。周窗口按服务端自然周重置。" /></th>
              <th scope="col">下次周重置</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.user.id}>
                <td><strong>{row.user.displayName || row.user.email || row.user.id}</strong><span>{row.user.email || row.user.id}</span></td>
                <td>{row.user.tier || 'free'}</td>
                <td>{formatUsageLimit(row.usage.dailyTokens, row.usage.tokenQuota.dailyTokenLimit, row.usage.tokenQuota.dailyRemainingTokens)}</td>
                <td>{formatUsageLimit(row.usage.weeklyTokens, row.usage.tokenQuota.weeklyTokenLimit, row.usage.tokenQuota.weeklyRemainingTokens)}</td>
                <td>{formatDateTime(row.usage.tokenQuota.nextWeeklyResetAt || '')}</td>
                <td>
                  <button
                    type="button"
                    className="adminInlineAction"
                    data-ai-teacher-quota-reset={row.user.id}
                    disabled={resetQuota.isPending}
                    onClick={() => {
                      const label = row.user.displayName || row.user.email || row.user.id;
                      if (window.confirm(`确认同时重置 ${label} 的今日与本周 AI Teacher 已用额度？历史 token 账本仍会保留。`)) {
                        resetQuota.mutate(row.user.id);
                      }
                    }}
                  >
                    <RotateCcw size={14} />重置日/周额度
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="muted">没有匹配的 AI Teacher 用量记录。</p> : null}
      </div>
    </section>
  );
}

function AiTeacherLogsTab() {
  const api = useAppApiClient();
  const [search, setSearch] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const conversationsQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'conversations', search],
    queryFn: () => api.request<AiTeacherConversationsResponse>(`/api/admin/ai-teacher/conversations?limit=80&search=${encodeURIComponent(search)}`),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const observabilityQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'failure-observability', 24],
    queryFn: () => api.request<AiTeacherFailureObservabilityResponse>('/api/admin/ai-teacher/failure-observability?windowHours=24&limit=40'),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });
  const activeThreadId = selectedThreadId || conversationsQuery.data?.conversations?.[0]?.threadId || '';
  const messagesQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'conversation-messages', activeThreadId],
    enabled: Boolean(activeThreadId),
    queryFn: () => api.request<AiTeacherConversationMessagesResponse>(`/api/admin/ai-teacher/conversations/${encodeURIComponent(activeThreadId)}/messages?limit=100`),
    refetchInterval: AI_TEACHER_ADMIN_REFRESH_MS
  });

  if (conversationsQuery.isLoading) return <LoadingState label="正在加载 AI Teacher 对话日志" />;
  if (conversationsQuery.error) return <ErrorState title="AI Teacher 对话日志加载失败" error={conversationsQuery.error} />;
  const conversations = conversationsQuery.data?.conversations || [];
  const observability = observabilityQuery.data;

  return (
    <div className="adminGrid aiTeacherLogsGrid" data-ai-teacher-logs>
      <section className="adminPanel aiTeacherFailureMonitor" data-ai-teacher-failure-observability>
        <header className="sectionHeader">
          <div>
            <span className="missionEyebrow">Delivery Observability</span>
            <h2>结果交付与降级监控</h2>
            <p className="muted">统计最近 24 小时终态，每 60 秒刷新。降级回答仍返回前端，但原因只进入内部审计。</p>
          </div>
          <StatusPill status={observability?.status || 'unavailable'} />
        </header>
        {observabilityQuery.isLoading ? <LoadingState label="正在加载结果交付监控" /> : null}
        {observabilityQuery.error ? <ErrorState title="结果交付监控加载失败" error={observabilityQuery.error} /> : null}
        {observability && !observability.observationEnabled ? <p className="muted">运行审计已关闭，当前不能据此判断系统健康状态。</p> : null}
        {observability ? (
          <>
            <div className="adminLifecycleSummary aiTeacherFailureMetricGrid" aria-label="AI Teacher 结果交付摘要">
              <span><strong>{formatPercent(observability.summary.frontendDeliveryRate)}</strong> 前端结果返回率</span>
              <span><strong>{formatNumber(observability.summary.complete)}</strong> 完整结果</span>
              <span><strong>{formatNumber(observability.summary.degraded)}</strong> 降级结果</span>
              <span><strong>{formatNumber(observability.summary.failed + observability.summary.timedOut)}</strong> 失败 / 超时</span>
              <span><strong>{formatPercent(observability.summary.degradationRate)}</strong> 已返回结果降级率</span>
            </div>
            <div className="aiTeacherFailureDetails">
              <div>
                <h3>主要原因</h3>
                <ul className="aiTeacherReasonList">
                  {observability.reasonCounts.map((item) => (
                    <li key={item.reasonCode}><code>{item.reasonCode}</code><strong>{formatNumber(item.count)}</strong></li>
                  ))}
                </ul>
                {!observability.reasonCounts.length ? <p className="muted">当前窗口没有降级或失败原因。</p> : null}
              </div>
              <div className="adminTableWrap">
                <table className="adminDataTable aiTeacherFailureTable">
                  <thead><tr><th scope="col">时间 / Run</th><th scope="col">交付</th><th scope="col">阶段</th><th scope="col">原因</th></tr></thead>
                  <tbody>
                    {observability.recent.map((event) => (
                      <tr key={`${event.runId}-${event.createdAt}`}>
                        <td><strong>{formatDateTime(event.createdAt || '')}</strong><span>{event.runId || event.requestId || '-'}</span></td>
                        <td><StatusPill status={event.status} /><span>{event.frontendResultReturned ? '已返回结果' : '未返回结果'}</span></td>
                        <td><strong>{event.answerCompletionStatus || '-'}</strong><span>{event.stopReason || event.validatorStatus || '-'}</span></td>
                        <td>{event.reasonCodes.length ? event.reasonCodes.join('、') : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!observability.recent.length ? <p className="muted">当前窗口没有终态运行记录。</p> : null}
              </div>
            </div>
          </>
        ) : null}
      </section>
      <section className="adminPanel">
        <header className="sectionHeader">
          <div>
            <span className="missionEyebrow">Conversation Logs</span>
            <h2>用户对话 log 监控</h2>
            <p className="muted">默认展示消息摘要，避免在列表中暴露完整学生输入和回答。</p>
          </div>
          <label className="glossarySearch adminSearch">
            <span className="srOnly">搜索对话日志</span>
            <input value={search} placeholder="搜索用户、lesson、thread 或关键词" onChange={(event) => {
              setSearch(event.target.value);
              setSelectedThreadId('');
            }} />
          </label>
        </header>
        <div className="adminTableWrap">
          <table className="adminDataTable aiTeacherConversationTable">
            <thead>
              <tr>
                <th scope="col">对话</th>
                <th scope="col">用户</th>
                <th scope="col">Tokens</th>
                <th scope="col">时间</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((thread) => (
                <tr
                  key={thread.threadId}
                  data-selected={thread.threadId === activeThreadId ? 'true' : 'false'}
                  onClick={() => setSelectedThreadId(thread.threadId)}
                >
                  <td><strong>{thread.title || thread.threadId}</strong><span>{thread.lastUserMessage || thread.threadId}</span></td>
                  <td><strong>{thread.user.displayName || thread.user.email || thread.user.id}</strong><span>{thread.user.tier || 'free'} · {thread.lessonId || '-'}</span></td>
                  <td>{formatNumber(thread.totalTokens)}</td>
                  <td>{formatDateTime(thread.updatedAt || thread.createdAt || '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!conversations.length ? <p className="muted">没有匹配的对话日志。</p> : null}
        </div>
      </section>
      <section className="adminPanel aiTeacherMessagePanel">
        <header className="sectionHeader">
          <div>
            <span className="missionEyebrow">Messages</span>
            <h2>消息摘要</h2>
          </div>
        </header>
        {messagesQuery.isLoading ? <LoadingState label="正在加载消息摘要" /> : null}
        {messagesQuery.error ? <ErrorState title="消息摘要加载失败" error={messagesQuery.error} /> : null}
        <div className="aiTeacherLogTimeline">
          {(messagesQuery.data?.messages || []).map((message) => (
            <article key={message.id} data-role={message.role}>
              <header>
                <strong>{message.role}</strong>
                <span>{formatDateTime(message.createdAt || '')}</span>
              </header>
              <p>{message.contentPreview || '空消息'}</p>
              <small>{message.model || 'model unknown'} · {formatNumber(message.tokenUsage?.totalTokens)} tokens</small>
            </article>
          ))}
          {activeThreadId && !messagesQuery.isLoading && !(messagesQuery.data?.messages || []).length ? <p className="muted">当前对话没有可显示消息。</p> : null}
          {!activeThreadId ? <p className="muted">选择一条对话查看消息摘要。</p> : null}
        </div>
      </section>
    </div>
  );
}

function AdminUsersPanel() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<AdminUserSort | null>(null);
  const query = useQuery({
    queryKey: ['admin', 'users', search, page, pageSize, sort],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String((page - 1) * pageSize),
        search
      });
      if (sort) {
        params.set('sortBy', sort.key);
        params.set('sortDirection', sort.direction);
      }
      return api.request<AdminUsersResponse>(`/api/admin/users?${params.toString()}`);
    }
  });
  const authSettingsQuery = useQuery({
    queryKey: ['admin', 'auth', 'settings'],
    queryFn: () => api.request<AuthSettingsResponse>('/api/admin/auth/settings')
  });

  const mutation = useMutation({
    mutationFn: ({ userId, action, value }: { userId: string; action: 'tier' | 'status'; value: string }) => api.request(
      `/api/admin/users/${encodeURIComponent(userId)}/${action}`,
      { method: 'PATCH', body: action === 'tier' ? { tier: value } : { status: value } }
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
  });
  const authSettingsMutation = useMutation({
    mutationFn: (settings: Partial<AuthSettingsResponse['settings']>) => api.request<AuthSettingsResponse>('/api/admin/auth/settings', {
      method: 'PATCH',
      body: settings
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'auth', 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['auth', 'providers'] })
      ]);
    }
  });

  if (query.isLoading) return <LoadingState label="正在加载用户列表" />;
  if (query.error) return <ErrorState title="用户列表加载失败" error={query.error} />;

  const users = query.data?.users || [];
  const totalUsers = query.data?.total || 0;
  const authSettings = authSettingsQuery.data?.settings;
  const registrationEnabled = authSettings?.registrationEnabled !== false;
  const guestLoginEnabled = authSettings?.guestLoginEnabled !== false;
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const currentPage = Math.min(page, totalPages);
  const toggleSort = (key: AdminUserSortKey) => {
    setSort((current) => ({
      key,
      direction: current?.key === key && current.direction === 'ascending' ? 'descending' : 'ascending'
    }));
    setPage(1);
  };

  return (
    <section className="adminPanel" data-admin-users>
      <header className="sectionHeader">
        <div>
          <span className="missionEyebrow">Users</span>
          <h2>账号运营</h2>
        </div>
        <label className="glossarySearch adminSearch">
          <span className="srOnly">搜索用户</span>
          <input value={search} placeholder="搜索账号、邮箱或显示名" onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }} />
        </label>
      </header>
      <div className="authSettingsBar" data-admin-auth-settings>
        <div>
          <span className="missionEyebrow">Access</span>
          <strong>登录入口</strong>
        </div>
        <label className="adminSwitch">
          <input
            type="checkbox"
            checked={guestLoginEnabled}
            disabled={authSettingsQuery.isLoading || authSettingsMutation.isPending}
            onChange={(event) => authSettingsMutation.mutate({ guestLoginEnabled: event.target.checked })}
          />
          <span>游客登录</span>
          <small>{guestLoginEnabled ? '已开启' : '已关闭'}</small>
        </label>
        <label className="adminSwitch">
          <input
            type="checkbox"
            checked={registrationEnabled}
            disabled={authSettingsQuery.isLoading || authSettingsMutation.isPending}
            onChange={(event) => authSettingsMutation.mutate({ registrationEnabled: event.target.checked })}
          />
          <span>自助注册</span>
          <small>{registrationEnabled ? '已开启' : '已关闭'}</small>
        </label>
        {authSettingsMutation.error ? <p className="authSettingsError">{authSettingsMutation.error instanceof Error ? authSettingsMutation.error.message : '保存登录入口设置失败'}</p> : null}
      </div>
      <AdminPagination
        label="账号分页"
        page={currentPage}
        pageSize={pageSize}
        pageSizeOptions={[10, 25]}
        totalItems={totalUsers}
        totalPages={totalPages}
        onPageChange={setPage}
        onPageSizeChange={(nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        }}
      />
      <div className="adminTableWrap">
        <table className="adminDataTable adminUserTable" data-admin-user-table>
          <thead>
            <tr>
              <AdminSortableHeader label="用户" sortKey="user" sort={sort} onSort={toggleSort} />
              <AdminSortableHeader label="注册时间" sortKey="createdAt" sort={sort} onSort={toggleSort} />
              <AdminSortableHeader label="最后登录时间" sortKey="lastLoginAt" sort={sort} onSort={toggleSort} />
              <AdminSortableHeader label="活跃时长（日:时:分）" sortKey="activeDurationSeconds" sort={sort} onSort={toggleSort} />
              <AdminSortableHeader label="档次" sortKey="tier" sort={sort} onSort={toggleSort} />
              <AdminSortableHeader label="状态" sortKey="status" sort={sort} onSort={toggleSort} />
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((item) => (
              <tr key={item.id} data-admin-user-row data-user-status={item.status || 'active'}>
                <td>
                  <strong>{item.displayName || item.username || item.email || item.id}</strong>
                  <span>{item.email || item.username || item.id}</span>
                </td>
                <td>{formatAccountDateTime(item.createdAt || '')}</td>
                <td>{formatAccountDateTime(item.lastLoginAt || '')}</td>
                <td>{formatActiveDuration(item.activeDurationSeconds)}</td>
                <td>{item.tier || 'free'}</td>
                <td>{item.status || 'active'}</td>
                <td>
                  <div className="adminActions">
                    <button type="button" data-admin-user-action="tier-free" onClick={() => mutation.mutate({ userId: item.id, action: 'tier', value: 'free' })}>Free</button>
                    <button type="button" data-admin-user-action="tier-plus" onClick={() => mutation.mutate({ userId: item.id, action: 'tier', value: 'plus' })}>Plus</button>
                    <button
                      type="button"
                      data-admin-user-action={item.status === 'disabled' ? 'enable' : 'disable'}
                      onClick={() => mutation.mutate({ userId: item.id, action: 'status', value: item.status === 'disabled' ? 'active' : 'disabled' })}
                    >
                      {item.status === 'disabled' ? '启用' : '禁用'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!users.length ? <p className="muted">没有匹配的用户。</p> : null}
      </div>
    </section>
  );
}

function AdminSortableHeader({ label, onSort, sort, sortKey }: {
  label: string;
  onSort: (key: AdminUserSortKey) => void;
  sort: AdminUserSort | null;
  sortKey: AdminUserSortKey;
}) {
  const activeDirection = sort?.key === sortKey ? sort.direction : null;
  const nextDirection = activeDirection === 'ascending' ? '降序' : '升序';
  return (
    <th scope="col" aria-sort={activeDirection || 'none'}>
      <button
        type="button"
        className="adminTableSortButton"
        data-admin-sort-key={sortKey}
        data-sort-direction={activeDirection || 'none'}
        aria-label={`${label}，点击按${nextDirection}排列`}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        <span className="adminTableSortIndicator" aria-hidden="true">
          <ArrowUp size={11} className={activeDirection === 'ascending' ? 'isActive' : ''} />
          <ArrowDown size={11} className={activeDirection === 'descending' ? 'isActive' : ''} />
        </span>
      </button>
    </th>
  );
}

function CoursePackAdminPanel() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [packPageSize, setPackPageSize] = useState<PageSize>(5);
  const [packPage, setPackPage] = useState(1);
  const packsQuery = useQuery({
    queryKey: ['admin', 'course-packs'],
    queryFn: () => api.request<AdminCoursePacksResponse>('/api/admin/course-packs')
  });
  const pendingQuery = useQuery({
    queryKey: ['admin', 'course-packs', 'pending'],
    queryFn: () => api.request<PendingUploadsResponse>('/api/admin/course-packs/upload/pending')
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'course-packs'] }),
      queryClient.invalidateQueries({ queryKey: ['course-packs'] })
    ]);
  };

  const previewUpload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.set('file', file);
      return api.request<{ ok: boolean; pendingUpload: PendingUpload }>('/api/admin/course-packs/upload/preview', {
        method: 'POST',
        body
      });
    },
    onSuccess: async (result) => {
      setNotice(`已生成上传预览：${result.pendingUpload?.packSummary?.title || result.pendingUpload?.packSummary?.id || result.pendingUpload?.pendingUploadId}。确认加载为停用状态后才会进入课程列表。`);
      setSelectedFile(null);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : '上传预览失败')
  });

  const pendingAction = useMutation({
    mutationFn: ({ pendingUploadId, action }: { pendingUploadId: string; action: string }) => action === 'abandon'
      ? api.request(`/api/admin/course-packs/upload/${encodeURIComponent(pendingUploadId)}`, { method: 'DELETE' })
      : api.request('/api/admin/course-packs/upload/confirm', { method: 'POST', body: { pendingUploadId, action } }),
    onSuccess: async () => {
      setNotice('课程包 pending 操作已完成。');
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'pending 操作失败')
  });

  const lifecycleAction = useMutation({
    mutationFn: ({ packId, action, enabled }: { packId: string; action: 'enable' | 'disable' | 'archive' | 'restore' | 'delete'; enabled?: boolean }) => {
      if (action === 'enable' || action === 'disable') {
        return api.request(`/api/admin/course-packs/${encodeURIComponent(packId)}`, { method: 'PATCH', body: { enabled } });
      }
      if (action === 'delete') {
        return api.request(`/api/admin/course-packs/${encodeURIComponent(packId)}`, { method: 'DELETE' });
      }
      return api.request(`/api/admin/course-packs/${encodeURIComponent(packId)}/${action}`, { method: 'POST' });
    },
    onSuccess: async () => {
      setNotice('课程包状态已更新。');
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : '课程包状态更新失败')
  });
  const orderAction = useMutation({
    mutationFn: ({ packId, direction }: { packId: string; direction: 'up' | 'down' }) => api.request(
      `/api/admin/course-packs/${encodeURIComponent(packId)}/move`,
      { method: 'POST', body: { direction } }
    ),
    onSuccess: async () => {
      setNotice('课程排序已更新，课程书架和课程下拉列表会使用同一顺序。');
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : '课程排序更新失败')
  });

  const submitUpload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedFile) {
      setNotice('请先选择 .zip 或 .rar 课程包。');
      return;
    }
    previewUpload.mutate(selectedFile);
  };

  const packs = packsQuery.data?.packs || [];
  const pendingUploads = pendingQuery.data?.pendingUploads || [];
  const lifecycleCounts = useMemo(() => summarizePackStatuses(packs), [packs]);
  const packTotalPages = Math.max(1, Math.ceil(packs.length / packPageSize));
  const currentPackPage = Math.min(packPage, packTotalPages);
  const visiblePacks = packs.slice((currentPackPage - 1) * packPageSize, currentPackPage * packPageSize);

  if (packsQuery.isLoading || pendingQuery.isLoading) return <LoadingState label="正在加载课程包管理数据" />;
  if (packsQuery.error) return <ErrorState title="课程包列表加载失败" error={packsQuery.error} />;
  if (pendingQuery.error) return <ErrorState title="待确认上传加载失败" error={pendingQuery.error} />;

  return (
    <div className="adminGrid">
      <section className="adminPanel adminUploadOverviewPanel">
        <header className="sectionHeader">
          <div>
            <span className="missionEyebrow">Upload</span>
            <h2>上传预览</h2>
          </div>
        </header>
        <div className="adminUploadOverview">
          <form className="packUploadPanel" data-pack-upload-form onSubmit={submitUpload}>
            <input type="file" accept=".zip,.rar" onChange={(event) => setSelectedFile(event.currentTarget.files?.[0] || null)} />
            <button type="submit" className="primaryAction" disabled={previewUpload.isPending}>
              <Upload size={16} />{previewUpload.isPending ? '预览中' : '上传并预览'}
            </button>
            <small data-pack-upload-status>{notice || '支持 .zip / .rar。压缩包内必须包含 course-pack.json。'}</small>
          </form>
          <div className="adminImpactGrid" aria-label="课程包上传影响">
            <article>
              <strong>Preview gate</strong>
              <p>上传只生成待确认记录，不会立即发布到学习端。</p>
            </article>
            <article>
              <strong>Identity check</strong>
              <p>按 lineageId、已删除 lineage 和内容指纹识别同一课程包。</p>
            </article>
            <article>
              <strong>Data policy</strong>
              <p>归档和删除不会清理学生个人草稿或旧数据命名空间。</p>
            </article>
          </div>
        </div>
        <div className="pendingUploadList">
          {pendingUploads.map((pending) => (
            <article key={pending.pendingUploadId} className="pendingUploadCard" data-pending-upload data-pending-decision={pending.decision?.type || 'unknown'}>
              <div className="pendingUploadHead">
                <div>
                  <span className="missionEyebrow">Pending upload</span>
                  <strong>{decisionTitle(pending)}</strong>
                  <p>{pending.decision?.reason || '等待管理员确认。'}</p>
                </div>
                <span className="packStatusPill" data-status={pending.decision?.willAssociateStudentData ? 'associated' : 'isolated'}>
                  {pending.decision?.willAssociateStudentData ? '关联旧学生数据' : '新数据命名空间'}
                </span>
              </div>
              <dl className="adminUploadMeta">
                <div><dt>课程包</dt><dd>{pending.packSummary?.title || pending.packSummary?.id || pending.originalName}</dd></div>
                <div><dt>coursePackId</dt><dd>{pending.packSummary?.id || '-'}</dd></div>
                <div><dt>版本</dt><dd>{pending.packSummary?.version || '-'}</dd></div>
                <div><dt>身份文件</dt><dd>{identityLabel(pending)}</dd></div>
                <div><dt>lineageId</dt><dd>{pending.decision?.lineageId || pending.identity?.lineageId || '将由系统生成'}</dd></div>
                <div><dt>dataNamespaceId</dt><dd>{pending.decision?.dataNamespaceId || '将由系统生成'}</dd></div>
                <div><dt>内容指纹</dt><dd>{pending.contentHashShort || '-'}</dd></div>
                <div><dt>确认后状态</dt><dd>{statusLabel(pending.decision?.targetStatus || 'disabled')}</dd></div>
              </dl>
              <div className="adminActions">
                {actionSet(pending).has('confirm') ? <button type="button" data-confirm-pending-upload={pending.pendingUploadId} data-action="confirm" onClick={() => pendingAction.mutate({ pendingUploadId: pending.pendingUploadId, action: 'confirm' })}>确认加载为停用状态</button> : null}
                {actionSet(pending).has('as_new') ? <button type="button" data-confirm-pending-upload={pending.pendingUploadId} data-action="as_new" onClick={() => pendingAction.mutate({ pendingUploadId: pending.pendingUploadId, action: 'as_new' })}>作为新课程加载</button> : null}
                {actionSet(pending).has('restore') ? <button type="button" data-confirm-pending-upload={pending.pendingUploadId} data-action="restore" onClick={() => pendingAction.mutate({ pendingUploadId: pending.pendingUploadId, action: 'restore' })}>恢复旧课程加载</button> : null}
                <button type="button" className="dangerText" data-abandon-pending-upload={pending.pendingUploadId} onClick={() => {
                  const label = pending.packSummary?.title || pending.packSummary?.id || pending.originalName || pending.pendingUploadId;
                  if (window.confirm(`确认放弃课程包上传 ${label}？该待确认记录会被删除，已发布课程包不会受影响。`)) {
                    pendingAction.mutate({ pendingUploadId: pending.pendingUploadId, action: 'abandon' });
                  }
                }}>放弃上传</button>
              </div>
            </article>
          ))}
          {!pendingUploads.length ? <p className="muted">没有等待确认的课程包上传。</p> : null}
        </div>
      </section>

      <section className="adminPanel">
        <header className="sectionHeader">
          <div>
            <span className="missionEyebrow">Lifecycle</span>
            <h2>课程包状态</h2>
            <p className="muted">启用课程进入学习端 Gallery；停用课程可归档；归档课程可恢复为停用或删除，学生草稿数据保留。</p>
          </div>
        </header>
        <div className="adminLifecycleSummary" aria-label="课程包状态统计">
          <span><strong>{lifecycleCounts.enabled}</strong> 启用</span>
          <span><strong>{lifecycleCounts.disabled}</strong> 停用</span>
          <span><strong>{lifecycleCounts.archived}</strong> 归档</span>
          <span><strong>{packs.length}</strong> 总计</span>
        </div>
        <AdminPagination
          label="课程包分页"
          page={currentPackPage}
          pageSize={packPageSize}
          pageSizeOptions={[5, 10]}
          totalItems={packs.length}
          totalPages={packTotalPages}
          onPageChange={setPackPage}
          onPageSizeChange={(nextSize) => {
            setPackPageSize(nextSize);
            setPackPage(1);
          }}
        />
        <div className="adminTableWrap">
          <table className="adminDataTable adminPackTable" data-admin-pack-table>
            <thead>
              <tr>
                <th scope="col">课程包</th>
                <th scope="col">状态</th>
                <th scope="col">版本</th>
                <th scope="col">数据</th>
                <th scope="col">排序</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
          {visiblePacks.map((pack) => {
            const status = packStatus(pack);
            const versions = Array.isArray(pack.versions) ? pack.versions : [];
            const latest = versions[0] || {};
            const packIndex = packs.findIndex((item) => item.id === pack.id);
            return (
              <tr key={pack.id} className="adminPackRow" data-pack-status={status}>
                <td className="adminPackIdentity">
                  <strong>{pack.title || pack.name || pack.id}</strong>
                  <span>{pack.id}</span>
                  <p>{pack.description || '未提供课程包简介。'}</p>
                </td>
                <td><span className="packStatusPill" data-status={status}>{statusLabel(status)}</span></td>
                <td>
                  <strong>{pack.version || latest.version || 'no version'}</strong>
                  <span>{sourceLabel(pack.source)} · {pack.versionCount || versions.length || 1} 版</span>
                  <span>{formatDateTime(pack.uploadedAt || latest.uploadedAt || '')}</span>
                </td>
                <td>
                  <span>lineage: {pack.lineageId || latest.lineageId || '-'}</span>
                  <span>namespace: {pack.dataNamespaceId || pack.lineageId || pack.id}</span>
                  <span>hash: {shortHash(latest.contentHash)}</span>
                </td>
                <td>
                  <div className="adminOrderActions">
                    <strong aria-label={`当前排序 ${packIndex + 1}`}>{packIndex + 1}</strong>
                    <button
                      type="button"
                      aria-label={`上移课程包 ${pack.title || pack.id}`}
                      title="上移"
                      data-pack-order-action="up"
                      data-pack-id={pack.id}
                      disabled={packIndex <= 0 || orderAction.isPending}
                      onClick={() => orderAction.mutate({ packId: pack.id, direction: 'up' })}
                    ><ArrowUp size={14} /></button>
                    <button
                      type="button"
                      aria-label={`下移课程包 ${pack.title || pack.id}`}
                      title="下移"
                      data-pack-order-action="down"
                      data-pack-id={pack.id}
                      disabled={packIndex >= packs.length - 1 || orderAction.isPending}
                      onClick={() => orderAction.mutate({ packId: pack.id, direction: 'down' })}
                    ><ArrowDown size={14} /></button>
                  </div>
                </td>
                <td>
                  <div className="adminActions">
                  {status === 'enabled'
                    ? <button type="button" data-pack-lifecycle-action="disable" data-pack-id={pack.id} onClick={() => lifecycleAction.mutate({ packId: pack.id, action: 'disable', enabled: false })}>停用</button>
                    : null}
                  {status === 'disabled'
                    ? <button type="button" data-pack-lifecycle-action="enable" data-pack-id={pack.id} onClick={() => lifecycleAction.mutate({ packId: pack.id, action: 'enable', enabled: true })}>启用</button>
                    : null}
                  {status === 'disabled'
                    ? <button type="button" data-pack-lifecycle-action="archive" data-pack-id={pack.id} onClick={() => {
                      if (window.confirm(`确认归档课程包 ${pack.id}？归档后前端不可见，学生草稿数据会保留在原数据命名空间。`)) lifecycleAction.mutate({ packId: pack.id, action: 'archive' });
                    }}><Archive size={14} />归档</button>
                    : null}
                  {status === 'archived'
                    ? <button type="button" data-pack-lifecycle-action="restore" data-pack-id={pack.id} onClick={() => lifecycleAction.mutate({ packId: pack.id, action: 'restore' })}><RotateCcw size={14} />恢复为停用</button>
                    : null}
                  {status === 'archived'
                    ? <button type="button" className="dangerText" data-pack-lifecycle-action="delete" data-pack-id={pack.id} onClick={() => {
                      if (window.confirm('删除归档课程包不会删除学生个人草稿数据。确认继续吗？')) lifecycleAction.mutate({ packId: pack.id, action: 'delete' });
                    }}><Trash2 size={14} />删除</button>
                    : null}
                  </div>
                </td>
              </tr>
            );
          })}
            </tbody>
          </table>
          {!packs.length ? <p className="muted">没有课程包。</p> : null}
        </div>
      </section>
    </div>
  );
}

function AdminPagination({ label, onPageChange, onPageSizeChange, page, pageSize, pageSizeOptions, totalItems, totalPages }: {
  label: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
  page: number;
  pageSize: PageSize;
  pageSizeOptions: PageSize[];
  totalItems: number;
  totalPages: number;
}) {
  const start = totalItems ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(totalItems, page * pageSize);
  return (
    <div className="adminPagination" aria-label={label}>
      <span>{start}-{end} / {totalItems}</span>
      <label>
        每页
        <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value) as PageSize)}>
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <div className="adminPaginationButtons">
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
        <span>{page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
      </div>
    </div>
  );
}

function hasUserAdminAccess(user: UserProfile | null): boolean {
  return hasPermission(user, 'admin.console.access');
}

function hasCoursePackManage(user: UserProfile | null): boolean {
  return hasPermission(user, 'course.pack.manage');
}

function hasPermission(user: UserProfile | null, code: string): boolean {
  return Boolean(
    user?.permissions?.includes(code)
    || user?.entitlements?.some((item) => item.code === code)
  );
}

function packStatus(pack: CoursePack & { status?: string }): string {
  const status = pack.status || (pack.enabled === false ? 'disabled' : 'active');
  if (status === 'active') return 'enabled';
  if (status === 'inactive') return 'disabled';
  return status;
}

function actionSet(pending: PendingUpload): Set<string> {
  return new Set(pending.availableActions || []);
}

function summarizePackStatuses(packs: AdminCoursePacksResponse['packs']) {
  return packs.reduce((summary, pack) => {
    const status = packStatus(pack);
    if (status === 'enabled') summary.enabled += 1;
    else if (status === 'disabled') summary.disabled += 1;
    else if (status === 'archived') summary.archived += 1;
    return summary;
  }, { enabled: 0, disabled: 0, archived: 0 });
}

function decisionTitle(pending: PendingUpload): string {
  const type = pending.decision?.type || '';
  const labels: Record<string, string> = {
    new_lineage: '识别为新课程',
    same_active_lineage: '识别为当前课程新版本',
    restore_deleted_by_identity: '识别为旧课程恢复',
    restore_deleted_by_hash: '识别为旧课程恢复',
    same_id_but_identity_missing: '同 ID 旧课程已删除，但身份缺失',
    identity_conflict: '课程身份冲突'
  };
  return labels[type] || pending.packSummary?.title || '课程包待确认';
}

function identityLabel(pending: PendingUpload): string {
  const status = pending.decision?.identityStatus || (pending.identity?.lineageId ? 'valid' : 'missing');
  const labels: Record<string, string> = {
    valid: '有效',
    missing: '缺失',
    conflict: '冲突',
    generated: '系统生成',
    provided: '已提供',
    unmatched: '未匹配',
    'not-required': '沿用现有课程'
  };
  return labels[status] || status || '未知';
}

function webSearchCapabilityDisplay(capability: AiTeacherProviderStatusResponse['capabilities'][number]) {
  if (!capability.enabled) {
    return {
      status: 'disabled',
      label: capability.canEnable === false ? '配置不完整' : '已关闭',
      description: capability.canEnable === false
        ? '搜索依赖配置不完整，当前无法开启。'
        : '本地开关已关闭，不会发起领域联网搜索。'
    };
  }
  if (capability.probe?.status === 'running' || capability.probe?.inProgress) {
    return {
      status: 'pending',
      label: '已开启 · 验证中',
      description: '正在执行一次最小付费搜索探针；Canary 正文不会进入对话或领域证据。'
    };
  }
  if (capability.probe?.policyEnabled === false || capability.probe?.status === 'paused') {
    return {
      status: 'pending',
      label: '已开启 · 探针暂停',
      description: '业务搜索开关已开启，但管理员付费探针已由独立服务端策略暂停。'
    };
  }
  if (capability.probe?.status === 'storage_unavailable') {
    return {
      status: 'incident',
      label: '已开启 · 探针不可用',
      description: '探针状态存储不可用，服务端不会在无法执行冷却约束时发起付费验证。'
    };
  }
  if (capability.ready && capability.verificationStatus === 'complete') {
    return {
      status: 'operational',
      label: '可用',
      description: webSearchProbeResultDescription(capability, '最近一次真实搜索取得了正文级来源。')
    };
  }
  if (!capability.verificationStatus || capability.verificationStatus === 'not_checked') {
    return {
      status: 'pending',
      label: '已开启 · 等待验证',
      description: '尚未完成真实搜索探针；刷新官方状态不会改变此状态。'
    };
  }
  if (capability.status === 'degraded' || capability.verificationStatus === 'partial') {
    return {
      status: 'degraded',
      label: '部分可用',
      description: webSearchProbeResultDescription(capability, '最近一次真实搜索未取得完整的正文级领域证据。')
    };
  }
  return {
    status: 'incident',
    label: '搜索异常',
    description: webSearchProbeResultDescription(capability, '最近一次真实搜索失败；请结合错误码与官方服务状态判断。')
  };
}

function webSearchProbeResultDescription(
  capability: AiTeacherProviderStatusResponse['capabilities'][number],
  prefix: string
): string {
  const probe = capability.probe;
  if (!probe?.lastCheckedAt) return prefix;
  const duration = probe.durationMs > 0 ? `，耗时 ${(probe.durationMs / 1000).toFixed(1)} 秒` : '';
  const warning = probe.warningCode ? `，错误码 ${probe.warningCode}` : '';
  return `${prefix} 最近验证 ${formatDateTime(probe.lastCheckedAt)}${duration}${warning}。`;
}

function webSearchProbeCooldownSeconds(
  probe: AiTeacherProviderStatusResponse['capabilities'][number]['probe'],
  now: number
): number {
  const next = Date.parse(String(probe?.nextAllowedAt || ''));
  return Number.isFinite(next) ? Math.max(0, Math.ceil((next - now) / 1000)) : 0;
}

function webSearchProbeControlHint(
  capability: AiTeacherProviderStatusResponse['capabilities'][number],
  cooldownSeconds: number
): string {
  if (!capability.enabled) return `重启恢复${capability.startupEnabled ? '默认开启' : '默认关闭'}`;
  if (capability.probe?.policyEnabled === false) return '付费探针已暂停；关闭仍可立即执行';
  if (capability.probe?.inProgress) return '正在执行一次最小付费搜索；关闭不受限制';
  if (cooldownSeconds > 0) return `${cooldownSeconds} 秒后可再次验证；关闭不受限制`;
  return `本小时还可验证 ${capability.probe?.remainingHourlyAttempts ?? 0} 次；关闭不受限制`;
}

function webSearchControlError(value: unknown): string {
  return value instanceof Error ? value.message : 'Web Search 控制失败，请稍后重试。';
}

function emptyWebSearchProbeState(): NonNullable<AiTeacherProviderStatusResponse['capabilities'][number]['probe']> {
  return {
    policyEnabled: true,
    status: 'not_checked',
    inProgress: false,
    attemptCount: 0,
    cooldownScheduleSeconds: [],
    resetAfterSeconds: 0,
    hourlyLimit: 0,
    remainingHourlyAttempts: 0,
    retryAfterMs: 0,
    durationMs: 0,
    sourceCount: 0,
    searchRequestCount: 0
  };
}

function syncTriggerLabel(value?: string): string {
  return ({ startup: '启动', scheduled: '定时', manual: '手动' } as Record<string, string>)[String(value || '')] || value || '-';
}

function syncOutcomeLabel(value?: string): string {
  return ({ success: '成功', partial: '部分成功', failed: '失败', in_progress: '进行中' } as Record<string, string>)[String(value || '')] || value || '-';
}

function statusLabel(status = ''): string {
  const labels: Record<string, string> = {
    enabled: '前端可见',
    active: '前端可见',
    disabled: '已停用',
    archived: '已归档',
    deleted: '已删除',
    healthy: '正常',
    configured: '已配置',
    ready: '已就绪',
    missing: '缺失',
    optional: '可选',
    available: '可用',
    unknown: '未知',
    unavailable: '不可用',
    not_configured: '未配置',
    operational: '正常',
    degraded: '性能下降',
    pending: '待验证',
    incident: '故障',
    not_available: '无官方订阅',
    fresh: '已同步',
    stale: '缓存过期'
  };
  return labels[status] || status || '未知';
}

function secretRoleLabel(role = ''): string {
  const labels: Record<string, string> = {
    api_key: '模型 API Key',
    api_base: '模型 API Base',
    master_key: 'LiteLLM Master Key',
    database_url: 'LiteLLM DB'
  };
  return labels[role] || role || 'env';
}

function sourceLabel(source = ''): string {
  if (source === 'uploaded') return '上传';
  if (source === 'bundled') return '内置';
  if (source === 'pending') return '待确认';
  return source || 'registry';
}

function shortHash(value = ''): string {
  return value ? value.slice(0, 12) : '-';
}

function shortId(value = ''): string {
  return value ? value.slice(0, 10) : '-';
}

function numberFromInput(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/* Legacy schema-v1 projection helpers retained temporarily for migration reference.
function modelAccessFormFromVersion(version?: AiTeacherLiteLlmConfigVersion): AiTeacherModelAccessForm {
  const group = version?.config?.modelGroups?.[0];
  const deployment = group?.deployments?.[0];
  const router = group?.router || { routingStrategy: 'simple-shuffle', numRetries: 1, allowedFails: 5, cooldownTime: 30 };
  return {
    modelName: group?.modelName || 'ai-teacher-reasoning',
    deploymentId: deployment?.deploymentId || 'deepseek-reasoning-primary',
    enabled: deployment?.enabled !== false,
    provider: deployment?.provider || 'deepseek',
    model: deployment?.model || 'deepseek/deepseek-v4-flash',
    apiBaseEnv: deployment?.apiBaseEnv || 'DEEPSEEK_API_BASE',
    apiKeyRef: deployment?.apiKeyRef || 'DEEPSEEK_API_KEY_1',
    rpm: Number(deployment?.rpm || 60),
    tpm: Number(deployment?.tpm || 120000),
    maxParallelRequests: Number(deployment?.maxParallelRequests || 0),
    routingStrategy: router.routingStrategy || 'simple-shuffle',
    numRetries: Number(router.numRetries ?? 1),
    allowedFails: Number(router.allowedFails ?? 5),
    cooldownTime: Number(router.cooldownTime ?? 30),
    notes: ''
  };
}

function modelAccessConfigFromForm(form: AiTeacherModelAccessForm): AiTeacherLiteLlmConfig {
  return {
    schemaVersion: 1,
    modelGroups: [{
      modelName: form.modelName.trim() || 'ai-teacher-reasoning',
      deployments: [{
        deploymentId: form.deploymentId.trim() || 'primary',
        enabled: form.enabled,
        provider: form.provider.trim() || 'deepseek',
        model: form.model.trim(),
        apiBaseEnv: form.apiBaseEnv.trim(),
        apiKeyRef: form.apiKeyRef.trim(),
        rpm: numberFromInput(String(form.rpm)),
        tpm: numberFromInput(String(form.tpm)),
        maxParallelRequests: numberFromInput(String(form.maxParallelRequests))
      }],
      router: {
        routingStrategy: form.routingStrategy,
        numRetries: numberFromInput(String(form.numRetries)),
        allowedFails: numberFromInput(String(form.allowedFails)),
        cooldownTime: numberFromInput(String(form.cooldownTime))
      },
      fallbacks: []
    }],
    general: {
      masterKeyEnv: 'LITELLM_MASTER_KEY',
      databaseUrlEnv: 'LITELLM_DATABASE_URL'
    }
  };
}
*/

function emptyTierPolicyDraft(): AiTeacherTierPolicyDraft {
  return { enabled: false, dailyTokenLimit: 0, weeklyTokenLimit: 0 };
}

function tierPolicyDraftFromResponse(response?: AiTeacherTierPoliciesResponse): Record<string, AiTeacherTierPolicyDraft> {
  const result: Record<string, AiTeacherTierPolicyDraft> = {
    guest: emptyTierPolicyDraft(),
    free: emptyTierPolicyDraft(),
    plus: { enabled: true, dailyTokenLimit: 100000, weeklyTokenLimit: 500000 }
  };
  for (const tier of ['guest', 'free', 'plus']) {
    const policy = response?.policies?.[tier];
    if (!policy) continue;
    result[tier] = {
      enabled: Boolean(policy.enabled),
      dailyTokenLimit: Number(policy.dailyTokenLimit || 0),
      weeklyTokenLimit: Number(policy.weeklyTokenLimit || 0)
    };
  }
  return result;
}

function formatDateTime(value = ''): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatAccountDateTime(value = ''): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatActiveDuration(value: unknown): string {
  const totalMinutes = Math.max(0, Math.floor(Number(value || 0) / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return `${days}:${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function StatusPill({ status, label }: { status: string; label?: string }) {
  const normalized = String(status || 'unknown').toLowerCase();
  return <span className="packStatusPill" data-status={normalized}>{label || statusLabel(normalized)}</span>;
}

function HelpTip({ text }: { text: string }) {
  return (
    <span
      className="aiTeacherHelpTip"
      data-help={text}
      tabIndex={0}
      aria-label={text}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Info size={13} aria-hidden="true" />
    </span>
  );
}

function formatNumber(value: unknown): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat('zh-CN').format(Math.floor(number));
}

function formatPercent(value: unknown): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0%';
  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1
  }).format(Math.max(0, Math.min(1, number)));
}

function formatCurrency(value: unknown, currency = 'USD'): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 4
  }).format(number);
}

function formatTokenLimit(value: unknown): string {
  const number = Number(value || 0);
  return number > 0 ? `${formatNumber(number)} tokens` : '不开放';
}

function formatUsageLimit(used: number, limit: number, remaining: number | null): string {
  const usedText = formatNumber(used);
  if (!limit) return `${usedText} / 未设上限`;
  const remainingText = remaining === null ? '-' : formatNumber(remaining);
  return `${usedText} / ${formatNumber(limit)}，剩余 ${remainingText}`;
}

function tierPolicyDescription(tier: string): string {
  const descriptions: Record<string, string> = {
    guest: '游客默认不开放 AI Teacher',
    free: '普通账号默认不开放，可后续启用试用',
    plus: 'Plus 账号默认开放日/周配额'
  };
  return descriptions[tier] || '自定义等级';
}
