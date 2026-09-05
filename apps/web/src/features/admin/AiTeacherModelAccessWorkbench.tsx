import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CloudCog,
  Diff,
  Eye,
  KeyRound,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppApiClient } from '../../app/use-api-client';
import { ErrorState, LoadingState } from '../shared/ui';

const MODEL_ADMIN_REFRESH_MS = 30_000;

type Domain = 'connections' | 'deployments' | 'aliases';
type Selection = { domain: Domain; id: string };

type Endpoint = {
  scheme: 'https' | 'http';
  host: string;
  port: number;
  basePath: string;
};

type ProviderConnection = {
  connectionId: string;
  displayName: string;
  enabled: boolean;
  adapterProfileId: string;
  adapterProfileRevision: number;
  endpoint: Endpoint;
  apiBaseEnv?: string;
  networkZone: 'public_provider' | 'approved_private' | 'local_development';
  credentialRef: { kind: 'environment' | 'secret_manager' | 'litellm_credential'; referenceName: string };
  tlsPolicy: 'verify_full' | 'private_ca';
  metadata: { owner: string; purpose: string };
};

type ModelDeployment = {
  deploymentId: string;
  connectionId: string;
  displayName: string;
  providerModelId: string;
  enabled: boolean;
  limits: { rpm: number; tpm: number; maxParallelRequests: number };
  declaredCapabilities: {
    contextWindowTokens: number;
    maxOutputTokens: number;
    supportsStreaming: boolean;
    supportsToolCalling: boolean;
    supportsThinking: boolean;
    supportsThinkingWithTools: boolean;
    supportsStructuredOutput: boolean;
    reportsUsage: boolean;
  };
};

type BusinessModelAlias = {
  aliasId: string;
  litellmAlias: string;
  displayName: string;
  enabled: boolean;
  members: Array<{ deploymentId: string; priority: number; weight: number }>;
  routing: {
    strategy: 'simple-shuffle' | 'least-busy' | 'usage-based-routing' | 'latency-based-routing';
    numRetries: number;
    allowedFails: number;
    cooldownTimeSeconds: number;
  };
};

type ControlPlaneConfig = {
  schemaVersion: 2;
  providerConnections: ProviderConnection[];
  modelDeployments: ModelDeployment[];
  businessModelAliases: BusinessModelAlias[];
  general: { masterKeyEnv: string; databaseUrlEnv: string };
};

type LegacyDeployment = {
  deploymentId: string;
  enabled: boolean;
  provider: string;
  model: string;
  apiBase?: string;
  apiBaseEnv?: string;
  apiKeyRef: string;
  litellmCredentialName?: string;
  rpm: number;
  tpm: number;
  maxParallelRequests: number;
};

type LiteLlmVersion = {
  versionId: string;
  status: string;
  checksum: string;
  config: Partial<ControlPlaneConfig> & {
    schemaVersion: number;
    modelGroups?: Array<{
      modelName: string;
      deployments: LegacyDeployment[];
      router: { routingStrategy: BusinessModelAlias['routing']['strategy']; numRetries: number; allowedFails: number; cooldownTime: number };
    }>;
    general: { masterKeyEnv: string; databaseUrlEnv: string };
  };
  validation?: { ok?: boolean; errors?: string[]; checksum?: string };
  createdAt?: string | null;
  publishedAt?: string | null;
};

type ActiveResponse = { version: LiteLlmVersion };
type VersionsResponse = { versions: LiteLlmVersion[] };
type HealthResponse = {
  checkedAt?: string;
  configured: boolean;
  baseUrl?: string;
  status: string;
  httpStatus?: number;
  error?: string;
  secrets?: Array<{ envName: string; referenceName?: string; kind?: string; role: string; required: boolean; present: boolean }>;
  activeVersion?: { versionId: string; checksum: string } | null;
};

type PublishResponse = {
  version: LiteLlmVersion;
  preflight?: { ok: boolean; secrets?: HealthResponse['secrets'] };
  apply: { applied: boolean; status: string; message?: string; httpStatus?: number };
  health?: HealthResponse;
  resourcePolicyAdvisory?: {
    status: 'ready' | 'migration_required' | 'not_configured' | 'unavailable';
    required: boolean;
    policyVersionId: string;
    missingAliases: string[];
    references: Array<{ key: string; alias: string }>;
  };
};

type ProbeResponse = {
  status: 'passed' | 'failed' | 'blocked';
  checkedAt: string;
  durationMs: number;
  httpStatus?: number;
  checks: Array<{ id: string; label: string; status: 'passed' | 'failed' | 'blocked'; durationMs?: number }>;
  errorCode?: string;
  message?: string;
};

type AdapterProfile = {
  profileId: string;
  revision: number;
  displayName: string;
  gatewayProtocol: string;
  litellmProviderPrefix?: string;
  supportedCapabilities: string[];
};

type AdapterCatalogResponse = { schemaVersion: number; profiles: AdapterProfile[] };
type ManagedCredential = { credentialName: string; provider: string; configured: boolean; rotatedAt?: string | null };
type ManagedCredentialsResponse = { credentials: ManagedCredential[] };
type CredentialDialogState = { mode: 'create' | 'rotate'; credentialName: string; provider: string };
type ConnectionProbeNoticeState = { connectionId: string; connectionName: string };

type CapabilityProbeResult = {
  status: 'passed' | 'failed' | 'blocked' | 'inconclusive' | 'not_declared' | 'not_run';
  errorCode?: string;
  httpStatus?: number;
  durationMs?: number;
};

type DeploymentCapabilityEvidence = {
  deploymentId: string;
  displayName: string;
  providerModelId: string;
  enabled: boolean;
  status: 'passed' | 'failed' | 'blocked' | 'inconclusive' | 'unverified' | 'disabled';
  readiness: string;
  ready: boolean;
  declaredCount: number;
  passedCount: number;
  results: Record<string, CapabilityProbeResult>;
  latestRun?: {
    completedAt?: string;
    durationMs?: number;
    errorCode?: string;
    usage?: { providerCalls?: number; totalTokens?: number };
  } | null;
};

type CapabilityEvidenceResponse = {
  versionId: string;
  configChecksum: string;
  required: boolean;
  ready: boolean;
  enabledDeploymentCount: number;
  readyDeploymentCount: number;
  budget: { maxProviderCalls: number; maxTotalOutputTokens: number; maxDurationMs: number };
  deployments: DeploymentCapabilityEvidence[];
};

