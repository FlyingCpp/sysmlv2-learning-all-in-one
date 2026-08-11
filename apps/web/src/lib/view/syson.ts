import type { WorkspaceSnapshot } from '../course/types';

export interface SysonAnalyzeResult {
  selectedViewName?: string;
  generatedViewCandidate?: {
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SysonRenderResult {
  ok?: boolean;
  sysonUrl?: string;
  embedUrl?: string;
  embedUrls?: Record<string, string>;
  iframe?: {
    src?: string;
    [key: string]: unknown;
  };
  selectedView?: {
    label?: string;
    [key: string]: unknown;
  };
  generatedView?: {
    name?: string;
    [key: string]: unknown;
  };
  representation?: {
    label?: string;
    [key: string]: unknown;
  };
  viewPolicy?: {
    usedGeneratedView?: boolean;
    [key: string]: unknown;
  };
  autoVisibility?: {
    applied?: boolean;
    error?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function normalizedSysonBase(value?: string | null): string {
  return String(value || '').replace(/\/$/, '');
}

export function sysonConfigured(value?: string | null): boolean {
  return Boolean(normalizedSysonBase(value));
}

export function sysonViewRequestBody(workspace: WorkspaceSnapshot, projectName = 'react-workbench') {
  return {
    projectName,
    entryFile: workspace.entryFile || workspace.activeFilePath || workspace.files?.[0]?.path || 'main.sysml',
    files: (workspace.files || []).map((file) => ({
      path: file.path || 'main.sysml',
      content: String(file.content || '')
    })),
    autoGenerateView: true,
    requireExplicitView: false,
    embedMode: 'explorer'
  };
}

export function sysonEmbedUrl(result: SysonRenderResult): string {
  return result.embedUrl || result.iframe?.src || result.embedUrls?.explorer || '';
}

export function sysonOpenUrl(result: SysonRenderResult): string {
  return result.sysonUrl || sysonEmbedUrl(result);
}

export function sysonViewLabel(result: SysonRenderResult, analysis?: SysonAnalyzeResult | null): string {
  return (
    result.selectedView?.label
    || result.generatedView?.name
    || analysis?.selectedViewName
    || analysis?.generatedViewCandidate?.name
    || '当前模型'
  );
}

export function friendlySysONError(error: unknown, sysonBase = ''): string {
  const message = String(error instanceof Error ? error.message : error || '');
  if (/地址未配置|not configured/i.test(message) || !normalizedSysonBase(sysonBase)) {
    return 'SysON view service 地址未配置。当前部署仅启用课程与 PlantUML/SVG 视图。';
  }
  if (/Failed to fetch|NetworkError|Load failed|proxy failed|ECONNREFUSED|upstream|fetch failed/i.test(message)) {
    return `无法连接 SysON view service。请确认 ${normalizedSysonBase(sysonBase)} 已启动，并且 SysON 与官方 validator 正常运行。`;
  }
  if (/No explicit SysML view/i.test(message)) {
    return '本课程要求代码中显式定义 view。请先补充 view/expose，再生成图形视图。';
  }
  if (/No SysML view found/i.test(message)) {
    return '当前代码没有可渲染的 view，且服务没有生成临时视图。请至少定义一个模型元素，或补充 view/expose。';
  }
  if (/Validator returned|syntax|semantic|validation/i.test(message)) {
    return `SysON 导入前校验未通过：${message}`;
  }
  return message || 'SysON 视图生成失败。';
}
