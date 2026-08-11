import { ExternalLink, Maximize2, Minus, Plus, Scan, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref
} from 'react';
import { useRuntimeConfigStore } from '../../app/runtime-config-store';
import { useAppApiClient } from '../../app/use-api-client';
import type { WorkspaceSnapshot } from '../../lib/course/types';
import { workspaceTemplateSignature } from '../../lib/course/workspace';
import {
  friendlyPlantUmlError,
  plantUmlRequestBody,
  plantUmlSuccessMessage,
  plantUmlViewportFit,
  plantUmlViewOptions,
  type PlantUmlRenderResult
} from '../../lib/view/plantuml';
import {
  friendlySysONError,
  normalizedSysonBase,
  sysonConfigured,
  sysonEmbedUrl,
  sysonOpenUrl,
  sysonViewLabel,
  sysonViewRequestBody,
  type SysonAnalyzeResult,
  type SysonRenderResult
} from '../../lib/view/syson';

type ViewTab = 'plantuml' | 'syson';
type ViewState = 'idle' | 'working' | 'ok' | 'fail';

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

const MIN_VIEW_SCALE = 0.05;
const MAX_VIEW_SCALE = 4;
const AUTO_FIT_MAX_SCALE = 1;
const VIEW_ZOOM_STEP = 1.2;
const VIEW_FIT_PADDING = 12;

interface ViewPaneProps {
  sectionRef?: Ref<HTMLElement>;
  workspace: WorkspaceSnapshot;
  validationPassed: boolean;
  courseRulesPassed?: boolean;
  isValidating: boolean;
  projectName: string;
  autoRenderRequestId?: number;
  autoRenderTarget?: ViewTab;
  preferredPlantUmlViewName?: string;
  onActiveTabChange?: (target: ViewTab) => void;
  requiresCourseRules?: boolean;
}