export function AiTeacherModelAccessWorkbench({ onOpenResourcePolicy }: { onOpenResourcePolicy?: () => void }) {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const activeQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'litellm', 'active'],
    queryFn: () => api.request<ActiveResponse>('/api/admin/ai-teacher/litellm/config-versions/active'),
    refetchInterval: MODEL_ADMIN_REFRESH_MS
  });
  const versionsQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'litellm', 'versions'],
    queryFn: () => api.request<VersionsResponse>('/api/admin/ai-teacher/litellm/config-versions?limit=50'),
    refetchInterval: MODEL_ADMIN_REFRESH_MS
  });
  const healthQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'litellm', 'health'],
    queryFn: () => api.request<HealthResponse>('/api/admin/ai-teacher/litellm/health'),
    refetchInterval: MODEL_ADMIN_REFRESH_MS
  });
  const catalogQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'llm-control-plane', 'catalog'],
    queryFn: () => api.request<AdapterCatalogResponse>('/api/admin/ai-teacher/llm-control-plane/catalog'),
    staleTime: 5 * 60_000
  });
  const credentialsQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'llm-control-plane', 'credentials'],
    queryFn: () => api.request<ManagedCredentialsResponse>('/api/admin/ai-teacher/llm-control-plane/credentials'),
    refetchInterval: MODEL_ADMIN_REFRESH_MS
  });
  const [draft, setDraft] = useState<ControlPlaneConfig | null>(null);
  const [baseline, setBaseline] = useState<ControlPlaneConfig | null>(null);
  const [savedDraftVersion, setSavedDraftVersion] = useState<LiteLlmVersion | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [search, setSearch] = useState('');
  const [editorTab, setEditorTab] = useState<'basic' | 'network' | 'dependencies' | 'history'>('basic');
  const [publishResult, setPublishResult] = useState<PublishResponse | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [credentialDialog, setCredentialDialog] = useState<CredentialDialogState | null>(null);
  const [credentialSecret, setCredentialSecret] = useState('');
  const [connectionProbeNotice, setConnectionProbeNotice] = useState<ConnectionProbeNoticeState | null>(null);
  const adapterProfiles = catalogQuery.data?.profiles || [];
  const latestDraftVersion = useMemo(() => {
    const activePublishedAt = Date.parse(activeQuery.data?.version?.publishedAt || '') || 0;
    return (versionsQuery.data?.versions || [])
      .filter((version) => version.status === 'draft' && (Date.parse(version.createdAt || '') || 0) > activePublishedAt)
      .sort((left, right) => (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0))[0] || null;
  }, [activeQuery.data?.version?.publishedAt, versionsQuery.data?.versions]);
  const desiredVersion = savedDraftVersion || latestDraftVersion || activeQuery.data?.version || null;
  const capabilityQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'llm-control-plane', 'capability-probes', desiredVersion?.versionId],
    queryFn: () => api.request<CapabilityEvidenceResponse>(`/api/admin/ai-teacher/llm-control-plane/capability-probes?versionId=${encodeURIComponent(desiredVersion?.versionId || '')}`),
    enabled: Boolean(desiredVersion?.versionId),
    refetchInterval: MODEL_ADMIN_REFRESH_MS
  });

  useEffect(() => {
    if (!desiredVersion) return;
    const next = controlPlaneFromVersion(desiredVersion, healthQuery.data);
    setDraft(next);
    setBaseline(next);
    setSelection((current) => current && selectionExists(next, current)
      ? current
      : { domain: 'connections', id: next.providerConnections[0]?.connectionId || '' });
  }, [desiredVersion?.versionId, desiredVersion?.status, desiredVersion?.checksum]);

  const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));
  const activeConfig = useMemo(() => activeQuery.data?.version ? controlPlaneFromVersion(activeQuery.data.version, healthQuery.data) : null, [activeQuery.data?.version?.versionId, activeQuery.data?.version?.checksum]);
  const releaseChangeCount = draft && (dirty || desiredVersion?.status === 'draft') ? draftChangeCount(activeConfig, draft) : 0;
  const hasPublishCandidate = releaseChangeCount > 0 && (dirty || desiredVersion?.status === 'draft');
  const validation = useMemo(() => validateDraft(draft, adapterProfiles), [draft, adapterProfiles]);
  const selectedConnection = selection?.domain === 'connections'
    ? draft?.providerConnections.find((item) => item.connectionId === selection.id)
    : null;
  const selectedDeployment = selection?.domain === 'deployments'
    ? draft?.modelDeployments.find((item) => item.deploymentId === selection.id)
    : null;
  const selectedAlias = selection?.domain === 'aliases'
    ? draft?.businessModelAliases.find((item) => item.aliasId === selection.id)
    : null;
  const selectedObject = selectedConnection || selectedDeployment || selectedAlias;
  const capabilityEvidence = capabilityQuery.data;
  const selectedDeploymentEvidence = selectedDeployment
    ? capabilityEvidence?.deployments.find((item) => item.deploymentId === selectedDeployment.deploymentId)
    : undefined;

  const saveDraftMutation = useMutation({
    mutationFn: async (notes: string) => {
      if (!draft) throw new Error('没有可保存的模型接入配置。');
      return api.request<ActiveResponse>('/api/admin/ai-teacher/litellm/config-versions', {
        method: 'POST',
        body: { config: draft, notes }
      });
    },
    onSuccess: (result) => {
      const saved = controlPlaneFromVersion(result.version, healthQuery.data);
      setSavedDraftVersion(result.version);
      setDraft(saved);
      setBaseline(saved);
      setSelection((current) => current && selectionExists(saved, current)
        ? current
        : selectionAfterServerIdAssignment(current, saved));
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'litellm', 'versions'] });
    }
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('没有可发布的模型接入配置。');
      const created = dirty
        ? await api.request<ActiveResponse>('/api/admin/ai-teacher/litellm/config-versions', {
          method: 'POST',
          body: { config: draft, notes: `管理页面发布：${releaseChangeCount} 项变更` }
        })
        : desiredVersion?.status === 'draft' ? { version: desiredVersion } : null;
      if (!created?.version) throw new Error('没有已保存的待发布草稿。');
      return api.request<PublishResponse>(
        `/api/admin/ai-teacher/litellm/config-versions/${encodeURIComponent(created.version.versionId)}/publish`,
        { method: 'POST' }
      );
    },
    onSuccess: (result) => {
      const active = controlPlaneFromVersion(result.version, healthQuery.data);
      setPublishResult(result);
      setSavedDraftVersion(null);
      setDraft(active);
      setBaseline(active);
      setReleaseOpen(false);
      queryClient.setQueryData(['admin', 'ai-teacher', 'litellm', 'active'], { version: result.version });
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher'] });
    }
  });

  const probeMutation = useMutation({
    mutationFn: async ({ connection, providerModelId }: { connection: ProviderConnection; providerModelId: string }) => {
      return api.request<ProbeResponse>('/api/admin/ai-teacher/llm-control-plane/probe-connection', {
        method: 'POST',
        body: { connection, providerModelId }
      });
    },
    onSuccess: setProbeResult
  });

  const credentialWriteMutation = useMutation({
    mutationFn: async () => {
      if (!credentialDialog) throw new Error('凭据编辑状态不存在。');
      const path = credentialDialog.mode === 'create'
        ? '/api/admin/ai-teacher/llm-control-plane/credentials'
        : `/api/admin/ai-teacher/llm-control-plane/credentials/${encodeURIComponent(credentialDialog.credentialName)}`;
      return api.request<{ credential: ManagedCredential }>(path, {
        method: credentialDialog.mode === 'create' ? 'POST' : 'PATCH',
        body: {
          credentialName: credentialDialog.credentialName,
          provider: credentialDialog.provider,
          apiKey: credentialSecret,
          confirmation: { confirmed: true, credentialName: credentialDialog.credentialName }
        }
      });
    },
    onSuccess: (result) => {
      if (draft && selectedConnection) {
        updateConnection(draft, { ...selectedConnection, credentialRef: { kind: 'litellm_credential', referenceName: result.credential.credentialName } }, setDraft);
      }
      setCredentialSecret('');
      setCredentialDialog(null);
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'llm-control-plane', 'credentials'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'litellm', 'health'] });
    }
  });

  const credentialDeleteMutation = useMutation({
    mutationFn: async (credentialName: string) => api.request(`/api/admin/ai-teacher/llm-control-plane/credentials/${encodeURIComponent(credentialName)}`, {
      method: 'DELETE',
      body: { confirmation: { confirmed: true, credentialName } }
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'llm-control-plane', 'credentials'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'litellm', 'health'] });
    }
  });

  const capabilityProbeMutation = useMutation({
    mutationFn: async (deployment: ModelDeployment) => {
      if (!desiredVersion?.versionId || dirty) throw new Error('请先保存当前草稿，再执行能力验证。');
      return api.request<{ evidence: CapabilityEvidenceResponse }>('/api/admin/ai-teacher/llm-control-plane/capability-probes', {
        method: 'POST',
        body: {
          versionId: desiredVersion.versionId,
          deploymentId: deployment.deploymentId,
          confirmation: { confirmed: true, maxProviderCalls: 8, maxTotalOutputTokens: 832, maxDurationMs: 90_000 }
        }
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(['admin', 'ai-teacher', 'llm-control-plane', 'capability-probes', desiredVersion?.versionId], result.evidence);
    }
  });

  if (activeQuery.isLoading || versionsQuery.isLoading || healthQuery.isLoading || catalogQuery.isLoading || credentialsQuery.isLoading) return <LoadingState label="正在加载 LLM 服务控制面" />;
  if (activeQuery.error) return <ErrorState title="模型接入配置加载失败" error={activeQuery.error} />;
  if (versionsQuery.error) return <ErrorState title="模型接入草稿加载失败" error={versionsQuery.error} />;
  if (healthQuery.error) return <ErrorState title="LiteLLM 状态加载失败" error={healthQuery.error} />;
  if (catalogQuery.error) return <ErrorState title="Adapter Profile 目录加载失败" error={catalogQuery.error} />;
  if (credentialsQuery.error) return <ErrorState title="托管凭据目录加载失败" error={credentialsQuery.error} />;
  if (!draft || !baseline) return <ErrorState title="模型接入配置为空" error={new Error('未读取到可管理的 active 配置。')} />;

  const dependentDeployments = selectedConnection
    ? draft.modelDeployments.filter((item) => item.connectionId === selectedConnection.connectionId)
    : [];
  const dependentAliases = selectedDeployment
    ? draft.businessModelAliases.filter((alias) => alias.members.some((member) => member.deploymentId === selectedDeployment.deploymentId))
    : [];
  const selectedAliasDeployments = selectedAlias
    ? selectedAlias.members.map((member) => draft.modelDeployments.find((item) => item.deploymentId === member.deploymentId)).filter(Boolean) as ModelDeployment[]
    : [];
  const impactedDeployments = selectedConnection ? dependentDeployments.length : selectedDeployment ? 1 : selectedAliasDeployments.length;
  const impactedAliases = selectedConnection
    ? draft.businessModelAliases.filter((alias) => alias.members.some((member) => dependentDeployments.some((deployment) => deployment.deploymentId === member.deploymentId))).length
    : selectedDeployment ? dependentAliases.length : selectedAlias ? 1 : 0;

  const saveDraft = () => saveDraftMutation.mutate(`管理页面草稿：${selectedObject?.displayName || '模型接入配置'}`);
  const startConnectionProbe = () => {
    if (!selectedConnection || probeMutation.isPending) return;
    const deployment = preferredProbeDeployment(draft.modelDeployments, selectedConnection.connectionId);
    if (!deployment) {
      setConnectionProbeNotice({ connectionId: selectedConnection.connectionId, connectionName: selectedConnection.displayName });
      return;
    }
    setProbeResult(null);
    probeMutation.mutate({ connection: selectedConnection, providerModelId: deployment.providerModelId.trim() });
  };
  const confirmCapabilityProbe = () => {
    if (!selectedDeployment || dirty || capabilityProbeMutation.isPending) return;
    const confirmed = window.confirm('将调用真实模型执行能力验证。上限：8 次 Provider 请求、832 个输出 Token、90 秒；会产生 Provider 费用。固定测试不包含课程或学生数据。确认继续？');
    if (confirmed) capabilityProbeMutation.mutate(selectedDeployment);
  };
  const confirmPublish = () => {
    if (!validation.ok || dirty || !hasPublishCandidate || !capabilityEvidence?.ready || publishMutation.isPending) return;
    if (window.confirm(`将已保存草稿中的 ${releaseChangeCount} 项模型接入变更发布到 LiteLLM。发布前会校验能力证据、Secret、Apply 和健康门禁。确认继续？`)) {
      publishMutation.mutate();
    }
  };
  const deleteSelectedConnection = () => {
    if (!selectedConnection || dependentDeployments.length) return;
    if (!window.confirm(`删除连接“${selectedConnection.displayName}”？该操作只会写入当前草稿，保存并发布配置版本后才会影响运行态。`)) return;
    const remainingConnections = draft.providerConnections.filter((item) => item.connectionId !== selectedConnection.connectionId);
    setDraft({ ...draft, providerConnections: remainingConnections });
    setSelection(remainingConnections[0] ? { domain: 'connections', id: remainingConnections[0].connectionId } : null);
    setProbeResult(null);
  };
  const openCredentialDialog = (mode: 'create' | 'rotate') => {
    if (!selectedConnection) return;
    const profile = adapterProfiles.find((item) => item.profileId === selectedConnection.adapterProfileId);
    const existingName = selectedConnection.credentialRef.kind === 'litellm_credential' ? selectedConnection.credentialRef.referenceName : '';
    setCredentialSecret('');
    setCredentialDialog({
      mode,
      credentialName: mode === 'rotate' ? existingName : suggestedCredentialName(selectedConnection.displayName),
      provider: profile?.litellmProviderPrefix || 'openai'
    });
  };
  const deleteSelectedCredential = () => {
    const name = selectedConnection?.credentialRef.kind === 'litellm_credential' ? selectedConnection.credentialRef.referenceName : '';
    if (!name || credentialDeleteMutation.isPending) return;
    if (window.confirm(`删除托管凭据“${name}”？只有未被 active 或草稿配置引用的凭据才能删除。`)) credentialDeleteMutation.mutate(name);
  };

  return (
    <section className="llmControlPlane" data-ai-teacher-models data-llm-control-plane>
      <header className="llmControlPlaneHeader">
        <div>
          <span className="missionEyebrow">LLM Service Control Plane</span>
          <h2>模型接入管理</h2>
          <p>以连接、部署和业务模型别名三类对象治理真实 Provider，并由平台控制发布与回滚。</p>
        </div>
        <div className="llmControlPlaneHeaderActions">
          <button type="button" className="secondaryAction" onClick={() => addConnection(draft, setDraft, setSelection)}><Plus size={14} />新建连接</button>
          <button type="button" className="primaryAction" disabled={!hasPublishCandidate || !validation.ok} onClick={() => setReleaseOpen(true)}><Rocket size={14} />发布配置版本{releaseChangeCount ? ` (${releaseChangeCount})` : ''}</button>
        </div>
      </header>

      {publishResult?.resourcePolicyAdvisory?.required ? (
        <div className="llmResourcePolicyAdvisory" role="status" data-resource-policy-migration-advisory>
          <CircleAlert size={17} />
          <div>
            <strong>LiteLLM 配置已发布，但 Agent 资源门禁需要重新配置。</strong>
            <span>{publishResult.resourcePolicyAdvisory.references.length} 个阶段路由仍引用已删除的 Alias：{publishResult.resourcePolicyAdvisory.missingAliases.join('、')}。发布未被阻断；请重新选择当前注册 Alias 并发布新的资源策略。</span>
          </div>
          {onOpenResourcePolicy ? <button type="button" onClick={onOpenResourcePolicy}>进入资源门禁</button> : null}
        </div>
      ) : null}

      <ControlPlaneStateStrip activeVersion={activeQuery.data?.version} desiredVersion={desiredVersion || undefined} health={healthQuery.data} catalog={catalogQuery.data} dirty={dirty} />

      <div className="llmControlPlaneWorkbench">
        <ObjectRail
          config={draft}
          selection={selection}
          search={search}
          capabilityEvidence={capabilityEvidence}
          onSearch={setSearch}
          onSelect={(next) => { setSelection(next); setEditorTab('basic'); setProbeResult(null); }}
          onAdd={(domain) => addObject(domain, draft, setDraft, setSelection)}
        />

        <main className="llmObjectEditor">
          {!selection || !selectedObject ? (
            <div className="llmEmptyState"><CloudCog size={28} /><h3>选择一个模型接入对象</h3><p>从左侧连接、部署或业务别名开始编辑。</p></div>
          ) : (
            <>
              <ObjectEditorHeader
                selection={selection}
                object={selectedObject}
                capabilityEvidence={capabilityEvidence}
                onDelete={selectedConnection ? deleteSelectedConnection : undefined}
                deleteDisabledReason={selectedConnection && dependentDeployments.length ? `被 ${dependentDeployments.length} 个 Deployment 引用，不能删除` : ''}
              />
              <nav className="llmEditorTabs" aria-label="对象编辑分区">
                {([['basic', '基本配置'], ['network', '网络与凭据'], ['dependencies', '依赖关系'], ['history', '变更历史']] as const).map(([id, label]) => (
                  <button type="button" className={editorTab === id ? 'isActive' : ''} key={id} onClick={() => setEditorTab(id)}>{label}</button>
                ))}
              </nav>
              <div className="llmEditorBody">
                {editorTab === 'basic' && selectedConnection ? <ConnectionEditor connection={selectedConnection} profiles={adapterProfiles} credentials={credentialsQuery.data?.credentials || []} credentialError={credentialDeleteMutation.error} onOpenCredential={openCredentialDialog} onDeleteCredential={deleteSelectedCredential} onChange={(next) => updateConnection(draft, next, setDraft)} /> : null}
                {editorTab === 'basic' && selectedDeployment ? <DeploymentEditor deployment={selectedDeployment} config={draft} onChange={(next) => updateDeployment(draft, next, setDraft)} /> : null}
                {editorTab === 'basic' && selectedAlias ? <AliasEditor alias={selectedAlias} config={draft} onChange={(next) => updateAlias(draft, next, setDraft)} /> : null}
                {editorTab === 'network' ? <NetworkCredentialView selection={selection} config={draft} health={healthQuery.data} /> : null}
                {editorTab === 'dependencies' ? <DependencyView selection={selection} config={draft} /> : null}
                {editorTab === 'history' ? <HistoryView version={activeQuery.data?.version} publishResult={publishResult} /> : null}
              </div>
              <footer className="llmEditorFooter">
                <div>
                  {dirty ? <span className="llmUnsaved"><CircleAlert size={14} />存在未保存变更</span> : desiredVersion?.status === 'draft' ? <span className="llmSaved"><Check size={14} />草稿已保存，待验证与发布</span> : <span className="llmSaved"><Check size={14} />与 active 版本一致</span>}
                   <small>托管凭据写入后不可读；配置版本、页面和日志只保存引用名。</small>
                </div>
                <div className="llmEditorActions">
                  <button type="button" disabled={!dirty || saveDraftMutation.isPending} onClick={saveDraft}><Save size={14} />{saveDraftMutation.isPending ? '保存中' : '保存草稿'}</button>
                  {selectedConnection ? <button type="button" className="primaryAction" data-connection-probe-action disabled={probeMutation.isPending} onClick={startConnectionProbe}><Activity size={14} />{probeMutation.isPending ? '测试中' : '连接测试'}</button> : null}
                  {selectedDeployment ? <button type="button" className="primaryAction" disabled={dirty || capabilityProbeMutation.isPending} onClick={confirmCapabilityProbe}><Eye size={14} />{capabilityProbeMutation.isPending ? '验证中' : '运行能力验证'}</button> : null}
                </div>
              </footer>
            </>
          )}
        </main>

        <EvidenceRail
          validation={validation}
          probe={probeResult}
          probeError={probeMutation.error}
          capabilityEvidence={capabilityEvidence}
          selectedDeploymentEvidence={selectedDeploymentEvidence}
          capabilityError={capabilityQuery.error || capabilityProbeMutation.error}
          health={healthQuery.data}
          impactedDeployments={impactedDeployments}
          impactedAliases={impactedAliases}
          hasPublishCandidate={hasPublishCandidate}
          onOpenRelease={() => setReleaseOpen(true)}
        />
      </div>

      <LifecycleBar health={healthQuery.data} dirty={dirty} capabilityReady={Boolean(capabilityEvidence?.ready)} publishing={publishMutation.isPending} published={Boolean(publishResult)} />

      {releaseOpen ? (
        <ReleaseWorkspace
          changeCount={releaseChangeCount}
          validation={validation}
          dirty={dirty}
          hasPublishCandidate={hasPublishCandidate}
          capabilityEvidence={capabilityEvidence}
          health={healthQuery.data}
          publishError={publishMutation.error}
          publishing={publishMutation.isPending}
          onClose={() => setReleaseOpen(false)}
          onPublish={confirmPublish}
        />
      ) : null}
      {credentialDialog ? <CredentialDialog
        state={credentialDialog}
        secret={credentialSecret}
        error={credentialWriteMutation.error}
        saving={credentialWriteMutation.isPending}
        onStateChange={setCredentialDialog}
        onSecretChange={setCredentialSecret}
        onClose={() => { setCredentialSecret(''); setCredentialDialog(null); }}
        onSave={() => credentialWriteMutation.mutate()}
      /> : null}
      {connectionProbeNotice ? <ConnectionProbeNotice
        state={connectionProbeNotice}
        onClose={() => setConnectionProbeNotice(null)}
        onCreateDeployment={() => {
          createDeploymentForConnection(draft, connectionProbeNotice.connectionId, setDraft, setSelection);
          setConnectionProbeNotice(null);
        }}
      /> : null}
    </section>
  );
}

function ControlPlaneStateStrip({ activeVersion, desiredVersion, health, catalog, dirty }: { activeVersion?: LiteLlmVersion; desiredVersion?: LiteLlmVersion; health?: HealthResponse; catalog?: AdapterCatalogResponse; dirty: boolean }) {
  const activeLabel = shortVersion(activeVersion?.versionId);
  const desiredLabel = dirty ? 'unsaved' : shortVersion(desiredVersion?.versionId);
  const observedMatches = health?.status === 'healthy' && health.activeVersion?.checksum === activeVersion?.checksum;
  return (
    <div className="llmStateStrip" aria-label="控制面状态">
      <span><Check size={13} />Desired <strong>{desiredLabel}</strong></span>
      <span><Check size={13} />Applied <strong>{activeLabel}</strong></span>
      <span className={observedMatches ? '' : 'isWarning'}>{observedMatches ? <Check size={13} /> : <CircleAlert size={13} />}Observed <strong>{observedMatches ? activeLabel : 'drift'}</strong></span>
      <span><Network size={13} />Registry revision <strong>catalog v{catalog?.schemaVersion || '—'}</strong></span>
      <span className="llmStateStripTime">最后同步 {formatDateTime(health?.checkedAt || '')}</span>
    </div>
  );
}

function ObjectRail({ config, selection, search, capabilityEvidence, onSearch, onSelect, onAdd }: {
  config: ControlPlaneConfig;
  selection: Selection | null;
  search: string;
  capabilityEvidence?: CapabilityEvidenceResponse;
  onSearch: (value: string) => void;
  onSelect: (selection: Selection) => void;
  onAdd: (domain: Domain) => void;
}) {
  const query = search.trim().toLowerCase();
  const groups = [
    { domain: 'connections' as const, label: 'Provider Connections', labelZh: '连接', icon: Link2, items: config.providerConnections },
    { domain: 'deployments' as const, label: 'Model Deployments', labelZh: '部署', icon: Box, items: config.modelDeployments },
    { domain: 'aliases' as const, label: 'Business Model Aliases', labelZh: '业务模型别名', icon: KeyRound, items: config.businessModelAliases }
  ];
  return (
    <aside className="llmObjectRail">
      <header><div><h3>模型接入对象</h3><span>{config.providerConnections.length + config.modelDeployments.length + config.businessModelAliases.length} 个对象</span></div><RefreshCw size={15} /></header>
      <label className="llmObjectSearch"><Search size={14} /><input aria-label="搜索模型接入对象" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索名称或 ID" /></label>
      <div className="llmObjectGroups">
        {groups.map((group) => {
          const visibleItems = group.items.filter((item) => `${item.displayName} ${objectId(group.domain, item)}`.toLowerCase().includes(query));
          const Icon = group.icon;
          return (
            <section className="llmObjectGroup" data-llm-object-domain-frame={group.domain} key={group.domain}>
              <header><span><Icon size={15} /><strong>{group.label}</strong><em>{group.items.length}</em></span><button type="button" aria-label={`新建${group.labelZh}`} onClick={() => onAdd(group.domain)}><Plus size={13} /></button></header>
              <div>
                {visibleItems.map((rawItem) => {
                  const item = rawItem as ProviderConnection | ModelDeployment | BusinessModelAlias;
                  const id = objectId(group.domain, item);
                  const active = selection?.domain === group.domain && selection.id === id;
                  const subtitle = group.domain === 'connections'
                    ? (item as ProviderConnection).adapterProfileId
                    : group.domain === 'deployments' ? (item as ModelDeployment).providerModelId : (item as BusinessModelAlias).litellmAlias;
                  return <button type="button" className={active ? 'isActive' : ''} data-object-domain={group.domain} data-object-id={id} key={id} onClick={() => onSelect({ domain: group.domain, id })}><span><strong>{item.displayName}</strong><small>{subtitle}</small></span><StatePill status={objectCapabilityStatus(group.domain, item, capabilityEvidence)} /></button>;
                })}
                {!visibleItems.length ? <p>没有匹配对象</p> : null}
              </div>
            </section>
          );
        })}
      </div>
      <footer>3 个领域 · {config.providerConnections.length + config.modelDeployments.length + config.businessModelAliases.length} 个对象</footer>
    </aside>
  );
}

function ObjectEditorHeader({ selection, object, capabilityEvidence, onDelete, deleteDisabledReason = '' }: {
  selection: Selection;
  object: ProviderConnection | ModelDeployment | BusinessModelAlias;
  capabilityEvidence?: CapabilityEvidenceResponse;
  onDelete?: () => void;
  deleteDisabledReason?: string;
}) {
  const type = selection.domain === 'connections' ? 'Provider Connection' : selection.domain === 'deployments' ? 'Model Deployment' : 'Business Model Alias';
  const id = selection.domain === 'connections' ? (object as ProviderConnection).connectionId : selection.domain === 'deployments' ? (object as ModelDeployment).deploymentId : (object as BusinessModelAlias).aliasId;
  return <header className="llmObjectEditorHeader">
    <div><span className="missionEyebrow">{type}</span><h3>{object.displayName} <StatePill status={objectCapabilityStatus(selection.domain, object, capabilityEvidence)} /></h3><p>ID: {id}</p></div>
    {onDelete ? <div className="llmObjectEditorActions">
      <button type="button" className="llmDangerAction" disabled={Boolean(deleteDisabledReason)} title={deleteDisabledReason || '删除当前连接'} onClick={onDelete}><Trash2 size={14} />删除连接</button>
      {deleteDisabledReason ? <small>{deleteDisabledReason}</small> : null}
    </div> : <button type="button" aria-label="更多操作">•••</button>}
  </header>;
}

function ConnectionEditor({ connection, profiles, credentials, credentialError, onOpenCredential, onDeleteCredential, onChange }: {
  connection: ProviderConnection;
  profiles: AdapterProfile[];
  credentials: ManagedCredential[];
  credentialError: unknown;
  onOpenCredential: (mode: 'create' | 'rotate') => void;
  onDeleteCredential: () => void;
  onChange: (connection: ProviderConnection) => void;
}) {
  const updateEndpoint = <K extends keyof Endpoint>(key: K, value: Endpoint[K]) => onChange({ ...connection, endpoint: { ...connection.endpoint, [key]: value } });
  const managed = connection.credentialRef.kind === 'litellm_credential';
  const configured = managed && credentials.some((item) => item.credentialName === connection.credentialRef.referenceName);
  return (
    <div className="llmEditorForm llmConnectionForm">
      <Field label="连接名称" required><input value={connection.displayName} onChange={(event) => onChange({ ...connection, displayName: event.target.value })} /></Field>
      <Field label="Adapter Profile" required><select value={connection.adapterProfileId} onChange={(event) => { const profile = profiles.find((item) => item.profileId === event.target.value); onChange({ ...connection, adapterProfileId: event.target.value, adapterProfileRevision: profile?.revision || connection.adapterProfileRevision }); }}>{profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>)}</select></Field>
      <Field label="API Base URL" required wide>
        <div className="llmEndpointFields"><select aria-label="Endpoint scheme" value={connection.endpoint.scheme} onChange={(event) => updateEndpoint('scheme', event.target.value as Endpoint['scheme'])}><option value="https">HTTPS</option><option value="http">HTTP</option></select><input aria-label="Endpoint host" value={connection.endpoint.host} onChange={(event) => updateEndpoint('host', event.target.value)} /><input aria-label="Endpoint port" type="number" min={1} max={65535} value={connection.endpoint.port} onChange={(event) => updateEndpoint('port', numberValue(event.target.value, 443))} /><input aria-label="Endpoint base path" value={connection.endpoint.basePath} onChange={(event) => updateEndpoint('basePath', event.target.value)} placeholder="/v1" /></div>
        <small>API Base URL：{endpointUrl(connection.endpoint)} · Chat Completions：{chatCompletionsUrl(connection.endpoint)}</small>
      </Field>
      <Field label="凭据管理" required wide>
        <div className="llmCredentialManager">
          <select aria-label="凭据存储方式" value={managed ? 'litellm_credential' : 'environment'} onChange={(event) => onChange({ ...connection, credentialRef: event.target.value === 'litellm_credential' ? { kind: 'litellm_credential', referenceName: credentials[0]?.credentialName || '' } : { kind: 'environment', referenceName: 'PROVIDER_API_KEY' } })}>
            <option value="litellm_credential">LiteLLM 托管凭据（推荐）</option>
            <option value="environment">环境变量引用（高级）</option>
          </select>
          {managed ? <>
            <select aria-label="选择托管凭据" value={connection.credentialRef.referenceName} onChange={(event) => onChange({ ...connection, credentialRef: { kind: 'litellm_credential', referenceName: event.target.value } })}>
              <option value="">请选择凭据</option>
              {credentials.map((credential) => <option key={credential.credentialName} value={credential.credentialName}>{credential.credentialName} · {credential.provider || 'provider'}</option>)}
            </select>
            <div className="llmCredentialActions">
              <span className={configured ? 'isConfigured' : 'isMissing'}><ShieldCheck size={14} />{configured ? '已安全保存' : '尚未配置'}</span>
              <button type="button" onClick={() => onOpenCredential('create')}><Plus size={13} />新增</button>
              <button type="button" disabled={!connection.credentialRef.referenceName} onClick={() => onOpenCredential('rotate')}>轮换</button>
              <button type="button" className="llmDangerAction" disabled={!connection.credentialRef.referenceName} onClick={onDeleteCredential}><Trash2 size={13} />删除</button>
            </div>
          </> : <div className="llmSecretReference"><input value={connection.credentialRef.referenceName} onChange={(event) => onChange({ ...connection, credentialRef: { kind: 'environment', referenceName: event.target.value.toUpperCase() } })} /><span><ShieldCheck size={14} />仅引用</span></div>}
          {credentialError ? <small className="llmEvidenceError">{errorMessage(credentialError)}</small> : null}
        </div>
      </Field>
      <Field label="网络区域" required><select value={connection.networkZone} onChange={(event) => onChange({ ...connection, networkZone: event.target.value as ProviderConnection['networkZone'] })}><option value="public_provider">public_provider</option><option value="approved_private">approved_private</option><option value="local_development">local_development</option></select></Field>
      <ChoiceField label="TLS 校验"><BinaryChoice ariaLabel="TLS 校验策略" value={connection.tlsPolicy === 'verify_full'} positiveLabel="完整校验" negativeLabel="私有 CA" onChange={(value) => onChange({ ...connection, tlsPolicy: value ? 'verify_full' : 'private_ca' })} /></ChoiceField>
      <ChoiceField label="连接状态"><BinaryChoice ariaLabel="Provider Connection 状态" value={connection.enabled} onChange={(value) => onChange({ ...connection, enabled: value })} /></ChoiceField>
      <Field label="用途" wide><input value={connection.metadata.purpose} onChange={(event) => onChange({ ...connection, metadata: { ...connection.metadata, purpose: event.target.value } })} placeholder="例如：AI Teacher 生产模型" /></Field>
    </div>
  );
}

