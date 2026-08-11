import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, Network, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { useRuntimeConfigStore } from '../../app/runtime-config-store';
import { useSessionStore } from '../../app/session-store';
import { useAppApiClient } from '../../app/use-api-client';
import { ErrorState, LoadingState } from '../shared/ui';
import { AdminSectionNav } from './AdminPage';

type ExternalModelingToolSettings = {
  enabled: boolean;
  frontendVisible: boolean;
  modelGenerationEnabled: boolean;
  directWriteEnabled: boolean;
  updatedBy?: string;
  updatedAt?: string | null;
};

type ExternalModelingTool = {
  toolId: string;
  displayName: string;
  description: string;
  desired: ExternalModelingToolSettings;
  effective: Omit<ExternalModelingToolSettings, 'updatedBy' | 'updatedAt'>;
  deployment: {
    serviceConfigured: boolean;
    viewServiceUrl: string;
    graphqlConfigured: boolean;
    graphqlUrl: string;
    frontendProxyPath: string;
    directWriteCeilingEnabled: boolean;
  };
  health: {
    status: 'healthy' | 'unavailable' | 'not_checked' | 'not_configured' | 'disabled';
    checkedAt?: string | null;
    latencyMs?: number | null;
    errorCode?: string;
  };
};

type ExternalModelingToolsResponse = { tools: ExternalModelingTool[] };
type ExternalModelingToolMutationResponse = { before?: ExternalModelingTool; tool: ExternalModelingTool };

