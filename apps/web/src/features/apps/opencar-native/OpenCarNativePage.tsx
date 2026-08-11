import { lazy, Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FileCode2,
  Network,
  RefreshCw,
  XCircle
} from 'lucide-react';
import { useAppApiClient } from '../../../app/use-api-client';
import type { SemanticOutline, SemanticOutlineNode, ValidationFinding, ValidationResult, WorkspaceSnapshot } from '../../../lib/course/types';
import { buildSysmlNavigationIndex, findSysmlReferences, type SysmlSymbol } from '../../../lib/sysml/navigation-index';
import { MuiModelOutlineTree, type MuiModelTreeItem } from '../../workbench/MuiModelOutlineTree';
import { SysmlCodeMirror, type SysmlCodeMirrorHandle, type SysmlEditorContext } from '../../workbench/SysmlCodeMirror';
import {
  OPEN_CAR_ANALYSIS,
  OPEN_CAR_MODELS,
  OPEN_CAR_PAPER_BENCHMARK,
  OPEN_CAR_TRACE_LINKS,
  type OpenCarAnalysisCase,
  type OpenCarCaseId,
  type OpenCarModelId,
  type OpenCarTraceLink
} from './opencar-data';
import './opencar-native.css';

type ResultTab = 'cable' | 'latency' | 'throughput' | 'safety' | 'compare';
type OutlineRefreshState = 'waiting' | 'refreshing' | 'current' | 'invalid' | 'unavailable' | 'error';

const OPEN_CAR_OUTLINE_DEBOUNCE_MS = 700;
const OPEN_CAR_OUTLINE_TIMEOUT_MS = 45_000;
const OpenCarVehicleScene = lazy(() => import('./OpenCarVehicleScene').then((module) => ({ default: module.OpenCarVehicleScene })));

interface OpenCarNativePageProps {
  activeCase?: OpenCarCaseId;
  onActiveCaseChange?: (caseId: OpenCarCaseId) => void;
}