function CredentialDialog({ state, secret, error, saving, onStateChange, onSecretChange, onClose, onSave }: {
  state: CredentialDialogState;
  secret: string;
  error: unknown;
  saving: boolean;
  onStateChange: (state: CredentialDialogState) => void;
  onSecretChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const validName = /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/.test(state.credentialName);
  return <div className="llmReleaseOverlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="llmCredentialDialog" role="dialog" aria-modal="true" aria-labelledby="llm-credential-title">
      <header><div><span className="missionEyebrow">Write-only credential</span><h3 id="llm-credential-title">{state.mode === 'create' ? '新增托管凭据' : '轮换托管凭据'}</h3></div><button type="button" onClick={onClose} aria-label="关闭凭据窗口">×</button></header>
      <p>API Key 只会发送到服务端并写入 LiteLLM 加密凭据存储。保存后页面无法读取或回显原值。</p>
      <Field label="凭据名称" required wide><input autoFocus disabled={state.mode === 'rotate'} value={state.credentialName} onChange={(event) => onStateChange({ ...state, credentialName: event.target.value })} placeholder="glm-production" /><small>允许字母、数字、点、下划线、冒号和连字符。</small></Field>
      <Field label="Provider" required wide><input value={state.provider} onChange={(event) => onStateChange({ ...state, provider: event.target.value })} placeholder="zai" /></Field>
      <Field label="真实 API Key" required wide><input type="password" autoComplete="new-password" value={secret} onChange={(event) => onSecretChange(event.target.value)} placeholder="只写入一次，不会回显" /></Field>
      {error ? <p className="llmEvidenceError">{errorMessage(error)}</p> : null}
      <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="primaryAction" disabled={!validName || !secret || saving} onClick={onSave}><ShieldCheck size={14} />{saving ? '安全写入中' : state.mode === 'create' ? '保存凭据' : '确认轮换'}</button></footer>
    </section>
  </div>;
}

function ConnectionProbeNotice({ state, onClose, onCreateDeployment }: {
  state: ConnectionProbeNoticeState;
  onClose: () => void;
  onCreateDeployment: () => void;
}) {
  return <div className="llmReleaseOverlay llmProbeNoticeOverlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="llmConnectionProbeNotice" role="alertdialog" aria-modal="true" aria-labelledby="llm-probe-notice-title" aria-describedby="llm-probe-notice-description">
      <header><div><span className="missionEyebrow">Connection test prerequisite</span><h3 id="llm-probe-notice-title">缺少可测试的 Model Deployment</h3></div><button type="button" onClick={onClose} aria-label="关闭连接测试提示">×</button></header>
      <p id="llm-probe-notice-description">Provider Connection“{state.connectionName}”还没有关联已填写真实模型 ID 的 Model Deployment，因此不会发起连接测试。</p>
      <div className="llmConnectionProbeHint"><Box size={18} /><p>请先新建 Model Deployment、关联当前 Provider Connection 并填写真实模型 ID。Deployment 可以保持停用，完成连接测试和能力验证后再启用。</p></div>
      <footer><button type="button" onClick={onClose}>暂不创建</button><button type="button" className="primaryAction" autoFocus onClick={onCreateDeployment}><Plus size={14} />新建 Model Deployment</button></footer>
    </section>
  </div>;
}

function DeploymentEditor({ deployment, config, onChange }: { deployment: ModelDeployment; config: ControlPlaneConfig; onChange: (deployment: ModelDeployment) => void }) {
  const updateLimit = (key: keyof ModelDeployment['limits'], value: number) => onChange({ ...deployment, limits: { ...deployment.limits, [key]: value } });
  const capabilityEntries: Array<[keyof ModelDeployment['declaredCapabilities'], string]> = [
    ['supportsStreaming', 'Streaming'], ['supportsToolCalling', 'Tool Call'], ['supportsThinking', 'Thinking'], ['supportsThinkingWithTools', 'Thinking + Tool'], ['supportsStructuredOutput', 'Structured Output'], ['reportsUsage', 'Usage']
  ];
  return <div className="llmEditorForm">
    <Field label="部署名称" required><input value={deployment.displayName} onChange={(event) => onChange({ ...deployment, displayName: event.target.value })} /></Field>
    <Field label="Provider Connection" required><select value={deployment.connectionId} onChange={(event) => onChange({ ...deployment, connectionId: event.target.value })}>{config.providerConnections.map((connection) => <option key={connection.connectionId} value={connection.connectionId}>{connection.displayName}</option>)}</select></Field>
    <Field label="真实模型 ID" required wide><input value={deployment.providerModelId} onChange={(event) => onChange({ ...deployment, providerModelId: event.target.value })} placeholder="deepseek-v4-pro" /></Field>
    <Field label="RPM"><input type="number" min={0} value={deployment.limits.rpm} onChange={(event) => updateLimit('rpm', numberValue(event.target.value, 0))} /></Field>
    <Field label="TPM"><input type="number" min={0} value={deployment.limits.tpm} onChange={(event) => updateLimit('tpm', numberValue(event.target.value, 0))} /></Field>
    <Field label="并发上限"><input type="number" min={0} value={deployment.limits.maxParallelRequests} onChange={(event) => updateLimit('maxParallelRequests', numberValue(event.target.value, 0))} /></Field>
    <ChoiceField label="部署状态"><BinaryChoice ariaLabel="Model Deployment 状态" value={deployment.enabled} onChange={(value) => onChange({ ...deployment, enabled: value })} /></ChoiceField>
    <fieldset className="llmCapabilityFields"><legend>声明能力（发布后仍需 Probe 验证）</legend>{capabilityEntries.map(([key, label]) => <div className="llmCapabilityChoice" key={key}><span>{label}</span><BinaryChoice ariaLabel={`${label} 能力声明`} value={Boolean(deployment.declaredCapabilities[key])} positiveLabel="声明" negativeLabel="不声明" compact onChange={(value) => onChange({ ...deployment, declaredCapabilities: { ...deployment.declaredCapabilities, [key]: value } })} /></div>)}</fieldset>
  </div>;
}

function AliasEditor({ alias, config, onChange }: { alias: BusinessModelAlias; config: ControlPlaneConfig; onChange: (alias: BusinessModelAlias) => void }) {
  const toggleMember = (deploymentId: string, checked: boolean) => {
    const members = checked
      ? [...alias.members, { deploymentId, priority: alias.members.length + 1, weight: 100 }]
      : alias.members.filter((member) => member.deploymentId !== deploymentId);
    onChange({ ...alias, members });
  };
  return <div className="llmEditorForm">
    <Field label="不可变 ID"><input value={alias.aliasId} readOnly aria-readonly="true" /></Field>
    <Field label="显示名称" required><input value={alias.displayName} onChange={(event) => onChange({ ...alias, displayName: event.target.value })} /></Field>
    <Field label="LiteLLM 路由名" required><input value={alias.litellmAlias} onChange={(event) => onChange({ ...alias, litellmAlias: event.target.value })} /></Field>
    <Field label="路由策略"><select value={alias.routing.strategy} onChange={(event) => onChange({ ...alias, routing: { ...alias.routing, strategy: event.target.value as BusinessModelAlias['routing']['strategy'] } })}><option value="simple-shuffle">simple-shuffle</option><option value="least-busy">least-busy</option><option value="usage-based-routing">usage-based-routing</option><option value="latency-based-routing">latency-based-routing</option></select></Field>
    <Field label="重试次数"><input type="number" min={0} value={alias.routing.numRetries} onChange={(event) => onChange({ ...alias, routing: { ...alias.routing, numRetries: numberValue(event.target.value, 0) } })} /></Field>
    <Field label="失败阈值"><input type="number" min={0} value={alias.routing.allowedFails} onChange={(event) => onChange({ ...alias, routing: { ...alias.routing, allowedFails: numberValue(event.target.value, 0) } })} /></Field>
    <Field label="冷却时间"><div className="llmInputSuffix"><input type="number" min={0} value={alias.routing.cooldownTimeSeconds} onChange={(event) => onChange({ ...alias, routing: { ...alias.routing, cooldownTimeSeconds: numberValue(event.target.value, 0) } })} /><span>s</span></div></Field>
    <fieldset className="llmMemberFields"><legend>Deployment 成员</legend>{config.modelDeployments.map((deployment) => { const member = alias.members.find((item) => item.deploymentId === deployment.deploymentId); return <div className="llmMemberChoice" key={deployment.deploymentId}><span><strong>{deployment.displayName}</strong><small>{deployment.providerModelId}</small></span>{member ? <em>P{member.priority}</em> : null}<BinaryChoice ariaLabel={`${deployment.displayName} Alias 成员状态`} value={Boolean(member)} positiveLabel="加入" negativeLabel="不加入" compact onChange={(value) => toggleMember(deployment.deploymentId, value)} /></div>; })}</fieldset>
    <ChoiceField label="Alias 状态"><BinaryChoice ariaLabel="Business Model Alias 状态" value={alias.enabled} onChange={(value) => onChange({ ...alias, enabled: value })} /></ChoiceField>
  </div>;
}

function NetworkCredentialView({ selection, config, health }: { selection: Selection; config: ControlPlaneConfig; health?: HealthResponse }) {
  const connection = selection.domain === 'connections'
    ? config.providerConnections.find((item) => item.connectionId === selection.id)
    : selection.domain === 'deployments'
      ? config.providerConnections.find((item) => item.connectionId === config.modelDeployments.find((deployment) => deployment.deploymentId === selection.id)?.connectionId)
      : undefined;
  if (!connection) return <div className="llmInfoState"><Network size={24} /><h4>业务别名不直接持有网络或凭据</h4><p>它只引用 Deployment；沿依赖关系可查看实际 Provider Connection。</p></div>;
  const secret = health?.secrets?.find((item) => (item.referenceName || item.envName) === connection.credentialRef.referenceName);
  return <div className="llmDefinitionList"><div><dt>API Base URL</dt><dd>{endpointUrl(connection.endpoint)}</dd></div><div><dt>Chat Completions</dt><dd>{chatCompletionsUrl(connection.endpoint)}</dd></div><div><dt>网络区域</dt><dd>{connection.networkZone}</dd></div><div><dt>TLS Policy</dt><dd>{connection.tlsPolicy}</dd></div><div><dt>凭据类型</dt><dd>{connection.credentialRef.kind === 'litellm_credential' ? 'LiteLLM 托管凭据' : '环境变量引用'}</dd></div><div><dt>凭据引用</dt><dd>{connection.credentialRef.referenceName}</dd></div><div><dt>凭据状态</dt><dd><StatePill status={secret?.present ? 'ready' : 'missing'} /></dd></div></div>;
}

function DependencyView({ selection, config }: { selection: Selection; config: ControlPlaneConfig }) {
  const rows = dependencyRows(selection, config);
  return <div className="llmDependencyTable"><header><span>上游对象</span><span>当前对象</span><span>下游引用</span></header>{rows.map((row) => <div key={`${row.upstream}-${row.current}-${row.downstream}`}><span>{row.upstream || '—'}</span><ChevronRight size={14} /><strong>{row.current}</strong><ChevronRight size={14} /><span>{row.downstream || '—'}</span></div>)}</div>;
}

function HistoryView({ version, publishResult }: { version?: LiteLlmVersion; publishResult: PublishResponse | null }) {
  return <div className="llmHistory"><article><Check size={15} /><div><strong>Active 版本 {shortVersion(version?.versionId)}</strong><span>{formatDateTime(version?.publishedAt || '')} · checksum {String(version?.checksum || '').slice(0, 12)}</span></div></article>{publishResult ? <article><Rocket size={15} /><div><strong>本轮发布 {shortVersion(publishResult.version.versionId)}</strong><span>{publishResult.apply.status} · {publishResult.health?.status || 'health unknown'}</span></div></article> : null}<p>完整历史和审计事件由版本存储保留；页面不记录 Secret 值或 Provider 响应正文。</p></div>;
}

function EvidenceRail({ validation, probe, probeError, capabilityEvidence, selectedDeploymentEvidence, capabilityError, health, impactedDeployments, impactedAliases, hasPublishCandidate, onOpenRelease }: {
  validation: DraftValidation;
  probe: ProbeResponse | null;
  probeError: unknown;
  capabilityEvidence?: CapabilityEvidenceResponse;
  selectedDeploymentEvidence?: DeploymentCapabilityEvidence;
  capabilityError: unknown;
  health?: HealthResponse;
  impactedDeployments: number;
  impactedAliases: number;
  hasPublishCandidate: boolean;
  onOpenRelease: () => void;
}) {
  const capabilityChecks = [
    ['streaming', 'streaming'],
    ['tool_call', 'tool_call'],
    ['thinking', 'thinking'],
    ['thinking_tool', 'thinking_tool'],
    ['structured_output', 'structured_output'],
    ['usage', 'usage']
  ] as const;
  const evidence = selectedDeploymentEvidence || capabilityEvidence?.deployments.find((item) => item.enabled);
  const passedCount = capabilityChecks.filter(([key]) => evidence?.results?.[key]?.status === 'passed').length;
  return <aside className="llmEvidenceRail">
    <header className="llmEvidenceHeader"><div><h3>验证与发布</h3><p>这里展示当前设置的校验、连接探测和能力验证结果，不是整套配置的生命周期状态。完整状态以上方 Desired / Applied / Observed 为准。</p></div><ShieldCheck size={17} /></header>
    <section><button type="button" className="llmEvidenceSummary"><span><Check size={15} />配置校验</span><strong className={validation.ok ? 'isPass' : 'isBlock'}>{validation.passed}/{validation.total} 通过</strong><ChevronDown size={14} /></button>{validation.errors.length ? <ul className="llmValidationErrors">{validation.errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}</section>
    <section><div className="llmEvidenceSummary"><span>{probe?.status === 'passed' ? <Check size={15} /> : <Activity size={15} />}连接探测</span><strong className={probe?.status === 'passed' ? 'isPass' : ''}>{probe ? `${probe.status === 'passed' ? '成功' : '失败'} · ${probe.httpStatus ? `HTTP ${probe.httpStatus} · ` : ''}${probe.durationMs}ms` : '尚未执行'}</strong></div>{probeError ? <p className="llmEvidenceError">{errorMessage(probeError)}</p> : null}</section>
    <section><div className="llmEvidenceSummary"><span><Eye size={15} />能力证据</span><strong className={evidence?.ready ? 'isPass' : 'isBlock'}>{passedCount}/6 已验证</strong></div><div className="llmCapabilityEvidence">{capabilityChecks.map(([key, label]) => { const status = evidence?.results?.[key]?.status || 'unverified'; return <span key={key} className={status === 'passed' ? 'isPass' : status === 'failed' || status === 'blocked' ? 'isBlock' : 'isPending'}>{status === 'passed' ? <Check size={12} /> : <CircleAlert size={12} />}{label}<em>{capabilityStatusLabel(status)}</em></span>; })}</div>{evidence?.latestRun ? <small className="llmProbeMeta">最近验证 {formatDateTime(evidence.latestRun.completedAt || '')} · {evidence.latestRun.usage?.providerCalls || 0} 次调用 · {evidence.latestRun.usage?.totalTokens || 0} tokens</small> : null}{capabilityError ? <p className="llmEvidenceError">{errorMessage(capabilityError)}</p> : null}</section>
    <section><h4>发布影响</h4><div className="llmImpactRows"><span><Box size={14} />影响部署<strong>{impactedDeployments}</strong></span><span><KeyRound size={14} />影响别名<strong>{impactedAliases}</strong></span></div></section>
    <section className={capabilityEvidence?.ready ? 'llmEvidenceReady' : 'llmEvidenceWarning'}>{capabilityEvidence?.ready ? <Check size={16} /> : <CircleAlert size={16} />}<p>{capabilityEvidence?.ready ? '全部已启用 Deployment 均具备与当前配置匹配的真实能力证据。' : `发布前必须完成全部已启用 Deployment 的真实能力验证；当前 ${capabilityEvidence?.readyDeploymentCount || 0}/${capabilityEvidence?.enabledDeploymentCount || 0} 就绪。`}</p></section>
    <section className="llmEvidenceGateway"><span>LiteLLM Gateway</span><StatePill status={health?.status || 'unknown'} /><small>{health?.baseUrl || '未配置管理地址'}</small></section>
    <footer><button type="button" disabled={!hasPublishCandidate} onClick={onOpenRelease}><Diff size={14} />查看完整配置差异</button></footer>
  </aside>;
}

function LifecycleBar({ health, dirty, capabilityReady, publishing, published }: { health?: HealthResponse; dirty: boolean; capabilityReady: boolean; publishing: boolean; published: boolean }) {
  const states = [
    { label: 'Draft', detail: dirty ? '存在变更' : '已保存', done: true },
    { label: 'Validate', detail: '确定性校验', done: true },
    { label: 'Probe', detail: capabilityReady ? '能力已验证' : '能力待验证', done: capabilityReady },
    { label: 'Stage', detail: publishing ? '正在暂存' : '待发布', done: publishing || published },
    { label: 'Applied', detail: published ? '已应用' : '待发布', done: published },
    { label: 'Observed', detail: published && health?.status === 'healthy' ? '已观测' : '待回读', done: published && health?.status === 'healthy' }
  ];
  return <div className="llmLifecycleBar">{states.map((state, index) => <div key={state.label} className={state.done ? 'isDone' : ''}><span>{state.done ? <Check size={15} /> : index + 1}</span><p><strong>{state.label}</strong><small>{state.detail}</small></p>{index < states.length - 1 ? <ChevronRight size={15} /> : null}</div>)}</div>;
}

function ReleaseWorkspace({ changeCount, validation, dirty, hasPublishCandidate, capabilityEvidence, health, publishError, publishing, onClose, onPublish }: {
  changeCount: number;
  validation: DraftValidation;
  dirty: boolean;
  hasPublishCandidate: boolean;
  capabilityEvidence?: CapabilityEvidenceResponse;
  health?: HealthResponse;
  publishError: unknown;
  publishing: boolean;
  onClose: () => void;
  onPublish: () => void;
}) {
  const capabilityReady = Boolean(capabilityEvidence?.ready);
  const publishBlocked = dirty || !hasPublishCandidate || !validation.ok || !capabilityReady || publishing;
  return <div className="llmReleaseOverlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="llmReleaseWorkspace" role="dialog" aria-modal="true" aria-labelledby="llm-release-title"><header><div><span className="missionEyebrow">Release Workspace</span><h3 id="llm-release-title">发布 LiteLLM 配置版本</h3><p>发布范围是包含连接、部署与业务模型别名的完整配置快照；实际变更对象将在差异中标明。</p></div><button type="button" onClick={onClose}>关闭</button></header><div className="llmReleaseSummary"><article><strong>{changeCount}</strong><span>草稿变更</span></article><article><strong>{validation.passed}/{validation.total}</strong><span>确定性校验</span></article><article><strong>{capabilityEvidence?.readyDeploymentCount || 0}/{capabilityEvidence?.enabledDeploymentCount || 0}</strong><span>Deployment 就绪</span></article><article><strong>{health?.status || 'unknown'}</strong><span>当前 Gateway</span></article></div><div className="llmReleaseGates"><h4>发布硬门</h4><p>{validation.ok ? <Check size={14} /> : <CircleAlert size={14} />}Schema v2 与引用完整性</p><p>{capabilityReady ? <Check size={14} /> : <CircleAlert size={14} />}全部启用 Deployment 的能力 Probe 已通过</p><p><Check size={14} />Secret 仅引用且运行时已就绪</p><p><Check size={14} />LiteLLM Admin Apply 与发布后健康回读</p></div>{dirty ? <div className="llmReleaseWarning"><CircleAlert size={16} />当前还有未保存修改；请返回编辑并保存草稿，再进行能力验证与发布。</div> : !capabilityReady ? <div className="llmReleaseWarning"><CircleAlert size={16} />能力证据未闭环。返回部署对象运行真实能力验证；发布接口也会执行同一硬门。</div> : <div className="llmReleaseWarning"><CircleAlert size={16} />HTTP 200 只代表接口返回；最终以 Probe、Apply、Health 和 active version 四项证据为准。</div>}{publishError ? <p className="llmReleaseError">{errorMessage(publishError)}</p> : null}<footer><button type="button" onClick={onClose}>返回编辑</button><button type="button" className="primaryAction" disabled={publishBlocked} onClick={onPublish}><Rocket size={14} />{publishing ? '发布中' : '验证并发布配置版本'}</button></footer></section></div>;
}

function Field({ label, children, required = false, wide = false }: { label: string; children: ReactNode; required?: boolean; wide?: boolean }) {
  return <label className={wide ? 'isWide' : ''}><span>{label}{required ? <em>*</em> : null}</span>{children}</label>;
}

function ChoiceField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="llmChoiceField"><span>{label}</span>{children}</div>;
}

function BinaryChoice({
  value,
  onChange,
  ariaLabel,
  positiveLabel = '启用',
  negativeLabel = '停用',
  compact = false
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  positiveLabel?: string;
  negativeLabel?: string;
  compact?: boolean;
}) {
  return <div className={`llmBinaryChoice${compact ? ' isCompact' : ''}`} role="group" aria-label={ariaLabel}>
    <button type="button" className={value ? 'isSelected' : ''} aria-pressed={value} onClick={() => onChange(true)}>{positiveLabel}</button>
    <button type="button" className={!value ? 'isSelected' : ''} aria-pressed={!value} onClick={() => onChange(false)}>{negativeLabel}</button>
  </div>;
}

function StatePill({ status }: { status: string }) {
  const normalized = String(status || 'unknown').toLowerCase();
  const tone = ['ready', 'healthy', 'active', 'passed', 'configured'].includes(normalized) ? 'isReady' : ['missing', 'failed', 'blocked', 'error'].includes(normalized) ? 'isError' : ['disabled', 'retired'].includes(normalized) ? 'isMuted' : 'isWarning';
  return <span className={`llmStatePill ${tone}`}>{normalized.toUpperCase()}</span>;
}

function objectCapabilityStatus(domain: Domain, object: ProviderConnection | ModelDeployment | BusinessModelAlias, evidence?: CapabilityEvidenceResponse) {
  if (!object.enabled) return 'disabled';
  if (domain === 'connections') return 'configured';
  if (domain === 'deployments') {
    return evidence?.deployments.find((item) => item.deploymentId === (object as ModelDeployment).deploymentId)?.status || 'unverified';
  }
  const alias = object as BusinessModelAlias;
  const memberEvidence = alias.members
    .map((member) => evidence?.deployments.find((item) => item.deploymentId === member.deploymentId))
    .filter(Boolean) as DeploymentCapabilityEvidence[];
  if (!alias.members.length || memberEvidence.length !== alias.members.length) return 'unverified';
  if (memberEvidence.every((item) => item.ready)) return 'ready';
  if (memberEvidence.some((item) => item.status === 'failed' || item.status === 'blocked')) return 'blocked';
  return 'unverified';
}

function capabilityStatusLabel(status = '') {
  if (status === 'passed') return '已验证';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '阻断';
  if (status === 'inconclusive') return '未定';
  if (status === 'not_declared') return '未声明';
  if (status === 'not_run') return '未执行';
  return '未验证';
}

type DraftValidation = { ok: boolean; passed: number; total: number; errors: string[] };

function validateDraft(config: ControlPlaneConfig | null, profiles: AdapterProfile[] = []): DraftValidation {
  if (!config) return { ok: false, passed: 0, total: 8, errors: ['配置未加载'] };
  const errors: string[] = [];
  if (!config.providerConnections.length) errors.push('至少需要一个 Provider Connection');
  if (!config.modelDeployments.length) errors.push('至少需要一个 Model Deployment');
  if (!config.businessModelAliases.length) errors.push('至少需要一个 Business Model Alias');
  if (config.providerConnections.some((item) => {
    const validReference = item.credentialRef.kind === 'litellm_credential'
      ? /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/.test(item.credentialRef.referenceName)
      : /^[A-Z][A-Z0-9_]*$/.test(item.credentialRef.referenceName);
    return !item.displayName.trim() || !item.endpoint.host.trim() || !validReference;
  })) errors.push('连接名称、Endpoint 或凭据引用无效');
  if (config.providerConnections.some((item) => !profiles.some((profile) => profile.profileId === item.adapterProfileId && profile.revision === item.adapterProfileRevision))) errors.push('连接引用了目录外或 revision 不匹配的 Adapter Profile');
  if (config.modelDeployments.some((item) => !config.providerConnections.some((connection) => connection.connectionId === item.connectionId) || !item.providerModelId.trim())) errors.push('部署存在无效 Connection 或模型 ID');
  if (config.modelDeployments.some((deployment) => {
    const connection = config.providerConnections.find((item) => item.connectionId === deployment.connectionId);
    const profile = profiles.find((item) => item.profileId === connection?.adapterProfileId);
    return profile ? declaredCapabilityNames(deployment).some((capability) => !profile.supportedCapabilities.includes(capability)) : false;
  })) errors.push('部署声明了当前 Adapter Profile 不支持的能力');
  if (config.businessModelAliases.some((alias) => !alias.litellmAlias.trim() || !alias.members.length || alias.members.some((member) => !config.modelDeployments.some((deployment) => deployment.deploymentId === member.deploymentId)))) errors.push('业务别名缺少有效 Deployment 成员');
  return { ok: errors.length === 0, passed: Math.max(0, 8 - errors.length), total: 8, errors };
}

function declaredCapabilityNames(deployment: ModelDeployment): string[] {
  const capabilities = deployment.declaredCapabilities;
  return [
    capabilities.supportsStreaming ? 'streaming' : '',
    capabilities.supportsToolCalling ? 'tool_calling' : '',
    capabilities.supportsThinking ? 'thinking' : '',
    capabilities.supportsThinkingWithTools ? 'thinking_with_tools' : '',
    capabilities.supportsStructuredOutput ? 'structured_output' : '',
    capabilities.reportsUsage ? 'usage' : ''
  ].filter(Boolean);
}

function controlPlaneFromVersion(version: LiteLlmVersion, health?: HealthResponse): ControlPlaneConfig {
  const config = version.config;
  if (config.schemaVersion >= 2 && config.providerConnections && config.modelDeployments && config.businessModelAliases) {
    return cloneConfig({
      schemaVersion: 2,
      providerConnections: config.providerConnections,
      modelDeployments: config.modelDeployments,
      businessModelAliases: config.businessModelAliases,
      general: config.general
    });
  }
  const connections: ProviderConnection[] = [];
  const deployments: ModelDeployment[] = [];
  const aliases: BusinessModelAlias[] = [];
  const connectionByKey = new Map<string, string>();
  const deploymentIds = new Set<string>();
  for (const [groupIndex, group] of (config.modelGroups || []).entries()) {
    const members: BusinessModelAlias['members'] = [];
    for (const [deploymentIndex, deployment] of (group.deployments || []).entries()) {
      const key = [deployment.provider, deployment.apiBase || '', deployment.apiBaseEnv || '', deployment.apiKeyRef, deployment.litellmCredentialName || ''].join('|');
      let connectionId = connectionByKey.get(key);
      if (!connectionId) {
        connectionId = `connection-${slug(deployment.provider || 'provider')}-${connections.length + 1}`;
        connectionByKey.set(key, connectionId);
        const endpoint = endpointFromLegacy(deployment, health);
        connections.push({
          connectionId,
          displayName: `${providerLabel(deployment.provider)} ${connections.length ? '备用连接' : '生产连接'}`,
          enabled: deployment.enabled !== false,
          adapterProfileId: adapterProfileFromProvider(deployment.provider),
          adapterProfileRevision: 1,
          endpoint,
          apiBaseEnv: deployment.apiBaseEnv || '',
          networkZone: endpoint.host === 'localhost' || endpoint.host === '127.0.0.1' ? 'local_development' : 'public_provider',
          credentialRef: deployment.litellmCredentialName
            ? { kind: 'litellm_credential', referenceName: deployment.litellmCredentialName }
            : { kind: 'environment', referenceName: deployment.apiKeyRef },
          tlsPolicy: 'verify_full',
          metadata: { owner: 'AI Teacher', purpose: `${providerLabel(deployment.provider)} 模型服务` }
        });
      }
      let deploymentId = deployment.deploymentId || `deployment-${groupIndex + 1}-${deploymentIndex + 1}`;
      if (deploymentIds.has(deploymentId)) deploymentId = `${deploymentId}-${groupIndex + 1}`;
      deploymentIds.add(deploymentId);
      deployments.push({
        deploymentId,
        connectionId,
        displayName: deployment.deploymentId || deployment.model,
        providerModelId: stripProviderPrefix(deployment.model),
        enabled: deployment.enabled !== false,
        limits: { rpm: Number(deployment.rpm || 0), tpm: Number(deployment.tpm || 0), maxParallelRequests: Number(deployment.maxParallelRequests || 0) },
        declaredCapabilities: defaultCapabilities(deployment.model)
      });
      members.push({ deploymentId, priority: members.length + 1, weight: 100 });
    }
    aliases.push({
      aliasId: `alias-${slug(group.modelName)}-${groupIndex + 1}`,
      litellmAlias: group.modelName,
      displayName: businessAliasLabel(group.modelName),
      enabled: true,
      members,
      routing: {
        strategy: group.router?.routingStrategy || 'simple-shuffle',
        numRetries: Number(group.router?.numRetries ?? 1),
        allowedFails: Number(group.router?.allowedFails ?? 5),
        cooldownTimeSeconds: Number(group.router?.cooldownTime ?? 30)
      }
    });
  }
  return { schemaVersion: 2, providerConnections: connections, modelDeployments: deployments, businessModelAliases: aliases, general: config.general || { masterKeyEnv: 'LITELLM_MASTER_KEY', databaseUrlEnv: 'LITELLM_DATABASE_URL' } };
}

function endpointFromLegacy(deployment: LegacyDeployment, _health?: HealthResponse): Endpoint {
  const source = deployment.apiBase || providerDefaultEndpoint(deployment.provider);
  try {
    const url = new URL(source);
    return { scheme: url.protocol === 'http:' ? 'http' : 'https', host: url.hostname, port: Number(url.port || (url.protocol === 'http:' ? 80 : 443)), basePath: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '') };
  } catch {
    return { scheme: 'https', host: 'api.example.com', port: 443, basePath: '' };
  }
}

