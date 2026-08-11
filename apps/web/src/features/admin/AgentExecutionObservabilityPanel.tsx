import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Clock3, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useAppApiClient } from '../../app/use-api-client';

type ExecutionMetrics = Record<string, unknown>;

type ExecutionCheckpoint = {
  checkpointId: string;
  revision: number;
  phase: string;
  createdAt?: string | null;
  candidateArtifactId?: string | null;
  validationArtifactId?: string | null;
  repairRound?: number | null;
  allowedActions?: string[];
  degraded?: boolean;
  errorCategory?: string | null;
  frontendResultReturned?: boolean;
  engineeringDeliveryStatus?: string;
  selectionReason?: string;
  engineeringResolution?: string;
  revisionDelivered?: boolean;
  metrics?: ExecutionMetrics | null;
};

type ExecutionAlert = {
  code?: string;
  category?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'error';
  createdAt?: string | null;
};

type ExecutionObservabilityResponse = {
  runId: string;
  policy?: {
    versionId?: string | null;
    checksum?: string | null;
  } | null;
  timeline?: ExecutionCheckpoint[];
  alerts?: Array<ExecutionAlert | string>;
};

type DiagnosticKind = 'normal' | 'normal-long' | 'repair-stalled' | 'provider-timeout' | 'checkpoint-failed' | 'context-bloat';

const DIAGNOSTIC_LABELS: Record<DiagnosticKind, string> = {
  normal: '正常推进',
  'normal-long': '正常长任务',
  'repair-stalled': '无进展 Repair',
  'provider-timeout': 'Provider 超时',
  'checkpoint-failed': 'Checkpoint 失败',
  'context-bloat': '上下文膨胀'
};

const METRIC_FIELDS: Array<{ keys: string[]; label: string; format?: (value: number) => string }> = [
  { keys: ['durationMs', 'elapsedMs'], label: '阶段耗时', format: formatDuration },
  { keys: ['contextTokens', 'inputTokens', 'promptTokens'], label: '输入上下文', format: formatCount },
  { keys: ['totalTokens'], label: '总 Tokens', format: formatCount },
  { keys: ['contextCharacters', 'contextChars'], label: '上下文字符', format: formatCount },
  { keys: ['messageCount', 'contextMessageCount'], label: '上下文消息', format: formatCount },
  { keys: ['noProgressRounds'], label: '无进展轮数', format: formatCount }
];

