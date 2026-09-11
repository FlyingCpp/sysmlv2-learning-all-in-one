import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, GitCompareArrows, LockKeyhole, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppApiClient } from '../../app/use-api-client';
import { ErrorState, LoadingState } from '../shared/ui';
import { AgentExecutionObservabilityPanel } from './AgentExecutionObservabilityPanel';

type PolicyGroup = {
  id: string;
  label: string;
  description: string;
};

type PolicyDefinition = {
  key: string;
  group: string;
  label: string;
  valueType: 'integer' | 'boolean' | 'model-ref' | 'enum';
  defaultValue: PolicyValue;
  minimum?: number;
  maximum?: number;
  step?: number;
  unit?: string;
  risk: 'low' | 'medium' | 'high';
  applyMode: 'new_run' | 'owner_reload';
  owner: string;
  description: string;
  state?: 'active' | 'reserved';
  choiceSource?: string;
  allowedValues?: PolicyValue[];
};

type PolicyValue = number | boolean | string;

type ModelRegistry = {
  registryRevision: string;
  registryChecksum: string;
  source: string;
  aliasIds: string[];
  aliases: string[];
  profiles: Array<{
    profileId: string;
    aliasId: string;
    litellmAlias: string;
    displayName: string;
    status: string;
    capabilityStatus: string;
    deploymentCount: number;
    providers: string[];
  }>;
};