function addObject(domain: Domain, config: ControlPlaneConfig, setConfig: (config: ControlPlaneConfig) => void, setSelection: (selection: Selection) => void) {
  if (domain === 'connections') return addConnection(config, setConfig, setSelection);
  if (domain === 'deployments') {
    return createDeploymentForConnection(config, config.providerConnections[0]?.connectionId || '', setConfig, setSelection);
  }
  const aliasId = `draft-alias-${Date.now()}`;
  const firstDeployment = config.modelDeployments[0];
  const next: BusinessModelAlias = { aliasId, litellmAlias: 'ai-teacher-new-model', displayName: '新业务模型别名', enabled: false, members: firstDeployment ? [{ deploymentId: firstDeployment.deploymentId, priority: 1, weight: 100 }] : [], routing: { strategy: 'simple-shuffle', numRetries: 1, allowedFails: 5, cooldownTimeSeconds: 30 } };
  setConfig({ ...config, businessModelAliases: [...config.businessModelAliases, next] });
  setSelection({ domain, id: aliasId });
}

function createDeploymentForConnection(config: ControlPlaneConfig, connectionId: string, setConfig: (config: ControlPlaneConfig) => void, setSelection: (selection: Selection) => void) {
  const deploymentId = `draft-deployment-${Date.now()}`;
  const next: ModelDeployment = { deploymentId, connectionId, displayName: '新模型部署', providerModelId: '', enabled: false, limits: { rpm: 0, tpm: 0, maxParallelRequests: 0 }, declaredCapabilities: defaultCapabilities('') };
  setConfig({ ...config, modelDeployments: [...config.modelDeployments, next] });
  setSelection({ domain: 'deployments', id: deploymentId });
}