export function ExternalModelingToolsAdminPage() {
  const user = useSessionStore((state) => state.user);
  const canManageUsers = Boolean(
    user?.roles?.includes('admin')
    || user?.permissions?.includes('admin.console.access')
    || user?.entitlements?.some((item) => item.code === 'admin.console.access')
  );
  const canManagePacks = Boolean(
    user?.permissions?.includes('course.pack.manage')
    || user?.entitlements?.some((item) => item.code === 'course.pack.manage')
  );

  if (!canManageUsers) {
    return (
      <section className="adminPage" data-external-modeling-tools-admin data-admin-locked>
        <div className="phase4Hero">
          <span className="missionEyebrow">External Modeling Tools</span>
          <h2>需要管理员权限</h2>
          <p>当前账号没有 admin.console.access 权限，无法管理外部建模工具接入。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="adminPage externalModelingToolsAdminPage" data-external-modeling-tools-admin>
      <div className="phase4Hero">
        <span className="missionEyebrow">External Modeling Tools</span>
        <h2>外部建模工具接入</h2>
        <p>统一管理外部建模服务的运行开关、学习端可见性和能力边界。部署地址保持只读，在线策略只能收紧基础设施配置。</p>
        <AdminSectionNav canManageUsers={canManageUsers} canManagePacks={canManagePacks} active="external-modeling-tools" />
      </div>
      <ExternalModelingToolsPanel />
    </section>
  );
}

function ExternalModelingToolsPanel() {
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const reloadRuntimeConfig = useRuntimeConfigStore((state) => state.loadConfig);
  const [draft, setDraft] = useState<ExternalModelingToolSettings | null>(null);
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'external-modeling-tools'],
    queryFn: () => api.request<ExternalModelingToolsResponse>('/api/admin/external-modeling-tools')
  });
  const tool = query.data?.tools.find((item) => item.toolId === 'syson');

  useEffect(() => {
    if (tool) setDraft(tool.desired);
  }, [tool]);

  const saveMutation = useMutation({
    mutationFn: (settings: ExternalModelingToolSettings) => api.request<ExternalModelingToolMutationResponse>(
      '/api/admin/external-modeling-tools/syson',
      {
        method: 'PATCH',
        body: {
          settings: {
            enabled: settings.enabled,
            frontendVisible: settings.frontendVisible,
            modelGenerationEnabled: settings.modelGenerationEnabled,
            directWriteEnabled: settings.directWriteEnabled
          }
        }
      }
    ),
    onSuccess: async ({ tool: updated }) => {
      queryClient.setQueryData<ExternalModelingToolsResponse>(['admin', 'external-modeling-tools'], { tools: [updated] });
      setDraft(updated.desired);
      setNotice('SysON 接入策略已保存，学习端可见性和访问授权已同步。');
      await reloadRuntimeConfig();
    }
  });
  const probeMutation = useMutation({
    mutationFn: () => api.request<ExternalModelingToolMutationResponse>('/api/admin/external-modeling-tools/syson/probe', {
      method: 'POST',
      body: {}
    }),
    onSuccess: ({ tool: updated }) => {
      queryClient.setQueryData<ExternalModelingToolsResponse>(['admin', 'external-modeling-tools'], { tools: [updated] });
      setNotice(updated.health.status === 'healthy' ? '连接检查通过。' : '连接检查未通过，请核对部署地址和服务状态。');
    }
  });

  if (query.isLoading) return <LoadingState label="正在加载外部建模工具配置" />;
  if (query.error) return <ErrorState title="外部建模工具配置加载失败" error={query.error} />;
  if (!tool) return <ErrorState title="未发现 SysON 接入定义" error={new Error('服务端未返回 syson 工具定义。')} />;
  if (!draft) return <LoadingState label="正在加载外部建模工具配置" />;

  const busy = saveMutation.isPending || probeMutation.isPending;
  const mutationError = saveMutation.error || probeMutation.error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice('');
    saveMutation.mutate(draft);
  };

  return (
    <form className="adminPanel externalToolPanel" data-external-tool="syson" onSubmit={submit}>
      <header className="sectionHeader externalToolHeader">
        <div>
          <span className="missionEyebrow">SysML v2 Native Modeling</span>
          <h2><Network size={20} />{tool.displayName}</h2>
          <p>{tool.description}</p>
        </div>
        <StatusBadge status={tool.health.status} />
      </header>

      <div className="externalToolStatusGrid" data-external-tool-effective>
        <StatusCard label="服务生效" value={tool.effective.enabled} detail={tool.deployment.serviceConfigured ? '部署地址已配置' : '缺少部署地址'} />
        <StatusCard label="学习端入口" value={tool.effective.frontendVisible} detail={tool.effective.frontendVisible ? '建模页显示 SysON' : '建模页不显示 SysON'} />
        <StatusCard label="模型生成" value={tool.effective.modelGenerationEnabled} detail="控制 analyze/render 计算路径" />
        <StatusCard label="直接写代理" value={tool.effective.directWriteEnabled} detail={tool.deployment.directWriteCeilingEnabled ? '部署允许，仍受管理员策略控制' : '部署层强制关闭'} />
      </div>

      <section className="externalToolSection" aria-labelledby="syson-runtime-policy-title">
        <div className="externalToolSectionTitle">
          <div><ShieldCheck size={18} /><div><h3 id="syson-runtime-policy-title">运行策略</h3><p>保存后立即影响学习端展示和后端授权。</p></div></div>
        </div>
        <div className="externalToolSwitchGrid">
          <PolicySwitch label="启用 SysON 服务" description="总开关关闭后，所有 SysON 读、生成和写请求均拒绝。" checked={draft.enabled} disabled={busy} onChange={(enabled) => setDraft({ ...draft, enabled })} testId="enabled" />
          <PolicySwitch label="学习端显示入口" description="关闭后，建模页不再渲染 SysON 页签和画布。" checked={draft.frontendVisible} disabled={busy} onChange={(frontendVisible) => setDraft({ ...draft, frontendVisible })} testId="frontend-visible" />
          <PolicySwitch label="允许模型生成" description="控制 SysON analyze/render 等高成本计算路径。" checked={draft.modelGenerationEnabled} disabled={busy} onChange={(modelGenerationEnabled) => setDraft({ ...draft, modelGenerationEnabled })} testId="model-generation" />
          <PolicySwitch label="允许直接写代理" description="仅当部署层 SYSON_WRITE_PROXY_ENABLED 同时开启时才会生效。" checked={draft.directWriteEnabled} disabled={busy} onChange={(directWriteEnabled) => setDraft({ ...draft, directWriteEnabled })} testId="direct-write" />
        </div>
      </section>

      <section className="externalToolSection" aria-labelledby="syson-deployment-title">
        <div className="externalToolSectionTitle">
          <div><Activity size={18} /><div><h3 id="syson-deployment-title">部署连接</h3><p>地址由运维环境提供，只显示去凭据、去查询参数后的观测值。</p></div></div>
          <button type="button" onClick={() => probeMutation.mutate()} disabled={busy || !tool.deployment.serviceConfigured} data-external-tool-probe>
            <RefreshCw size={15} />{probeMutation.isPending ? '检查中' : '测试连接'}
          </button>
        </div>
        <dl className="externalToolConnectionGrid">
          <div className="externalToolConnectionItem"><dt>View service</dt><dd>{tool.deployment.viewServiceUrl || '未配置'}</dd></div>
          <div className="externalToolConnectionItem"><dt>GraphQL service</dt><dd>{tool.deployment.graphqlUrl || '未配置'}</dd></div>
          <div className="externalToolConnectionItem"><dt>浏览器同源代理</dt><dd>{tool.deployment.frontendProxyPath}</dd></div>
          <div className="externalToolConnectionItem"><dt>最近检查</dt><dd>{formatHealth(tool)}</dd></div>
        </dl>
      </section>

      <footer className="externalToolActions">
        <div aria-live="polite">
          {notice ? <p className="adminInlineNotice"><CheckCircle2 size={15} />{notice}</p> : null}
          {mutationError ? <p className="authSettingsError">{mutationError instanceof Error ? mutationError.message : '外部建模工具操作失败'}</p> : null}
        </div>
        <button className="primaryAction" type="submit" disabled={busy} data-external-tool-save>
          <Save size={16} />{saveMutation.isPending ? '保存中' : '保存接入策略'}
        </button>
      </footer>
    </form>
  );
}