export function ViewPane({ sectionRef, workspace, validationPassed, courseRulesPassed = true, isValidating, projectName, autoRenderRequestId = 0, autoRenderTarget = 'plantuml', preferredPlantUmlViewName = '', onActiveTabChange, requiresCourseRules = true }: ViewPaneProps) {
  const api = useAppApiClient();
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const sysonBase = runtimeConfig?.sysonViewServiceUrl || '';
  const sysonTool = runtimeConfig?.externalModelingTools?.find((tool) => tool.toolId === 'syson');
  const sysonVisible = Boolean(sysonTool?.enabled && sysonTool.frontendVisible && sysonBase);
  const lastAutoRenderRequestRef = useRef(0);
  const renderRequestRevisionRef = useRef(0);
  const plantUmlCacheRef = useRef(new Map<string, PlantUmlRenderResult>());
  const displayedPlantUmlViewRef = useRef('');
  const [activeTab, setActiveTab] = useState<ViewTab>('plantuml');
  const [viewState, setViewState] = useState<ViewState>('idle');
  const [status, setStatus] = useState('校验通过前不会生成视图。');
  const [plantUmlResult, setPlantUmlResult] = useState<PlantUmlRenderResult | null>(null);
  const [selectedPlantUmlView, setSelectedPlantUmlView] = useState('');
  const [sysonResult, setSysonResult] = useState<(SysonRenderResult & { analysis?: SysonAnalyzeResult }) | null>(null);
  const sysonReady = sysonConfigured(sysonBase);
  const showSysonToolbar = activeTab === 'syson' && Boolean(sysonResult && sysonOpenUrl(sysonResult));
  const plantUmlViews = useMemo(() => plantUmlViewOptions(workspace), [workspace]);
  const preferredPlantUmlView = plantUmlViews.find((view) => (
    view.qualifiedName === preferredPlantUmlViewName || view.name === preferredPlantUmlViewName
  ));
  const plantUmlViewKey = plantUmlViews.map((view) => view.qualifiedName).join('\u0000');
  const workspaceSignature = useMemo(
    () => workspaceTemplateSignature(workspace.files || [], workspace.entryFile || ''),
    [workspace.entryFile, workspace.files]
  );
  const workspaceSignatureRef = useRef(workspaceSignature);
  workspaceSignatureRef.current = workspaceSignature;

  useEffect(() => {
    if (sysonVisible || activeTab !== 'syson') return;
    setActiveTab('plantuml');
    onActiveTabChange?.('plantuml');
  }, [activeTab, onActiveTabChange, sysonVisible]);

  useEffect(() => {
    renderRequestRevisionRef.current += 1;
    displayedPlantUmlViewRef.current = '';
    setPlantUmlResult(null);
    setSysonResult(null);
    setViewState('idle');
    setStatus('等待官方语法/语义校验通过后生成视图。');
  }, [workspaceSignature]);

  useEffect(() => {
    setSelectedPlantUmlView((current) => (
      current && plantUmlViews.some((view) => view.qualifiedName === current)
        ? current
        : preferredPlantUmlView?.qualifiedName || ''
    ));
  }, [plantUmlViewKey, preferredPlantUmlView?.qualifiedName]);

  const renderPlantUml = async (requestedViewName = selectedPlantUmlView) => {
    const cacheKey = `${workspaceSignature}\u0000${requestedViewName}`;
    const cached = plantUmlCacheRef.current.get(cacheKey);
    if (cached?.ok && cached.svg) {
      displayedPlantUmlViewRef.current = requestedViewName;
      setPlantUmlResult(cached);
      setViewState('ok');
      setStatus(`${plantUmlSuccessMessage(cached)} 已从当前代码的视图缓存即时切换。${courseStatusSuffix(requiresCourseRules, courseRulesPassed)}`);
      return;
    }
    const requestRevision = ++renderRequestRevisionRef.current;
    setViewState('working');
    const requestedView = plantUmlViews.find((view) => view.qualifiedName === requestedViewName);
    setStatus(requestedView
      ? `正在用官方 PlantUML/SVG 渲染 ${requestedView.name}...`
      : '正在用官方 PlantUML/SVG 自动选择并渲染模型 view...');
    try {
      const result = await api.request<PlantUmlRenderResult>('/api/plantuml', {
        method: 'POST',
        body: plantUmlRequestBody(workspace, requestedViewName)
      });
      if (!result.ok || !result.svg) throw new Error(friendlyPlantUmlError(null, result));
      if (requestRevision !== renderRequestRevisionRef.current || workspaceSignature !== workspaceSignatureRef.current) return;
      plantUmlCacheRef.current.set(cacheKey, result);
      trimPlantUmlCache(plantUmlCacheRef.current);
      displayedPlantUmlViewRef.current = requestedViewName;
      setPlantUmlResult(result);
      setViewState('ok');
      setStatus(`${plantUmlSuccessMessage(result)}${courseStatusSuffix(requiresCourseRules, courseRulesPassed)}`);
    } catch (error) {
      if (requestRevision !== renderRequestRevisionRef.current || workspaceSignature !== workspaceSignatureRef.current) return;
      setViewState('fail');
      if (plantUmlResult?.svg) {
        setSelectedPlantUmlView(displayedPlantUmlViewRef.current);
        setStatus(`${friendlyPlantUmlError(error)} 已保留上一视图。`);
      } else {
        setStatus(friendlyPlantUmlError(error));
        setPlantUmlResult(null);
      }
    }
  };

  const renderSysON = async () => {
    if (!sysonReady) {
      setViewState('fail');
      setStatus(friendlySysONError(new Error('SysON view service 地址未配置。'), sysonBase));
      return;
    }
    const base = normalizedSysonBase(sysonBase);
    setViewState('working');
    setStatus('正在导入 SysML v2 代码并生成 SysON 原生视图...');
    setSysonResult(null);
    try {
      const payload = sysonViewRequestBody(workspace, projectName);
      const analysis = await postSyson<SysonAnalyzeResult>(`${base}/api/analyze`, payload);
      const selectedViewName = analysis.selectedViewName || analysis.generatedViewCandidate?.name || '';
      setStatus(selectedViewName ? `正在生成 ${selectedViewName} 的 SysON 原生视图...` : '正在生成临时 SysON 原生视图...');
      const result = await postSyson<SysonRenderResult>(`${base}/api/render`, {
        ...payload,
        viewName: selectedViewName
      });
      setSysonResult({ ...result, analysis });
      setViewState('ok');
      setStatus(`${sysonViewLabel(result, analysis)} 的 SysON 原生视图已生成。`);
    } catch (error) {
      setViewState('fail');
      setStatus(friendlySysONError(error, sysonBase));
      setSysonResult(null);
    }
  };

  useEffect(() => {
    if (!autoRenderRequestId || autoRenderRequestId === lastAutoRenderRequestRef.current) return;
    lastAutoRenderRequestRef.current = autoRenderRequestId;
    if (!validationPassed) return;
    const target = autoRenderTarget === 'syson' && !sysonVisible ? 'plantuml' : autoRenderTarget;
    setActiveTab(target);
    onActiveTabChange?.(target);
    if (target === 'syson') {
      void renderSysON();
      return;
    }
    void renderPlantUml();
  }, [autoRenderRequestId, autoRenderTarget, sysonVisible]);

  const selectPlantUmlView = (viewName: string) => {
    setSelectedPlantUmlView(viewName);
    if (!validationPassed) {
      const selected = plantUmlViews.find((view) => view.qualifiedName === viewName);
      setStatus(selected
        ? `已选择 ${selected.name}；官方语法/语义校验通过后即可生成。`
        : '已选择平台自动视图；官方语法/语义校验通过后即可生成。');
      return;
    }
    void renderPlantUml(viewName);
  };

  return (
    <section ref={sectionRef} className="viewPane phase4ViewPane" data-view-pane data-view-state={viewState}>
      <header className="viewPaneHeader">
        <div>
          <h3>教学视图</h3>
          <p data-view-status>{status}</p>
        </div>
        <span className="viewAutoRenderHint">校验通过后自动生成</span>
      </header>

      <div className="viewTabs" role="tablist" aria-label="视图渲染方式">
        <button
          type="button"
          role="tab"
          data-view-tab="plantuml"
          aria-selected={activeTab === 'plantuml'}
          onClick={() => { setActiveTab('plantuml'); onActiveTabChange?.('plantuml'); }}
        >
          PlantUML 教学图
        </button>
        {sysonVisible ? (
          <button
            type="button"
            role="tab"
            data-view-tab="syson"
            aria-selected={activeTab === 'syson'}
            disabled={!sysonReady}
            data-syson-disabled={!sysonReady}
            onClick={() => { setActiveTab('syson'); onActiveTabChange?.('syson'); }}
          >
            SysON 原生视图
          </button>
        ) : null}
      </div>

      {activeTab === 'plantuml' && plantUmlViews.length > 1 ? (
        <div className="viewToolbar plantUmlViewSelectorToolbar" data-plantuml-view-selector-toolbar>
          <label className="plantUmlViewSelector">
            <span>模型 view</span>
            <select
              data-plantuml-view-select
              aria-label="选择 PlantUML 模型 view"
              value={selectedPlantUmlView}
              disabled={isValidating || viewState === 'working'}
              onChange={(event) => selectPlantUmlView(event.currentTarget.value)}
            >
              <option value="">自动选择（平台默认）</option>
              {plantUmlViews.map((view) => (
                <option key={view.qualifiedName} value={view.qualifiedName}>{view.name}</option>
              ))}
            </select>
          </label>
          <span data-plantuml-view-count>检测到 {plantUmlViews.length} 个显式 view；首次按需渲染，已查看视图即时切换。</span>
        </div>
      ) : null}

      {showSysonToolbar ? (
        <div data-syson-toolbar className="viewToolbar">
          <a data-view-open href={sysonResult ? sysonOpenUrl(sysonResult) : '#'} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />在 SysON 打开
          </a>
        </div>
      ) : null}

      <div
        className="viewFrameMount"
        data-plantuml-frame-mount
        aria-busy={viewState === 'working'}
        hidden={activeTab !== 'plantuml'}
      >
        {plantUmlResult?.svg ? (
          <PlantUmlViewport svgMarkup={plantUmlResult.svg} allowFullscreen />
        ) : (
          <ViewPlaceholder
            state={viewState}
            title="等待官方语法/语义校验通过后生成 PlantUML/SVG view"
            requiresCourseRules={requiresCourseRules}
          />
        )}
        {viewState === 'working' && plantUmlResult?.svg ? (
          <div className="plantUmlSwitchingNotice" data-plantuml-switching role="status">
            正在切换模型 view，当前画布保持显示。
          </div>
        ) : null}
      </div>

      {sysonVisible ? <div className="viewFrameMount" data-syson-frame-mount hidden={activeTab !== 'syson'}>
        {sysonResult && sysonEmbedUrl(sysonResult) ? (
          <iframe title="SysON 原生视图" data-syson-frame src={sysonEmbedUrl(sysonResult)} />
        ) : (
          <ViewPlaceholder
            state={viewState}
            title={sysonReady ? '等待生成 SysON 原生 view' : 'SysON view service 未配置'}
            requiresCourseRules={requiresCourseRules}
          />
        )}
      </div> : null}
    </section>
  );
}