function preferredProbeDeployment(deployments: ModelDeployment[], connectionId: string): ModelDeployment | null {
  const candidates = deployments.filter((item) => item.connectionId === connectionId && item.providerModelId.trim());
  return candidates.find((item) => item.enabled) || candidates[0] || null;
}

function addConnection(config: ControlPlaneConfig, setConfig: (config: ControlPlaneConfig) => void, setSelection: (selection: Selection) => void) {
  const connectionId = `draft-connection-${Date.now()}`;
  const next: ProviderConnection = { connectionId, displayName: '新 Provider 连接', enabled: false, adapterProfileId: 'openai-compatible-public.v1', adapterProfileRevision: 1, endpoint: { scheme: 'https', host: 'api.example.com', port: 443, basePath: '/v1' }, networkZone: 'public_provider', credentialRef: { kind: 'litellm_credential', referenceName: '' }, tlsPolicy: 'verify_full', metadata: { owner: 'AI Teacher', purpose: '' } };
  setConfig({ ...config, providerConnections: [...config.providerConnections, next] });
  setSelection({ domain: 'connections', id: connectionId });
}

function updateConnection(config: ControlPlaneConfig, connection: ProviderConnection, setConfig: (config: ControlPlaneConfig) => void) { setConfig({ ...config, providerConnections: config.providerConnections.map((item) => item.connectionId === connection.connectionId ? connection : item) }); }
function updateDeployment(config: ControlPlaneConfig, deployment: ModelDeployment, setConfig: (config: ControlPlaneConfig) => void) { setConfig({ ...config, modelDeployments: config.modelDeployments.map((item) => item.deploymentId === deployment.deploymentId ? deployment : item) }); }
function updateAlias(config: ControlPlaneConfig, alias: BusinessModelAlias, setConfig: (config: ControlPlaneConfig) => void) { setConfig({ ...config, businessModelAliases: config.businessModelAliases.map((item) => item.aliasId === alias.aliasId ? alias : item) }); }