type PolicyIssue = {
  key: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

type PolicyVersion = {
  versionId: string;
  sequence: number;
  status: 'draft' | 'validated' | 'active' | 'retired';
  values: Record<string, PolicyValue>;
  checksum: string;
  validation?: {
    ok?: boolean;
    errors?: PolicyIssue[];
    warnings?: PolicyIssue[];
  };
  sourceVersionId?: string;
  notes?: string;
  createdAt?: string | null;
  publishedAt?: string | null;
};

type PolicyCatalogResponse = {
  schemaVersion: number;
  groups: PolicyGroup[];
  definitions: PolicyDefinition[];
  hardInvariants: Array<{
    key: string;
    label: string;
    value: string | number | boolean;
    reason: string;
  }>;
  modelRegistry: ModelRegistry;
};

type PolicyActiveResponse = {
  desired: PolicyVersion | null;
  observed: {
    status?: string;
    versionId?: string;
    checksum?: string;
    values?: Record<string, PolicyValue>;
    observedAt?: string;
    errorCode?: string;
    owners?: Record<string, string | {
      status: 'applied' | 'not_applied' | 'unavailable';
      desired?: unknown;
      applied?: unknown;
      observed?: unknown;
      applyMode?: string;
      reasonCode?: string;
    }>;
  } | null;
  inSync: boolean;
  diff: Array<{ key: string; before: PolicyValue; after: PolicyValue }>;
};

type PolicyVersionsResponse = { versions: PolicyVersion[] };
type PolicyVersionResponse = { version: PolicyVersion };
type PolicyPublishResponse = { desired: PolicyVersion; observed: PolicyActiveResponse['observed']; inSync: boolean };

export function AgentResourcePolicyTab() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const [selectedGroupId, setSelectedGroupId] = useState('run');
  const [draftValues, setDraftValues] = useState<Record<string, PolicyValue>>({});
  const [workingVersion, setWorkingVersion] = useState<PolicyVersion | null>(null);
  const [notes, setNotes] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const catalogQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'resource-policy', 'catalog'],
    queryFn: () => api.request<PolicyCatalogResponse>('/api/admin/ai-teacher/resource-policy/catalog')
  });
  const activeQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'resource-policy', 'active'],
    queryFn: () => api.request<PolicyActiveResponse>('/api/admin/ai-teacher/resource-policy/active'),
    refetchInterval: 60_000
  });
  const versionsQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'resource-policy', 'versions'],
    queryFn: () => api.request<PolicyVersionsResponse>('/api/admin/ai-teacher/resource-policy/versions?limit=20')
  });

  useEffect(() => {
    const desired = activeQuery.data?.desired;
    if (!desired || Object.keys(draftValues).length > 0) return;
    setDraftValues({ ...desired.values });
    setWorkingVersion(desired);
  }, [activeQuery.data?.desired, draftValues]);

  const activeValues = activeQuery.data?.desired?.values || {};
  const dirtyKeys = useMemo(() => (
    Object.keys(draftValues).filter((key) => draftValues[key] !== activeValues[key])
  ), [activeValues, draftValues]);
  const unsavedKeys = useMemo(() => {
    const baseline = workingVersion?.values || activeValues;
    return Object.keys(draftValues).filter((key) => draftValues[key] !== baseline[key]);
  }, [activeValues, draftValues, workingVersion]);
  const selectedDefinitions = (catalogQuery.data?.definitions || []).filter((item) => item.group === selectedGroupId);
  const registeredModelAliasIds = new Set(catalogQuery.data?.modelRegistry.aliasIds || []);
  const unregisteredModelReferences = (catalogQuery.data?.definitions || [])
    .filter((definition) => definition.valueType === 'model-ref')
    .map((definition) => ({ key: definition.key, aliasId: String(draftValues[definition.key] ?? definition.defaultValue) }))
    .filter((reference) => reference.aliasId && !registeredModelAliasIds.has(reference.aliasId));
  const versions = versionsQuery.data?.versions || [];
  const isUnsaved = unsavedKeys.length > 0;

  async function createDraftVersion(): Promise<PolicyVersion> {
    const response = await api.request<PolicyVersionResponse>('/api/admin/ai-teacher/resource-policy/versions', {
      method: 'POST',
      body: JSON.stringify({
        values: draftValues,
        sourceVersionId: activeQuery.data?.desired?.versionId || '',
        notes
      })
    });
    setWorkingVersion(response.version);
    return response.version;
  }

  async function ensureCurrentDraft(): Promise<PolicyVersion> {
    if (workingVersion && !isUnsaved && workingVersion.status !== 'active' && workingVersion.status !== 'retired') return workingVersion;
    return createDraftVersion();
  }

  const saveMutation = useMutation({
    mutationFn: createDraftVersion,
    onSuccess: async (version) => {
      setActionMessage(`草稿 ${version.versionId} 已保存。`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'resource-policy', 'versions'] });
    }
  });
  const validateMutation = useMutation({
    mutationFn: async () => {
      const version = await ensureCurrentDraft();
      return api.request<PolicyVersionResponse>(`/api/admin/ai-teacher/resource-policy/versions/${encodeURIComponent(version.versionId)}/validate`, { method: 'POST' });
    },
    onSuccess: async ({ version }) => {
      setWorkingVersion(version);
      setActionMessage(version.validation?.ok ? `版本 ${version.versionId} 通过确定性校验。` : `版本 ${version.versionId} 校验失败。`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'resource-policy', 'versions'] });
    }
  });
  const publishMutation = useMutation({
    mutationFn: async () => {
      const version = await ensureCurrentDraft();
      return api.request<PolicyPublishResponse>(`/api/admin/ai-teacher/resource-policy/versions/${encodeURIComponent(version.versionId)}/publish`, { method: 'POST' });
    },
    onSuccess: async (result) => {
      setWorkingVersion(result.desired);
      setDraftValues({ ...result.desired.values });
      setActionMessage(result.inSync
        ? `版本 ${result.desired.versionId} 已发布，新 Run 将冻结使用该版本。`
        : `版本 ${result.desired.versionId} 已成为期望版本，但运行时尚未同步。`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'resource-policy', 'active'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'resource-policy', 'versions'] })
      ]);
    }
  });
  const rollbackMutation = useMutation({
    mutationFn: (versionId: string) => api.request<PolicyPublishResponse>(
      `/api/admin/ai-teacher/resource-policy/versions/${encodeURIComponent(versionId)}/rollback`,
      { method: 'POST', body: JSON.stringify({ notes: `管理员回滚到 ${versionId}` }) }
    ),
    onSuccess: async (result) => {
      setWorkingVersion(result.desired);
      setDraftValues({ ...result.desired.values });
      setActionMessage(`已基于历史版本创建并发布 ${result.desired.versionId}。`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'resource-policy', 'active'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'ai-teacher', 'resource-policy', 'versions'] })
      ]);
    }
  });

  if (catalogQuery.isLoading || activeQuery.isLoading || versionsQuery.isLoading) {
    return <LoadingState label="正在加载 Agent 资源策略" />;
  }
  if (catalogQuery.error) return <ErrorState title="策略目录加载失败" error={catalogQuery.error} />;
  if (activeQuery.error) return <ErrorState title="生效策略加载失败" error={activeQuery.error} />;
  if (versionsQuery.error) return <ErrorState title="策略版本加载失败" error={versionsQuery.error} />;

  const currentGroup = catalogQuery.data?.groups.find((group) => group.id === selectedGroupId);
  const validation = workingVersion?.validation;
  const validationIssues = [...(validation?.errors || []), ...(validation?.warnings || [])];
  const actionError = saveMutation.error || validateMutation.error || publishMutation.error || rollbackMutation.error;
  const actionPending = saveMutation.isPending || validateMutation.isPending || publishMutation.isPending || rollbackMutation.isPending;

  return (
    <section className="agentResourcePolicy" data-agent-resource-policy>
      <header className="agentResourcePolicyHeader">
        <div>
          <span className="missionEyebrow">Effective Agent Policy</span>
          <h2>Agent 资源门禁</h2>
          <p>配置从 Policy Catalog 进入版本库；发布后由服务端冻结到新 Run，客户端不能覆盖。</p>
        </div>
        <div className="agentResourcePolicyActions">
          <button type="button" onClick={() => saveMutation.mutate()} disabled={actionPending || !isUnsaved}>
            <Save size={14} />保存草稿
          </button>
          <button type="button" onClick={() => validateMutation.mutate()} disabled={actionPending || !Object.keys(draftValues).length}>
            <ShieldCheck size={14} />确定性校验
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (window.confirm('确认发布当前策略？已运行的 Run 不变，新 Run 将冻结使用新版本。')) publishMutation.mutate();
            }}
            disabled={actionPending || !Object.keys(draftValues).length}
          >
            <CheckCircle2 size={14} />发布到新 Run
          </button>
        </div>
      </header>

      <div className="agentResourcePolicyMeta" aria-label="策略状态摘要">
        <span><strong>{activeQuery.data?.desired?.versionId || '-'}</strong>期望版本</span>
        <span><strong>{activeQuery.data?.observed?.versionId || '-'}</strong>运行时版本</span>
        <span><strong>{activeQuery.data?.inSync ? '已同步' : '未同步'}</strong>控制面状态</span>
        <span><strong>{dirtyKeys.length}</strong>待发布变更</span>
        <span><strong>{catalogQuery.data?.modelRegistry.aliasIds.length || 0}</strong>已注册模型 Alias</span>
      </div>

      <div className="agentResourcePolicyOwnerStates" aria-label="Owner 应用状态">
        {Object.entries(activeQuery.data?.observed?.owners || {}).map(([ownerName, ownerState]) => {
          const status = typeof ownerState === 'string' ? ownerState : ownerState.status;
          const reasonCode = typeof ownerState === 'string' ? '' : ownerState.reasonCode || '';
          return <span key={ownerName} data-owner-status={status}>
            <strong>{ownerName}</strong>{status}{reasonCode ? <small>{reasonCode}</small> : null}
          </span>;
        })}
      </div>

      {actionMessage ? <p className="agentResourcePolicyNotice" role="status">{actionMessage}</p> : null}
      {actionError ? <p className="agentResourcePolicyError" role="alert">{errorMessage(actionError)}</p> : null}
      {unregisteredModelReferences.length ? (
        <div className="agentResourcePolicyMigrationNotice" role="status" data-unregistered-model-references={unregisteredModelReferences.length}>
          <AlertTriangle size={16} />
          <span><strong>{unregisteredModelReferences.length} 个模型路由仍引用未注册 Alias。</strong>请在“阶段模型”中直接选择当前注册的 Alias，再执行确定性校验；系统不会自动猜测模型迁移关系。</span>
        </div>
      ) : null}

      <div className="agentResourcePolicyLayout">
        <aside className="agentResourcePolicyGroups" aria-label="策略分组">
          <div className="agentResourcePolicyColumnTitle">
            <span>01</span>
            <div><strong>配置域</strong><small>{catalogQuery.data?.definitions.length || 0} 个可管理参数</small></div>
          </div>
          {(catalogQuery.data?.groups || []).map((group) => {
            const changedCount = dirtyKeys.filter((key) => key.startsWith(`${group.id}.`)).length;
            return (
              <button
                key={group.id}
                type="button"
                className={selectedGroupId === group.id ? 'isActive' : ''}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <span><strong>{group.label}</strong><small>{group.description}</small></span>
                {changedCount ? <em>{changedCount}</em> : <ChevronRight size={15} />}
              </button>
            );
          })}
          <div className="agentResourcePolicyLocked">
            <LockKeyhole size={15} />
            <div><strong>系统硬门</strong><small>{catalogQuery.data?.hardInvariants.length || 0} 项只读不变量</small></div>
          </div>
        </aside>

        <main className="agentResourcePolicyEditor">
          <div className="agentResourcePolicyColumnTitle">
            <span>02</span>
            <div><strong>{currentGroup?.label || '参数编辑'}</strong><small>{currentGroup?.description}</small></div>
          </div>
          <div className="agentResourcePolicyFields">
            {selectedDefinitions.map((definition) => {
              const currentModelAliasId = definition.valueType === 'model-ref'
                ? String(draftValues[definition.key] ?? definition.defaultValue)
                : '';
              const modelAliasRegistered = !currentModelAliasId || registeredModelAliasIds.has(currentModelAliasId);
              return <label key={definition.key} className="agentResourcePolicyField">
                <span className="agentResourcePolicyFieldHead">
                  <span><strong>{definition.label}</strong><code>{definition.key}</code></span>
                  <em data-risk={definition.risk}>{riskLabel(definition.risk)}</em>
                </span>
                <span className="agentResourcePolicyInputRow">
                  {definition.valueType === 'boolean' ? (
                    <input
                      type="checkbox"
                      data-policy-key={definition.key}
                      checked={Boolean(draftValues[definition.key])}
                      onChange={(event) => updateDraftValue(definition.key, event.target.checked)}
                    />
                  ) : definition.valueType === 'model-ref' ? (
                    <select
                      data-policy-key={definition.key}
                      data-alias-status={modelAliasRegistered ? 'registered' : 'unregistered'}
                      value={currentModelAliasId}
                      onChange={(event) => updateDraftValue(definition.key, event.target.value)}
                    >
                      {!modelAliasRegistered ? (
                        <option value={currentModelAliasId}>{currentModelAliasId}（未注册，需要迁移）</option>
                      ) : null}
                      {(catalogQuery.data?.modelRegistry.profiles || []).map((profile) => (
                        <option key={profile.aliasId} value={profile.aliasId}>
                          {profile.displayName} · {profile.litellmAlias} · {profile.deploymentCount} deployment
                        </option>
                      ))}
                    </select>
                  ) : definition.valueType === 'enum' ? (
                    <select
                      data-policy-key={definition.key}
                      value={String(draftValues[definition.key] ?? definition.defaultValue)}
                      onChange={(event) => updateDraftValue(definition.key, event.target.value)}
                    >
                      {(definition.allowedValues || []).map((value) => (
                        <option key={String(value)} value={String(value)}>{String(value)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      data-policy-key={definition.key}
                      value={Number(draftValues[definition.key] ?? definition.defaultValue)}
                      min={definition.minimum}
                      max={definition.maximum}
                      step={definition.step || 1}
                      onChange={(event) => updateDraftValue(definition.key, Number(event.target.value))}
                    />
                  )}
                  <span>{definition.unit || (definition.valueType === 'boolean' ? (draftValues[definition.key] ? '启用' : '停用') : definition.valueType === 'model-ref' ? 'LiteLLM Alias' : '')}</span>
                  <small>{definition.minimum !== undefined ? `${definition.minimum}–${definition.maximum}` : definition.applyMode === 'new_run' ? '新 Run 生效' : 'Owner 重载'}</small>
                </span>
                <small>{definition.description} · Owner: {definition.owner} · {definition.applyMode === 'new_run' ? '新 Run 生效' : 'Owner 重载'}</small>
              </label>;
            })}
          </div>
          <label className="agentResourcePolicyNotes">
            <span>版本备注</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} placeholder="说明本次调整原因、预期影响和回滚条件。" />
          </label>
        </main>

        <aside className="agentResourcePolicyReview">
          <div className="agentResourcePolicyColumnTitle">
            <span>03</span>
            <div><strong>变更与发布证据</strong><small>发布前先确认差异、校验和运行态。</small></div>
          </div>

          <section>
            <h3><GitCompareArrows size={15} />当前差异</h3>
            {dirtyKeys.length ? dirtyKeys.map((key) => (
              <div className="agentResourcePolicyDiff" key={key}>
                <code>{key}</code>
                <span><del>{formatPolicyValue(activeValues[key])}</del><ChevronRight size={13} /><ins>{formatPolicyValue(draftValues[key])}</ins></span>
              </div>
            )) : <p>草稿与当前生效版本一致。</p>}
          </section>

          <section>
            <h3><ShieldCheck size={15} />确定性校验</h3>
            <p>{unregisteredModelReferences.length
              ? `当前仍有 ${unregisteredModelReferences.length} 个失效 Alias；重新选择后必须再次执行服务端校验。`
              : validation?.ok === true ? '已通过字段范围与跨字段不变量校验。' : '修改后点击“确定性校验”，服务端将生成可审计结果。'}</p>
            {validationIssues.map((issue) => (
              <div key={`${issue.code}-${issue.key}`} className="agentResourcePolicyIssue" data-severity={issue.severity}>
                <AlertTriangle size={14} /><span><strong>{issue.key}</strong>{issue.message}</span>
              </div>
            ))}
          </section>

          <section>
            <h3><LockKeyhole size={15} />不可配置硬门</h3>
            {(catalogQuery.data?.hardInvariants || []).map((item) => (
              <div className="agentResourcePolicyInvariant" key={item.key}>
                <span><strong>{item.label}</strong><code>{formatPolicyValue(item.value)}</code></span>
                <small>{item.reason}</small>
              </div>
            ))}
          </section>

          <section>
            <h3><RotateCcw size={15} />历史版本</h3>
            <div className="agentResourcePolicyVersions">
              {versions.slice(0, 6).map((version) => (
                <button
                  key={version.versionId}
                  type="button"
                  disabled={actionPending || version.status === 'active'}
                  onClick={() => {
                    if (window.confirm(`确认回滚到 ${version.versionId}？系统会创建并发布一个新版本，不覆盖历史记录。`)) rollbackMutation.mutate(version.versionId);
                  }}
                >
                  <span><strong>v{version.sequence}</strong><small>{version.status}</small></span>
                  <code>{version.versionId}</code>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
      <AgentExecutionObservabilityPanel />
    </section>
  );

  function updateDraftValue(key: string, value: PolicyValue) {
    setDraftValues((current) => ({ ...current, [key]: value }));
    setWorkingVersion(null);
    setActionMessage('');
  }
}

function riskLabel(risk: PolicyDefinition['risk']): string {
  return ({ low: '低风险', medium: '中风险', high: '高风险' })[risk];
}

function formatPolicyValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : '策略操作失败，请检查服务端校验结果。';
}