export function PlantUmlViewport({ svgMarkup, allowFullscreen = false }: { svgMarkup: string; allowFullscreen?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const pointerRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  const fittedRef = useRef(true);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenCloseButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenTitleId = useId();
  const [transform, setTransformState] = useState<ViewTransform>(transformRef.current);
  const [intrinsicSize, setIntrinsicSize] = useState<{ width: number; height: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fitMode, setFitMode] = useState<'width' | 'contain'>('contain');

  const setTransform = useCallback((next: ViewTransform) => {
    transformRef.current = next;
    setTransformState(next);
  }, []);

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector<SVGSVGElement>('.plantUmlSvgCanvas > svg');
    if (!viewport || !svg) return;
    const size = svgIntrinsicSize(svg);
    if (!size) return;
    const fitted = plantUmlViewportFit({
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      svgWidth: size.width,
      svgHeight: size.height,
      padding: VIEW_FIT_PADDING,
      minimumScale: MIN_VIEW_SCALE,
      maximumScale: AUTO_FIT_MAX_SCALE
    });
    setIntrinsicSize((current) => current?.width === size.width && current.height === size.height ? current : size);
    setFitMode(fitted.mode);
    setTransform({ x: fitted.x, y: fitted.y, scale: fitted.scale });
    fittedRef.current = true;
  }, [setTransform]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const focusX = clientX === undefined ? viewport.clientWidth / 2 : clientX - rect.left;
    const focusY = clientY === undefined ? viewport.clientHeight / 2 : clientY - rect.top;
    const current = transformRef.current;
    const scale = clamp(current.scale * factor, MIN_VIEW_SCALE, MAX_VIEW_SCALE);
    if (scale === current.scale) return;
    const ratio = scale / current.scale;
    setTransform({
      x: focusX - (focusX - current.x) * ratio,
      y: focusY - (focusY - current.y) * ratio,
      scale
    });
    fittedRef.current = false;
  }, [setTransform]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const animationFrame = window.requestAnimationFrame(fitView);
    const observer = new ResizeObserver(() => {
      if (fittedRef.current) fitView();
    });
    observer.observe(viewport);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [fitView, svgMarkup]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [zoomAt]);

  useEffect(() => {
    if (!isFullscreen) return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    fullscreenCloseButtonRef.current?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsFullscreen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      fullscreenButtonRef.current?.focus({ preventScroll: true });
    };
  }, [isFullscreen]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pointer.clientX;
    const deltaY = event.clientY - pointer.clientY;
    if (!deltaX && !deltaY) return;
    pointerRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    const current = transformRef.current;
    setTransform({ ...current, x: current.x + deltaX, y: current.y + deltaY });
    fittedRef.current = false;
  };

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerRef.current?.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const stopToolbarPointer = (event: ReactPointerEvent<HTMLDivElement>) => event.stopPropagation();
  const zoomPercent = Math.round(transform.scale * 100);

  return (
    <div
      ref={viewportRef}
      className={`plantUmlSvgFrame${isDragging ? ' isDragging' : ''}`}
      data-plantuml-svg
      data-plantuml-interactive-viewport
      data-plantuml-fit-mode={fitMode}
      role="region"
      aria-label="PlantUML 模型视图，可拖动和缩放"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
    >
      <div
        className="plantUmlViewToolbar"
        data-plantuml-view-toolbar
        aria-label="模型视图缩放工具"
        onPointerDown={stopToolbarPointer}
      >
        <button type="button" aria-label="缩小模型视图" title="缩小" onClick={() => zoomAt(1 / VIEW_ZOOM_STEP)}>
          <Minus size={16} aria-hidden="true" />
        </button>
        <output data-plantuml-zoom aria-label={`当前缩放 ${zoomPercent}%`}>{zoomPercent}%</output>
        <button type="button" aria-label="放大模型视图" title="放大" onClick={() => zoomAt(VIEW_ZOOM_STEP)}>
          <Plus size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label="适配模型视图" title="适配视图" onClick={fitView}>
          <Scan size={16} aria-hidden="true" />
        </button>
        {allowFullscreen ? (
          <button
            ref={fullscreenButtonRef}
            type="button"
            data-plantuml-fullscreen-action
            aria-label="全屏查看模型视图"
            aria-expanded={isFullscreen}
            title="全屏查看"
            onClick={() => setIsFullscreen(true)}
          >
            <Maximize2 size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div
        className="plantUmlSvgCanvas"
        data-plantuml-svg-canvas
        style={{
          left: transform.x,
          top: transform.y,
          width: intrinsicSize ? intrinsicSize.width * transform.scale : undefined,
          height: intrinsicSize ? intrinsicSize.height * transform.scale : undefined
        }}
        dangerouslySetInnerHTML={{ __html: svgMarkup }}
      />
      {isFullscreen && typeof document !== 'undefined' ? createPortal(
        <div
          className="aiTeacherPlantUmlBackdrop"
          data-maximized="true"
          data-plantuml-fullscreen-backdrop
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={() => setIsFullscreen(false)}
        >
          <section
            className="aiTeacherPlantUmlDialog"
            data-maximized="true"
            data-plantuml-fullscreen-dialog
            role="dialog"
            aria-modal="true"
            aria-labelledby={fullscreenTitleId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2 id={fullscreenTitleId}>PlantUML 模型视图</h2>
                <p>全屏查看当前建模画布生成的教学视图。</p>
              </div>
              <div className="aiTeacherPlantUmlHeaderActions">
                <button
                  ref={fullscreenCloseButtonRef}
                  type="button"
                  aria-label="退出全屏"
                  title="退出全屏"
                  onClick={() => setIsFullscreen(false)}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="aiTeacherPlantUmlBody">
              <div className="aiTeacherPlantUmlCanvas">
                <PlantUmlViewport svgMarkup={svgMarkup} />
              </div>
            </div>
          </section>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

function svgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const viewBox = svg.viewBox?.baseVal;
  const width = viewBox?.width || svg.width?.baseVal?.value || 0;
  const height = viewBox?.height || svg.height?.baseVal?.value || 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function ViewPlaceholder({ state, title, requiresCourseRules }: { state: ViewState; title: string; requiresCourseRules: boolean }) {
  return (
    <div className={`viewFramePlaceholder ${state === 'fail' ? 'viewFrameError' : ''}`}>
      <strong>{title}</strong>
      <p>{requiresCourseRules
        ? '视图以当前编辑器内容和官方语法/语义校验为前置条件；课程规则只决定任务是否完成。'
        : '视图以当前编辑器内容和官方语法/语义校验结果为前置条件。'}</p>
    </div>
  );
}

function courseStatusSuffix(requiresCourseRules: boolean, courseRulesPassed: boolean): string {
  return requiresCourseRules && !courseRulesPassed ? ' 课程任务尚未完成。' : '';
}

function trimPlantUmlCache(cache: Map<string, PlantUmlRenderResult>, maximumEntries = 16): void {
  while (cache.size > maximumEntries) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') return;
    cache.delete(oldest);
  }
}

async function postSyson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok || (payload as { ok?: boolean }).ok === false) {
    const message = (payload as { error?: string | { message?: string } }).error;
    throw new Error(typeof message === 'string' ? message : message?.message || `SysON view service returned ${response.status}`);
  }
  return payload as T;
}