function dependencyRows(selection: Selection, config: ControlPlaneConfig) {
  if (selection.domain === 'connections') {
    const connection = config.providerConnections.find((item) => item.connectionId === selection.id);
    const deployments = config.modelDeployments.filter((item) => item.connectionId === selection.id);
    return deployments.map((deployment) => ({ upstream: endpointUrl(connection?.endpoint), current: deployment.displayName, downstream: config.businessModelAliases.filter((alias) => alias.members.some((member) => member.deploymentId === deployment.deploymentId)).map((alias) => alias.displayName).join('、') }));
  }
  if (selection.domain === 'deployments') {
    const deployment = config.modelDeployments.find((item) => item.deploymentId === selection.id);
    return [{ upstream: config.providerConnections.find((connection) => connection.connectionId === deployment?.connectionId)?.displayName || '', current: deployment?.displayName || '', downstream: config.businessModelAliases.filter((alias) => alias.members.some((member) => member.deploymentId === selection.id)).map((alias) => alias.displayName).join('、') }];
  }
  const alias = config.businessModelAliases.find((item) => item.aliasId === selection.id);
  return (alias?.members || []).map((member) => { const deployment = config.modelDeployments.find((item) => item.deploymentId === member.deploymentId); return { upstream: config.providerConnections.find((connection) => connection.connectionId === deployment?.connectionId)?.displayName || '', current: deployment?.displayName || '', downstream: alias?.displayName || '' }; });
}