export function OpenCarNativePage({ activeCase: controlledActiveCase, onActiveCaseChange }: OpenCarNativePageProps) {
  const api = useAppApiClient();
  const editorRef = useRef<SysmlCodeMirrorHandle | null>(null);
  const [activeFileId, setActiveFileId] = useState<OpenCarModelId>('zonal');
  const [internalActiveCase, setInternalActiveCase] = useState<OpenCarCaseId>('zonal');
  const [resultTab, setResultTab] = useState<ResultTab>('cable');
  const [drafts, setDrafts] = useState<Record<OpenCarModelId, string>>(() => {
    return OPEN_CAR_MODELS.reduce((accumulator, file) => {
      accumulator[file.id] = file.content;
      return accumulator;
    }, {} as Record<OpenCarModelId, string>);
  });
  const [validationState, setValidationState] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [validationError, setValidationError] = useState('');
  const [editorContext, setEditorContext] = useState<SysmlEditorContext | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<OpenCarTraceLink>(OPEN_CAR_TRACE_LINKS[0]);
  const [semanticOutline, setSemanticOutline] = useState<SemanticOutline | null>(null);
  const [outlineRefreshState, setOutlineRefreshState] = useState<OutlineRefreshState>('waiting');
  const [outlineRefreshMessage, setOutlineRefreshMessage] = useState('等待官方语义更新');
  const [outlineRefreshNonce, setOutlineRefreshNonce] = useState(0);
  const [showExpertOutlineNodes, setShowExpertOutlineNodes] = useState(false);

  const activeFile = OPEN_CAR_MODELS.find((file) => file.id === activeFileId) || OPEN_CAR_MODELS[0];
  const activeCode = drafts[activeFile.id] || '';
  const navigationIndex = useMemo(() => buildSysmlNavigationIndex(activeCode), [activeCode]);
  const references = useMemo(() => {
    const symbolName = editorContext?.symbolName || selectedTrace.label.split(' ')[0] || '';
    return findSysmlReferences(navigationIndex, symbolName).slice(0, 8);
  }, [editorContext?.symbolName, navigationIndex, selectedTrace.label]);

  const activeCase = controlledActiveCase || internalActiveCase;
  const activeAnalysis = OPEN_CAR_ANALYSIS[activeCase];
  const compareDelta = {
    lengthM: OPEN_CAR_ANALYSIS.domain.summary.lengthM - OPEN_CAR_ANALYSIS.zonal.summary.lengthM,
    massKg: OPEN_CAR_ANALYSIS.domain.summary.massKg - OPEN_CAR_ANALYSIS.zonal.summary.massKg,
    costEur: OPEN_CAR_ANALYSIS.domain.summary.costEur - OPEN_CAR_ANALYSIS.zonal.summary.costEur
  };
  const diagnostics = normalizeDiagnostics(validationResult);
  const workspace = useMemo<WorkspaceSnapshot>(() => ({
    files: OPEN_CAR_MODELS.map((file) => ({
      path: file.title,
      content: drafts[file.id] || file.content,
      editable: true,
      source: 'opencar-native'
    })),
    entryFile: activeFile.title,
    activeFilePath: activeFile.title
  }), [activeFile.title, drafts]);

  useEffect(() => {
    const controller = new AbortController();
    let requestTimedOut = false;
    let timeoutTimer: number | null = null;
    setOutlineRefreshState('waiting');
    setOutlineRefreshMessage('等待官方语义更新');
    const debounceTimer = window.setTimeout(() => {
      setOutlineRefreshState('refreshing');
      setOutlineRefreshMessage('正在更新官方语义树');
      timeoutTimer = window.setTimeout(() => {
        requestTimedOut = true;
        controller.abort();
      }, OPEN_CAR_OUTLINE_TIMEOUT_MS);
      void api.request<ValidationResult>('/api/model-outline', {
        method: 'POST',
        body: workspace,
        signal: controller.signal
      }).then((result) => {
        const outline = result.semanticOutline || null;
        setSemanticOutline((current) => outline?.status === 'available' ? outline : current?.status === 'available' ? current : outline);
        if (outline?.status === 'available') {
          setOutlineRefreshState('current');
          setOutlineRefreshMessage('已与当前代码同步');
        } else if (outline?.status === 'invalid') {
          setOutlineRefreshState('invalid');
          setOutlineRefreshMessage('当前代码未通过官方解析');
        } else {
          setOutlineRefreshState('unavailable');
          setOutlineRefreshMessage('官方语义服务不可用');
        }
      }).catch((error: unknown) => {
        if (controller.signal.aborted && !requestTimedOut) return;
        setOutlineRefreshState('error');
        setOutlineRefreshMessage(requestTimedOut ? '自动生成超时，请点击刷新重试' : error instanceof Error ? `自动更新失败：${error.message}` : '自动更新失败，请重试');
      }).finally(() => {
        if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
      });
    }, OPEN_CAR_OUTLINE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(debounceTimer);
      if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
      controller.abort();
    };
  }, [api, outlineRefreshNonce, workspace]);

  const updateActiveCase = (caseId: OpenCarCaseId) => {
    setInternalActiveCase(caseId);
    onActiveCaseChange?.(caseId);
  };

  const updateActiveCode = (value: string) => {
    setDrafts((current) => ({ ...current, [activeFile.id]: value }));
  };

  const resetActiveFile = () => {
    setDrafts((current) => ({ ...current, [activeFile.id]: activeFile.content }));
    setValidationState('idle');
    setValidationResult(null);
    setValidationError('');
  };

  const focusSymbol = (symbol: SysmlSymbol) => {
    editorRef.current?.focusRange(symbol.from, symbol.to);
  };

  const validateModel = async () => {
    setValidationState('running');
    setValidationError('');
    setValidationResult(null);
    try {
      const result = await api.request<ValidationResult>('/api/validate', {
        method: 'POST',
        body: workspace
      });
      setValidationResult(result);
      if (result.semanticOutline) setSemanticOutline(result.semanticOutline);
      setValidationState(isValidationPassed(result) ? 'ok' : 'fail');
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'validator 调用失败');
      setValidationState('fail');
    }
  };

  const focusSemanticNode = (node: SemanticOutlineNode) => {
    const targetFile = OPEN_CAR_MODELS.find((file) => file.title === node.file) || activeFile;
    setActiveFileId(targetFile.id);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => focusLine(drafts[targetFile.id] || targetFile.content, node.line || 1, editorRef));
    });
  };

  return (
    <section className="openCarNativePage" data-opencar-native>
      <section className="openCarPaperNote" aria-label="论文出处说明">
        <div>
          <strong>案例出处</strong>
          <p>
            本 App 以 OpenCar 论文中的 BoardNet / E/E architecture case 为教学复现对象，演示如何用 SysML v2
            表达功能、信号、组件、allocation 和分析 case，并将模型语义转化为线束长度、质量、成本、延迟、吞吐与安全筛查结果。
            当前版本只复现论文公开表格端点和可解释推导链，不声称还原作者未公开的完整原始模型。
          </p>
        </div>
        <div lang="en">
          <strong>Source acknowledgement</strong>
          <p>
            This app is an educational reproduction inspired by the OpenCar paper's BoardNet E/E architecture case.
            It uses a fixed SysML v2 teaching model to explain model-to-analysis traceability and reproduces publicly
            reported Table II aggregate endpoints. It does not claim to reconstruct the authors' unpublished source model.
          </p>
        </div>
      </section>

      <section className="openCarTraceRail" aria-label="阶段 Tracelink">
        <div className="openCarTraceRailHeader">
          <div>
            <span className="missionEyebrow">Tracelink 推导链</span>
            <strong>从 SysML 对象到工程结算的证据路径</strong>
          </div>
          <p>
            下列推导把传感器信号、软件函数分配、物理连接和论文公开端点串成一条可解释链路。
            点击卡片只切换当前推导说明，不会打断正在阅读的模型代码。
          </p>
        </div>
        <div className="openCarTraceRailList">
          {OPEN_CAR_TRACE_LINKS.map((trace, index) => (
            <button
              key={trace.id}
              type="button"
              className={selectedTrace.id === trace.id ? 'active' : ''}
              onClick={() => setSelectedTrace(trace)}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{traceLabel(trace.resultType)}</strong>
              <em>{trace.label}</em>
              <small>{trace.explanationZh}</small>
            </button>
          ))}
        </div>
      </section>

      <main className="openCarLayout211">
        <section className="openCarModelStage">
          <article className="openCarPanel openCarModelPanel">
            <PanelHeader
              title="SysML 模型编辑与校验"
              description="在平台统一 CodeMirror 环境中阅读和修改 OpenCar SysML v2 模型，并调用 validator 检查语法与语义。"
              action={
                <div className="openCarToolbar">
                  <select value={activeFileId} onChange={(event) => setActiveFileId(event.currentTarget.value as OpenCarModelId)}>
                    {OPEN_CAR_MODELS.map((file) => (
                      <option key={file.id} value={file.id}>{file.group} · {file.title}</option>
                    ))}
                  </select>
                  <button type="button" onClick={validateModel} disabled={validationState === 'running'}>
                    <ClipboardCheck size={15} />
                    {validationState === 'running' ? '校验中' : '校验模型'}
                  </button>
                  <button type="button" onClick={resetActiveFile}>
                    <RefreshCw size={15} />
                    重置文件
                  </button>
                </div>
              }
            />
            <div className="openCarFileStrip" role="tablist" aria-label="SysML 文件">
              {OPEN_CAR_MODELS.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  role="tab"
                  aria-selected={activeFileId === file.id}
                  className={activeFileId === file.id ? 'active' : ''}
                  onClick={() => setActiveFileId(file.id)}
                >
                  <strong>{file.group}</strong>
                  <span>{file.title}</span>
                </button>
              ))}
            </div>
            <div className="openCarModelMeta">
              <span><FileCode2 size={14} />{activeFile.role}</span>
              <ValidationBadge state={validationState} result={validationResult} error={validationError} />
            </div>
            {diagnostics.length ? <DiagnosticsStrip findings={diagnostics} onFocus={(finding) => focusLine(activeCode, finding.line || 1, editorRef)} /> : null}
            <div className="editorSurface openCarEditorSurface">
              <SysmlCodeMirror
                ref={editorRef}
                value={activeCode}
                onChange={updateActiveCode}
                onCursorSymbolChange={(symbolName) => setEditorContext((current) => current ? { ...current, symbolName } : current)}
                onEditorContextChange={setEditorContext}
              />
            </div>
          </article>

          <aside className="openCarPanel openCarTraceInspector">
            <PanelHeader title="模型资源树与引用定位" description="由官方 SysML v2 Validator 解析当前工作区语义对象，并与编辑器位置保持同步。" />
            <div className="openCarTreeBox">
              <div className="openCarSubhead">
                <Network size={15} />
                <span>模型资源树</span>
              </div>
              <OpenCarModelResourceTree
                semanticOutline={semanticOutline}
                refreshState={outlineRefreshState}
                refreshMessage={outlineRefreshMessage}
                showExpertNodes={showExpertOutlineNodes}
                onToggleExpertNodes={setShowExpertOutlineNodes}
                onRefresh={() => setOutlineRefreshNonce((current) => current + 1)}
                onSelect={focusSemanticNode}
              />
            </div>
            <div className="openCarReferences">
              <div className="openCarSubhead">
                <Activity size={15} />
                <span>引用定位</span>
              </div>
              {references.length ? references.map((reference) => (
                <button key={`${reference.name}-${reference.from}`} type="button" onClick={() => editorRef.current?.focusRange(reference.from, reference.to)}>
                  {reference.kind} · {reference.name} · L{reference.line}
                </button>
              )) : <p className="muted">把光标放在模型名称上，可查看当前文件内引用。</p>}
            </div>
          </aside>
        </section>

        <section className="openCarTwoColumns">
          <article className="openCarPanel openCarStagePanel openCarVehiclePanel">
              <PanelHeader
                title="三维整车布线与部件映射"
                description="在经许可引入的开源概念车模型中投影 SysML v2 部件、控制器和物理连接，直观看到不同 E/E 架构下的布线与走线。"
              action={
                <select value={activeCase} onChange={(event) => updateActiveCase(event.currentTarget.value as OpenCarCaseId)} aria-label="三维架构案例">
                  <option value="zonal">Zonal</option>
                  <option value="domain">Domain</option>
                </select>
              }
            />
            <div className="openCarStagePanelBody openCarVehicleStageBody">
              <Suspense fallback={<div className="openCarVehicleLoading">正在加载三维整车视图…</div>}>
                <OpenCarVehicleScene activeCase={activeCase} analysis={activeAnalysis} />
              </Suspense>
            </div>
          </article>

          <article className="openCarPanel openCarStagePanel">
            <PanelHeader
              title="工程结算结果"
              description="基于抽取出的信号流、函数分配和物理位置，计算线束长度、质量、成本、延迟、吞吐与安全筛查指标。"
              action={
                <select value={activeCase} onChange={(event) => updateActiveCase(event.currentTarget.value as OpenCarCaseId)}>
                  <option value="zonal">Zonal</option>
                  <option value="domain">Domain</option>
                </select>
              }
            />
            <TabBar
              tabs={[
                ['cable', '线束'],
                ['latency', '延迟'],
                ['throughput', '吞吐'],
                ['safety', '安全'],
                ['compare', '对比']
              ]}
              active={resultTab}
              onChange={(value) => setResultTab(value as ResultTab)}
            />
            <div className="openCarStagePanelBody">
              <SettlementContent tab={resultTab} activeCase={activeCase} result={activeAnalysis} />
            </div>
          </article>
        </section>

        <section className="openCarPanel openCarConsole">
          <PanelHeader
            title="论文公开端点对比"
            description="用固定教学模型复现 OpenCar 论文公开 Table II 聚合端点，对比 Zonal 与 Domain 两个案例的长度、质量和成本。"
          />
          <div className="openCarBenchmarkGrid">
            <div className="openCarBenchmarkSummary">
              <strong>复现边界</strong>
              <p>使用固定教学模型和固定分析结果复现公开端点。学生可以修改 SysML 并调用 validator 检查模型合法性；动态工程求解器属于后续版本能力。</p>
              <dl>
                <div><dt>Zonal 线束长度</dt><dd>{formatNumber(OPEN_CAR_ANALYSIS.zonal.summary.lengthM, 3)} m</dd></div>
                <div><dt>Domain 线束长度</dt><dd>{formatNumber(OPEN_CAR_ANALYSIS.domain.summary.lengthM, 2)} m</dd></div>
                <div><dt>Domain - Zonal</dt><dd>{formatSigned(compareDelta.lengthM, 3)} m</dd></div>
              </dl>
            </div>
            <table className="openCarTable">
              <thead>
                <tr>
                  <th>架构</th>
                  <th>公开端点</th>
                  <th>论文长度</th>
                  <th>复现长度</th>
                  <th>论文质量</th>
                  <th>复现质量</th>
                  <th>成本</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {OPEN_CAR_PAPER_BENCHMARK.map((row) => (
                  <tr key={row.id}>
                    <td>{row.architecture}</td>
                    <td>{row.point}</td>
                    <td>{row.paperLengthM} m</td>
                    <td>{row.actualLengthM} m</td>
                    <td>{row.paperMassKg} kg</td>
                    <td>{row.actualMassKg} kg</td>
                    <td>{row.actualCostEur} EUR</td>
                    <td><span className="openCarPass">{row.verdict}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </section>
  );
}

function PanelHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="openCarPanelHeader">
      <div>
        {eyebrow ? <span className="missionEyebrow">{eyebrow}</span> : null}
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="openCarPanelAction">{action}</div> : null}
    </header>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="openCarMetric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ValidationBadge({ state, result, error }: { state: 'idle' | 'running' | 'ok' | 'fail'; result: ValidationResult | null; error: string }) {
  const diagnostics = normalizeDiagnostics(result);
  if (state === 'running') return <span className="validationLamp" data-summary-state="warn"><i />validator 运行中</span>;
  if (state === 'ok') return <span className="validationLamp" data-summary-state="ok"><i />语法/语义通过</span>;
  if (state === 'fail') return <span className="validationLamp" data-summary-state="fail"><i />{error || `${diagnostics.length || 1} 条诊断`}</span>;
  return <span className="validationLamp" data-summary-state="idle"><i />待校验</span>;
}