function PolicySwitch({ label, description, checked, disabled, onChange, testId }: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label className="externalToolSwitch" data-external-tool-switch={testId} data-enabled={checked}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" className="externalToolSwitchTrack"><i /></span>
      <span><strong>{label}</strong><small>{description}</small></span>
      <em>{checked ? '已开启' : '已关闭'}</em>
    </label>
  );
}

function StatusCard({ label, value, detail }: { label: string; value: boolean; detail: string }) {
  return (
    <article className={`externalToolStatusCard${value ? ' externalToolStatusCard-enabled' : ''}`} data-state={value ? 'enabled' : 'disabled'}>
      <span>{label}</span><strong>{value ? '启用' : '停用'}</strong><small>{detail}</small>
    </article>
  );
}

function StatusBadge({ status }: { status: ExternalModelingTool['health']['status'] }) {
  const labels: Record<ExternalModelingTool['health']['status'], string> = {
    healthy: '连接正常',
    unavailable: '连接异常',
    not_checked: '待检查',
    not_configured: '未配置',
    disabled: '已停用'
  };
  return <span className="externalToolHealthBadge" data-health={status}>{labels[status]}</span>;
}

function formatHealth(tool: ExternalModelingTool) {
  if (!tool.health.checkedAt) return tool.health.status === 'disabled' ? '服务未启用' : '尚未检查';
  const checkedAt = new Date(tool.health.checkedAt).toLocaleString('zh-CN', { hour12: false });
  const latency = typeof tool.health.latencyMs === 'number' ? ` · ${tool.health.latencyMs} ms` : '';
  const error = tool.health.errorCode ? ` · ${tool.health.errorCode}` : '';
  return `${checkedAt}${latency}${error}`;
}