function selectionExists(config: ControlPlaneConfig, selection: Selection) { return selection.domain === 'connections' ? config.providerConnections.some((item) => item.connectionId === selection.id) : selection.domain === 'deployments' ? config.modelDeployments.some((item) => item.deploymentId === selection.id) : config.businessModelAliases.some((item) => item.aliasId === selection.id); }
function selectionAfterServerIdAssignment(previous: Selection | null, config: ControlPlaneConfig): Selection {
  const domain = previous?.domain || 'connections';
  const ids = domain === 'connections'
    ? config.providerConnections.map((item) => item.connectionId)
    : domain === 'deployments'
      ? config.modelDeployments.map((item) => item.deploymentId)
      : config.businessModelAliases.map((item) => item.aliasId);
  return { domain, id: ids.at(-1) || '' };
}
function cloneConfig(config: ControlPlaneConfig): ControlPlaneConfig { return JSON.parse(JSON.stringify(config)) as ControlPlaneConfig; }
function objectId(domain: Domain, item: ProviderConnection | ModelDeployment | BusinessModelAlias): string {
  if (domain === 'connections') return String((item as ProviderConnection).connectionId);
  if (domain === 'deployments') return String((item as ModelDeployment).deploymentId);
  return String((item as BusinessModelAlias).aliasId);
}
function endpointUrl(endpoint?: Endpoint) { if (!endpoint?.host) return ''; const defaultPort = endpoint.scheme === 'https' ? 443 : 80; return `${endpoint.scheme}://${endpoint.host}${endpoint.port === defaultPort ? '' : `:${endpoint.port}`}${endpoint.basePath || ''}`; }
function chatCompletionsUrl(endpoint?: Endpoint) { const base = endpointUrl(endpoint).replace(/\/$/, ''); return base ? `${base}/chat/completions` : ''; }
function suggestedCredentialName(displayName = '') { const name = String(displayName).trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100); return /^[a-z]/.test(name) ? `${name}-credential` : `provider-${Date.now()}`; }
function providerDefaultEndpoint(provider = '') { return provider.toLowerCase().includes('deepseek') ? 'https://api.deepseek.com' : provider.toLowerCase().includes('openai') ? 'https://api.openai.com/v1' : 'https://api.example.com/v1'; }
function adapterProfileFromProvider(provider = '') { const normalized = provider.toLowerCase(); if (normalized.includes('deepseek')) return 'deepseek-v4.v1'; if (normalized.includes('anthropic')) return 'anthropic.v1'; if (normalized.includes('azure')) return 'azure-openai.v1'; if (normalized === 'openai') return 'openai.v1'; return 'openai-compatible-public.v1'; }
function providerLabel(provider = '') { const normalized = provider.toLowerCase(); if (normalized.includes('deepseek')) return 'DeepSeek'; if (normalized.includes('openai')) return 'OpenAI'; if (normalized.includes('anthropic')) return 'Anthropic'; return provider || 'Provider'; }
function businessAliasLabel(alias = '') { if (alias.includes('reasoning')) return '推理模型'; if (alias.includes('fast')) return '快速模型'; if (alias.includes('repair')) return '修复模型'; if (alias.includes('final')) return '终审模型'; return alias; }
function stripProviderPrefix(model = '') { const parts = model.split('/'); return parts.length > 1 ? parts.slice(1).join('/') : model; }
function slug(value = '') { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'object'; }
function defaultCapabilities(model = ''): ModelDeployment['declaredCapabilities'] { const thinking = /reason|pro|thinking/i.test(model); return { contextWindowTokens: 0, maxOutputTokens: 0, supportsStreaming: true, supportsToolCalling: true, supportsThinking: thinking, supportsThinkingWithTools: thinking, supportsStructuredOutput: true, reportsUsage: true }; }
function numberValue(value: string, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback; }
function draftChangeCount(baseline: ControlPlaneConfig | null, draft: ControlPlaneConfig) { if (!baseline) return 0; let count = 0; for (const key of ['providerConnections', 'modelDeployments', 'businessModelAliases'] as const) { const before = new Map(baseline[key].map((item) => [('connectionId' in item ? item.connectionId : 'deploymentId' in item ? item.deploymentId : item.aliasId), JSON.stringify(item)])); for (const item of draft[key]) { const id = 'connectionId' in item ? item.connectionId : 'deploymentId' in item ? item.deploymentId : item.aliasId; if (before.get(id) !== JSON.stringify(item)) count += 1; before.delete(id); } count += before.size; } return count; }
function shortVersion(value = '') { const normalized = String(value || ''); return normalized ? `v${normalized.slice(-4)}` : '—'; }
function formatDateTime(value = '') { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) : '—'; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error || '操作失败'); }