function DiagnosticsStrip({ findings, onFocus }: { findings: ValidationFinding[]; onFocus: (finding: ValidationFinding) => void }) {
  return (
    <div className="openCarDiagnostics" aria-live="polite">
      {findings.slice(0, 4).map((finding, index) => (
        <button key={`${finding.line || 0}-${finding.column || 0}-${index}`} type="button" onClick={() => onFocus(finding)}>
          {finding.severity === 'warning' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          <span>L{finding.line || 1}:{finding.column || 1}</span>
          <strong>{finding.message || 'validator diagnostic'}</strong>
        </button>
      ))}
    </div>
  );
}

function TabBar({ tabs, active, onChange }: { tabs: Array<[string, string]>; active: string; onChange: (value: string) => void }) {
  return (
    <div className="openCarTabs" role="tablist">
      {tabs.map(([value, label]) => (
        <button key={value} type="button" className={active === value ? 'active' : ''} onClick={() => onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function OpenCarModelResourceTree({ semanticOutline, refreshState, refreshMessage, showExpertNodes, onToggleExpertNodes, onRefresh, onSelect }: {
  semanticOutline: SemanticOutline | null;
  refreshState: OutlineRefreshState;
  refreshMessage: string;
  showExpertNodes: boolean;
  onToggleExpertNodes: (value: boolean) => void;
  onRefresh: () => void;
  onSelect: (node: SemanticOutlineNode) => void;
}) {
  const outlineTree = useMemo(() => buildSemanticOutlineTreeItems(semanticOutline?.roots || [], showExpertNodes), [semanticOutline?.roots, showExpertNodes]);
  const refreshBusy = refreshState === 'waiting' || refreshState === 'refreshing';
  const statusTone = refreshState === 'current' ? 'current' : refreshState === 'invalid' || refreshState === 'unavailable' || refreshState === 'error' ? 'warning' : 'progress';
  const StatusIcon = statusTone === 'current' ? CheckCircle2 : statusTone === 'warning' ? CircleAlert : RefreshCw;

  return (
    <>
      <div className="openCarResourceTreeToolbar" data-outline-refresh-state={refreshState}>
        <div className="openCarResourceTreeStatus" data-tone={statusTone}>
          <StatusIcon size={14} aria-hidden="true" className={refreshBusy ? 'isRefreshing' : ''} />
          <span title={refreshMessage}>{refreshMessage}</span>
        </div>
        <div className="openCarResourceTreeControls">
          <label title="显示官方语义模型中的关系和隐式元素">
            <input type="checkbox" checked={showExpertNodes} onChange={(event) => onToggleExpertNodes(event.currentTarget.checked)} />
            关系/隐式元素
          </label>
          <button type="button" aria-label="刷新模型资源树" title="刷新模型资源树" disabled={refreshBusy} onClick={onRefresh}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {!semanticOutline ? (
        <p className="openCarResourceTreeEmpty">{refreshBusy ? '正在读取当前工作区的官方语义结构…' : '模型资源树会在停止编辑后自动生成。'}</p>
      ) : semanticOutline.status === 'invalid' ? (
        <p className="openCarResourceTreeEmpty">当前代码未通过官方解析，暂无可展示的语义结构。</p>
      ) : semanticOutline.status !== 'available' ? (
        <p className="openCarResourceTreeEmpty">官方语义服务暂不可用，请稍后刷新。</p>
      ) : !outlineTree.items.length ? (
        <p className="openCarResourceTreeEmpty">当前模型没有可展示的用户语义对象。</p>
      ) : (
        <MuiModelOutlineTree
          key={`${semanticOutline.contentHash}:${showExpertNodes ? 'expert' : 'document'}`}
          items={outlineTree.items}
          defaultExpandedItems={outlineTree.defaultExpandedItems}
          onItemClick={(itemId) => {
            const node = outlineTree.nodeByItemId.get(itemId);
            if (node) onSelect(node);
          }}
        />
      )}
    </>
  );
}

function buildSemanticOutlineTreeItems(nodes: SemanticOutlineNode[], showExpertNodes: boolean): {
  items: MuiModelTreeItem[];
  defaultExpandedItems: string[];
  nodeByItemId: Map<string, SemanticOutlineNode>;
} {
  const nodeByItemId = new Map<string, SemanticOutlineNode>();
  const defaultExpandedItems: string[] = [];
  const visit = (node: SemanticOutlineNode, depth: number): MuiModelTreeItem[] => {
    if (!showExpertNodes && isTechnicalSemanticOutlineDetail(node)) return [];
    const promoteChildren = (!showExpertNodes && isExpertSemanticOutlineNode(node)) || (depth === 0 && isTechnicalSemanticOutlineRoot(node));
    const childItems = (node.children || []).flatMap((child) => visit(child, promoteChildren ? depth : depth + 1));
    if (promoteChildren) return childItems;
    const itemId = `semantic:${node.id}`;
    nodeByItemId.set(itemId, node);
    if (depth === 0) defaultExpandedItems.push(itemId);
    return [{
      id: itemId,
      label: semanticOutlineNodeName(node),
      kindLabel: semanticOutlineKindLabel(node),
      iconKey: semanticOutlineIconKey(node),
      isImplicit: Boolean(node.isImplicit),
      title: semanticOutlineNodeTitle(node),
      children: childItems.length ? childItems : undefined
    }];
  };
  return { items: nodes.flatMap((node) => visit(node, 0)), defaultExpandedItems, nodeByItemId };
}

function isTechnicalSemanticOutlineRoot(node: SemanticOutlineNode): boolean {
  if (node.declaredName || node.qualifiedName) return false;
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  return /(?:^|\s)(?:Root|Namespace|Element)(?:$|\s)/.test(kind) && (!node.name || node.name === node.metaclass || node.name === node.displayKind);
}

function isExpertSemanticOutlineNode(node: SemanticOutlineNode): boolean {
  const kind = `${node.metaclass || ''} ${node.displayKind || ''}`;
  return Boolean(node.isImplicit) || /Membership|Subclassification|Subsetting|Redefinition|TypeFeaturing|FeatureTyping|FeatureValue|FeatureChaining/.test(kind);
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
  const parts = String(value || '').split('::');
  return parts[parts.length - 1] || '';
}

function SettlementContent({ tab, activeCase, result }: { tab: ResultTab; activeCase: OpenCarCaseId; result: OpenCarAnalysisCase }) {
  if (tab === 'compare') {
    return (
      <div className="openCarCompare">
        <Metric label="长度差 Domain-Zonal" value={`${formatSigned(OPEN_CAR_ANALYSIS.domain.summary.lengthM - OPEN_CAR_ANALYSIS.zonal.summary.lengthM, 3)} m`} />
        <Metric label="质量差 Domain-Zonal" value={`${formatSigned(OPEN_CAR_ANALYSIS.domain.summary.massKg - OPEN_CAR_ANALYSIS.zonal.summary.massKg, 3)} kg`} />
        <Metric label="成本差 Domain-Zonal" value={`${formatSigned(OPEN_CAR_ANALYSIS.domain.summary.costEur - OPEN_CAR_ANALYSIS.zonal.summary.costEur, 3)} EUR`} />
        <p>对比结论：域控制架构减少连接数量，但当前固定几何参数下线束长度和质量更高；Zonal 架构存在 1 个 ASIL mismatch，需要通过硬件等级或功能部署调整闭合。</p>
      </div>
    );
  }
  const cards: Array<[string, string | number]> = [
    ['连接数', result.summary.connections],
    ['线束长度', `${formatNumber(result.summary.lengthM, activeCase === 'zonal' ? 3 : 2)} m`],
    ['线束质量', `${formatNumber(result.summary.massKg, 4)} kg`],
    ['成本', `${formatNumber(result.summary.costEur, 3)} EUR`],
    ['跨区连接', result.summary.crossZone],
    ['ASIL mismatch', result.summary.asilMismatches]
  ];
  if (tab === 'latency') {
    return <RowsTable summary={cards} headers={['路径', '节点', '总延迟', '预算', '状态']} rows={result.latency.map((row) => [row.path, row.nodes, `${row.totalUs.toFixed(2)} us`, `${row.budgetUs} us`, row.status])} />;
  }
  if (tab === 'throughput') {
    return <RowsTable summary={cards} headers={['链路', '信号', '流量', '利用率', '状态']} rows={result.throughput.map((row) => [row.link, row.signal, `${row.trafficMbps} Mbps`, `${row.utilization}%`, row.status])} />;
  }
  if (tab === 'safety') {
    return (
      <div className="openCarSafety">
        <div className="openCarSummaryCards">{cards.map(([label, value]) => <Metric key={label} label={String(label)} value={String(value)} />)}</div>
        <div className="openCarList">
          {result.safety.requiredComputeAsil.map(([component, asil]) => <article key={component}><strong>{component}</strong><span>required ASIL {asil}</span></article>)}
          {result.safety.mismatches.length ? result.safety.mismatches.map((item) => <article key={item} className="danger"><strong>Mismatch</strong><span>{item}</span></article>) : <article><strong>安全筛查</strong><span>未发现 ASIL mismatch</span></article>}
        </div>
      </div>
    );
  }
  return <RowsTable summary={cards} headers={['起点', '终点', '信号', '长度', '质量', '成本']} rows={result.connections.map((row) => [row.start, row.end, row.signal, `${row.lengthM} m`, `${row.massKg} kg`, `${row.costEur} EUR`])} />;
}

function RowsTable({ summary, headers, rows }: { summary: Array<[string, string | number]>; headers: string[]; rows: string[][] }) {
  return (
    <>
      <div className="openCarSummaryCards">
        {summary.map(([label, value]) => <Metric key={label} label={String(label)} value={String(value)} />)}
      </div>
      <table className="openCarTable">
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0]}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function traceLabel(type: OpenCarTraceLink['resultType']) {
  if (type === 'connection') return '连接推导';
  if (type === 'allocation') return '分配推导';
  return '论文端点';
}

function normalizeDiagnostics(result: ValidationResult | null): ValidationFinding[] {
  if (!result) return [];
  if (Array.isArray(result.diagnostics)) return result.diagnostics;
  if (Array.isArray(result.findings)) return result.findings;
  return [];
}

function isValidationPassed(result: ValidationResult): boolean {
  const record = result as Record<string, unknown>;
  if (typeof record.syntaxValid === 'boolean' || typeof record.semanticValid === 'boolean') {
    return Boolean(record.syntaxValid) && Boolean(record.semanticValid);
  }
  return Boolean(result.passed || result.ok) && normalizeDiagnostics(result).every((finding) => finding.severity !== 'error');
}

function focusLine(content: string, line: number, editorRef: MutableRefObject<SysmlCodeMirrorHandle | null>) {
  const safeLine = Math.max(1, line);
  let offset = 0;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < safeLine - 1 && index < lines.length; index += 1) {
    offset += lines[index].length + 1;
  }
  editorRef.current?.focusRange(offset, Math.min(content.length, offset + (lines[safeLine - 1]?.length || 1)));
}

function formatNumber(value: number, digits: number) {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

function formatSigned(value: number, digits: number) {
  const formatted = formatNumber(value, digits);
  return value >= 0 ? `+${formatted}` : formatted;
}