export function AgentExecutionObservabilityPanel() {
  const api = useAppApiClient();
  const [runIdInput, setRunIdInput] = useState('');
  const [submittedRunId, setSubmittedRunId] = useState('');
  const diagnosticsQuery = useQuery({
    queryKey: ['admin', 'ai-teacher', 'execution-checkpoints', submittedRunId],
    queryFn: () => api.request<ExecutionObservabilityResponse>(
      `/api/admin/ai-teacher/execution-checkpoints?runId=${encodeURIComponent(submittedRunId)}`
    ),
    enabled: Boolean(submittedRunId),
    retry: false
  });

  const timeline = diagnosticsQuery.data?.timeline || [];
  const alerts = diagnosticsQuery.data?.alerts || [];
  const runSignals = useMemo(() => collectRunSignals(timeline, alerts), [alerts, timeline]);
  const elapsedMs = timelineElapsedMs(timeline);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRunId = runIdInput.trim();
    if (!nextRunId) return;
    if (nextRunId === submittedRunId) {
      void diagnosticsQuery.refetch();
      return;
    }
    setSubmittedRunId(nextRunId);
  }

  return (
    <section className="agentExecutionObservability" data-agent-execution-observability aria-labelledby="agent-execution-observability-title">
      <header className="agentExecutionObservabilityHeader">
        <div>
          <span className="missionEyebrow">Run Diagnostics</span>
          <h2 id="agent-execution-observability-title">运行诊断与恢复证据</h2>
          <p>按 Run ID 查看资源策略快照、Checkpoint 时间线和降级结果。这里只展示审计元数据，不展示模型思考或完整候选内容。</p>
        </div>
        <form className="agentExecutionSearch" onSubmit={submitSearch} role="search">
          <label htmlFor="agent-execution-run-id">Run ID</label>
          <span>
            <input
              id="agent-execution-run-id"
              value={runIdInput}
              onChange={(event) => setRunIdInput(event.target.value)}
              placeholder="输入 run_…"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" disabled={!runIdInput.trim() || diagnosticsQuery.isFetching}>
              {diagnosticsQuery.isFetching ? <RefreshCw className="isSpinning" size={15} /> : <Search size={15} />}
              {diagnosticsQuery.isFetching ? '查询中' : '查询'}
            </button>
          </span>
        </form>
      </header>

      {!submittedRunId ? (
        <div className="agentExecutionEmpty" data-state="idle">
          <Activity size={19} />
          <div><strong>输入 Run ID 开始查询</strong><p>适合定位长任务、重复 Repair、Provider 超时和自动续跑恢复问题。</p></div>
        </div>
      ) : null}

      {diagnosticsQuery.isLoading ? (
        <div className="agentExecutionEmpty" data-state="loading" aria-live="polite">
          <RefreshCw className="isSpinning" size={19} />
          <div><strong>正在读取运行证据</strong><p>仅加载服务端已持久化的只读诊断数据。</p></div>
        </div>
      ) : null}

      {diagnosticsQuery.error ? (
        <div className="agentExecutionError" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>运行诊断加载失败</strong>
            <p>{safeDiagnosticText(diagnosticsQuery.error instanceof Error ? diagnosticsQuery.error.message : '请求失败')}</p>
            <button type="button" onClick={() => void diagnosticsQuery.refetch()}><RefreshCw size={14} />重新加载</button>
          </div>
        </div>
      ) : null}

      {diagnosticsQuery.data && !timeline.length ? (
        <div className="agentExecutionEmpty" data-state="empty">
          <Clock3 size={19} />
          <div><strong>未找到 Checkpoint</strong><p>请核对 Run ID；若运行存在但无记录，应检查 Checkpoint 持久化告警。</p></div>
        </div>
      ) : null}

      {diagnosticsQuery.data && timeline.length ? (
        <>
          <div className="agentExecutionSummary" aria-label="运行诊断摘要">
            <span><small>Run</small><strong title={diagnosticsQuery.data.runId}>{diagnosticsQuery.data.runId}</strong></span>
            <span>
              <small>策略版本</small>
              <strong>{diagnosticsQuery.data.policy?.versionId || '未记录'}</strong>
              {diagnosticsQuery.data.policy?.checksum ? <code title={diagnosticsQuery.data.policy.checksum}>{shortChecksum(diagnosticsQuery.data.policy.checksum)}</code> : null}
            </span>
            <span><small>Checkpoint</small><strong>{timeline.length}</strong></span>
            <span><small>时间线跨度</small><strong>{elapsedMs === null ? '未记录' : formatDuration(elapsedMs)}</strong></span>
            <span><small>前端结果</small><strong>{timeline.some((item) => item.frontendResultReturned) ? '已返回' : '尚未返回'}</strong></span>
          </div>

          <div className="agentExecutionSignalBar" aria-label="运行信号">
            {runSignals.map((kind) => (
              <span key={kind} data-diagnostic-kind={kind}>{kind === 'normal' || kind === 'normal-long' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{DIAGNOSTIC_LABELS[kind]}</span>
            ))}
          </div>

          <ol className="agentExecutionTimeline" aria-label="Checkpoint 阶段时间线">
            {timeline.map((checkpoint, index) => {
              const kind = checkpointDiagnosticKind(checkpoint);
              const metrics = visibleMetrics(checkpoint.metrics);
              return (
                <li key={checkpoint.checkpointId || `${checkpoint.revision}-${index}`} data-phase={checkpoint.phase}>
                  <span className="agentExecutionTimelineMarker" aria-hidden="true">{index + 1}</span>
                  <article>
                    <header>
                      <div>
                        <strong>{phaseLabel(checkpoint.phase)}</strong>
                        <code>revision {checkpoint.revision}</code>
                        {checkpoint.repairRound !== null && checkpoint.repairRound !== undefined ? <em>Repair {checkpoint.repairRound}</em> : null}
                      </div>
                      <time dateTime={checkpoint.createdAt || undefined}>{formatTimestamp(checkpoint.createdAt)}</time>
                    </header>
                    <div className="agentExecutionCheckpointStatus">
                      <span data-diagnostic-kind={kind}>{DIAGNOSTIC_LABELS[kind]}</span>
                      <span data-result-returned={checkpoint.frontendResultReturned ? 'true' : 'false'}>前端结果：{checkpoint.frontendResultReturned ? '已返回' : '未返回'}</span>
                      {checkpoint.engineeringDeliveryStatus ? <span>交付状态：{checkpoint.engineeringDeliveryStatus}</span> : null}
                      {checkpoint.revisionDelivered ? <span>Revision：已交付</span> : null}
                      {checkpoint.engineeringResolution ? <span>工程复核：{checkpoint.engineeringResolution}</span> : null}
                      {checkpoint.degraded ? <span data-degraded="true">已降级</span> : <span>正常路径</span>}
                      {checkpoint.errorCategory ? <span className="isError">错误分类：{safeDiagnosticText(checkpoint.errorCategory, 80)}</span> : null}
                    </div>
                    {metrics.length ? (
                      <dl className="agentExecutionMetrics">
                        {metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}
                      </dl>
                    ) : null}
                    {checkpoint.allowedActions?.length ? (
                      <p className="agentExecutionAllowedActions"><strong>允许的恢复动作</strong>{checkpoint.allowedActions.map((action) => <code key={action}>{safeDiagnosticText(action, 50)}</code>)}</p>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ol>

          {alerts.length ? (
            <section className="agentExecutionAlerts" aria-labelledby="agent-execution-alerts-title">
              <h3 id="agent-execution-alerts-title"><AlertTriangle size={15} />运行告警</h3>
              {alerts.map((alert, index) => {
                const item = normalizeAlert(alert);
                return (
                  <div key={`${item.code}-${index}`} data-severity={item.severity}>
                    <span><strong>{item.code}</strong>{item.category ? <em>{item.category}</em> : null}</span>
                    {item.message ? <p>{item.message}</p> : null}
                    {item.createdAt ? <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time> : null}
                  </div>
                );
              })}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function collectRunSignals(timeline: ExecutionCheckpoint[], alerts: Array<ExecutionAlert | string>): DiagnosticKind[] {
  const elapsedMs = timelineElapsedMs(timeline);
  const signals = new Set(timeline.map((checkpoint) => checkpointDiagnosticKind(checkpoint)));
  for (const alert of alerts) {
    const normalized = normalizeAlert(alert);
    const alertKind = diagnosticKindForSignal(`${normalized.code} ${normalized.category} ${typeof alert === 'string' ? normalized.message : ''}`);
    if (alertKind) signals.add(alertKind);
  }
  if (elapsedMs !== null && elapsedMs >= 120_000) signals.add('normal-long');
  if (!signals.size) signals.add('normal');
  if (signals.size > 1) signals.delete('normal');
  return Array.from(signals);
}

function checkpointDiagnosticKind(checkpoint: ExecutionCheckpoint): DiagnosticKind {
  const diagnosticKind = diagnosticKindForSignal(`${checkpoint.phase} ${checkpoint.errorCategory || ''}`);
  if (diagnosticKind) return diagnosticKind;
  if ((numericMetric(checkpoint.metrics, ['noProgressRounds']) || 0) >= 2) return 'repair-stalled';
  if (hasContextBloatMetric(checkpoint.metrics)) return 'context-bloat';
  const durationMs = numericMetric(checkpoint.metrics, ['durationMs', 'elapsedMs']);
  if (durationMs !== null && durationMs >= 120_000) return 'normal-long';
  return 'normal';
}

function diagnosticKindForSignal(value: string): Exclude<DiagnosticKind, 'normal' | 'normal-long'> | null {
  const signal = value.toLowerCase();
  if (/checkpoint.*(fail|error|unavailable)|checkpoint_(write|persist)|persistence_failed/.test(signal)) return 'checkpoint-failed';
  if (/provider.*timeout|provider_timeout|model_timeout/.test(signal)) return 'provider-timeout';
  if (/no[_ -]?progress|repair.*(stall|converg)|repair_stalled/.test(signal)) return 'repair-stalled';
  if (/context.*(bloat|overflow|limit|large)|context_bloat|context_overflow/.test(signal)) return 'context-bloat';
  return null;
}

function hasContextBloatMetric(metrics?: ExecutionMetrics | null): boolean {
  if (!metrics) return false;
  return metrics.contextCompactionRequired === true
    || metrics.contextBudgetExceeded === true
    || (numericMetric(metrics, ['contextTokens', 'inputTokens', 'promptTokens']) || 0) >= 100_000;
}

function visibleMetrics(metrics?: ExecutionMetrics | null): Array<{ label: string; value: string }> {
  if (!metrics) return [];
  return METRIC_FIELDS.flatMap((field) => {
    const value = numericMetric(metrics, field.keys);
    return value === null ? [] : [{ label: field.label, value: field.format ? field.format(value) : String(value) }];
  });
}

function numericMetric(metrics: ExecutionMetrics | null | undefined, keys: string[]): number | null {
  if (!metrics) return null;
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function timelineElapsedMs(timeline: ExecutionCheckpoint[]): number | null {
  const timestamps = timeline.map((item) => Date.parse(item.createdAt || '')).filter(Number.isFinite);
  return timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : null;
}

function normalizeAlert(alert: ExecutionAlert | string): Required<Pick<ExecutionAlert, 'code' | 'category' | 'message' | 'severity'>> & { createdAt: string } {
  if (typeof alert === 'string') {
    return { code: '运行告警', category: '', message: safeDiagnosticText(alert), severity: 'warning', createdAt: '' };
  }
  return {
    code: safeDiagnosticText(alert.code || '运行告警', 100),
    category: safeDiagnosticText(alert.category || '', 80),
    message: safeDiagnosticText(alert.message || ''),
    severity: alert.severity === 'error' || alert.severity === 'info' ? alert.severity : 'warning',
    createdAt: alert.createdAt || ''
  };
}

function safeDiagnosticText(value: string, maxLength = 240): string {
  return String(value || '')
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    candidate_absent: '等待 Candidate',
    candidate_ready: 'Candidate 已持久化',
    validation_pending: '等待 Validator',
    validated_failed: 'Validator 未通过',
    repair_in_progress: 'Repair 处理中',
    validated_passed: 'Validator 已通过',
    finalization_pending: '等待最终回答',
    completed: '运行完成'
  };
  return labels[phase] || safeDiagnosticText(phase || '未知阶段', 80);
}

function formatTimestamp(value?: string | null): string {
  if (!value) return '时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间格式无效';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function shortChecksum(value: string): string {
  const normalized = safeDiagnosticText(value, 100);
  return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
}
