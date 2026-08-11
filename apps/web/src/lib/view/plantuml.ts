import type { WorkspaceSnapshot } from '../course/types';

export interface PlantUmlViewOption {
  name: string;
  qualifiedName: string;
  sourcePath: string;
}

export interface PlantUmlViewportFit {
  mode: 'width' | 'contain';
  x: number;
  y: number;
  scale: number;
}

export function plantUmlViewportFit({
  viewportWidth,
  viewportHeight,
  svgWidth,
  svgHeight,
  padding = 12,
  minimumScale = 0.05,
  maximumScale = 4,
  tallAspectRatio = 1.8
}: {
  viewportWidth: number;
  viewportHeight: number;
  svgWidth: number;
  svgHeight: number;
  padding?: number;
  minimumScale?: number;
  maximumScale?: number;
  tallAspectRatio?: number;
}): PlantUmlViewportFit {
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const isTall = svgHeight / Math.max(svgWidth, 1) >= tallAspectRatio;
  const requestedScale = isTall
    ? availableWidth / Math.max(svgWidth, 1)
    : Math.min(
      availableWidth / Math.max(svgWidth, 1),
      availableHeight / Math.max(svgHeight, 1)
    );
  const scale = Math.min(maximumScale, Math.max(minimumScale, requestedScale));
  return {
    mode: isTall ? 'width' : 'contain',
    x: (viewportWidth - svgWidth * scale) / 2,
    y: isTall ? padding : (viewportHeight - svgHeight * scale) / 2,
    scale
  };
}

export interface PlantUmlRenderResult {
  ok?: boolean;
  svg?: string;
  viewName?: string;
  styles?: string[];
  layoutOptimization?: {
    mode?: string;
    selected?: string;
    attempted?: number;
    switched?: boolean;
    reason?: string;
    score?: number;
    defaultScore?: number;
  };
  generatedView?: {
    name?: string;
    type?: string;
    exposes?: Array<{ name?: string; qualifiedName?: string; kind?: string; typeName?: string | null }>;
    entryFile?: string;
  } | null;
  viewPolicy?: {
    usedGeneratedView?: boolean;
    reason?: string;
  };
  diagnostics?: Array<{ message?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export function plantUmlRequestBody(workspace: WorkspaceSnapshot, viewName = '') {
  const selectedViewName = String(viewName || '').trim();
  return {
    files: (workspace.files || []).map((file) => ({
      path: file.path || 'main.sysml',
      content: String(file.content || ''),
      loadPolicy: file.loadPolicy || 'always'
    })),
    entryFile: workspace.entryFile || workspace.activeFilePath || workspace.files?.[0]?.path || 'main.sysml',
    layoutOptimization: { mode: 'auto' },
    ...(selectedViewName ? { viewName: selectedViewName } : {})
  };
}

export function plantUmlViewOptions(workspace: WorkspaceSnapshot): PlantUmlViewOption[] {
  const nameSource = String.raw`(?:[A-Za-z_][\w]*|'(?:\\.|[^'])*')`;
  const entryFile = workspace.entryFile || workspace.activeFilePath || workspace.files?.[0]?.path || 'main.sysml';
  const file = (workspace.files || []).find((candidate) => candidate.path === entryFile) || workspace.files?.[0];
  if (!file) return [];
  const seen = new Set<string>();
  const options: PlantUmlViewOption[] = [];
  const content = maskSysmlCommentsAndStrings(String(file.content || ''));
  const packageOpenings = new Map<number, string>();
  const packagePattern = new RegExp(`\\bpackage\\s+(${nameSource})\\s*\\{`, 'g');
  for (const match of content.matchAll(packagePattern)) {
    packageOpenings.set(match.index + match[0].lastIndexOf('{'), match[1]);
  }
  const viewPattern = new RegExp(`(?:^|\\n)\\s*view\\s+(?!def\\b)(${nameSource})\\s*(?::[^;{\\n]+)?\\s*(?:\\{|;)`, 'g');
  const viewsByOffset = new Map<number, string[]>();
  for (const match of content.matchAll(viewPattern)) {
    const offset = match.index + match[0].indexOf('view');
    viewsByOffset.set(offset, [...(viewsByOffset.get(offset) || []), match[1]]);
  }
  let depth = 0;
  const packageScopes: Array<{ token: string; depth: number }> = [];
  for (let offset = 0; offset < content.length; offset += 1) {
    for (const viewToken of viewsByOffset.get(offset) || []) {
      const packageName = packageScopes.map((scope) => scope.token).join('::');
      const qualifiedName = packageName ? `${packageName}::${viewToken}` : viewToken;
      if (seen.has(qualifiedName)) continue;
      seen.add(qualifiedName);
      options.push({
        name: decodeSysmlName(viewToken),
        qualifiedName,
        sourcePath: file.path || 'main.sysml'
      });
    }
    if (content[offset] === '{') {
      depth += 1;
      const packageToken = packageOpenings.get(offset);
      if (packageToken) packageScopes.push({ token: packageToken, depth });
    } else if (content[offset] === '}') {
      while (packageScopes.at(-1)?.depth === depth) packageScopes.pop();
      depth = Math.max(0, depth - 1);
    }
  }
  return options;
}

function maskSysmlCommentsAndStrings(content: string): string {
  let output = '';
  let state: 'code' | 'line-comment' | 'block-comment' | 'double-string' = 'code';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (state === 'code' && char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (state === 'code' && char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (state === 'code' && char === '"') {
      output += ' ';
      state = 'double-string';
    } else if (state === 'line-comment') {
      output += char === '\n' || char === '\r' ? char : ' ';
      if (char === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
      }
    } else if (state === 'double-string') {
      if (char === '\\' && next !== undefined) {
        output += '  ';
        index += 1;
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        if (char === '"') state = 'code';
      }
    } else {
      output += char;
    }
  }
  return output;
}

function decodeSysmlName(token: string): string {
  if (!token.startsWith("'") || !token.endsWith("'")) return token;
  return token.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

export function plantUmlSuccessMessage(result: PlantUmlRenderResult): string {
  return `${result.viewName || '当前模型'} 的 PlantUML/SVG 视图已生成。`;
}

export function plantUmlMetadataNotes(result: PlantUmlRenderResult | null): string[] {
  if (!result) return [];
  const layout = result.layoutOptimization;
  const officialDefault = layout?.selected === 'OFFICIAL_DEFAULT';
  const styles = Array.isArray(result.styles) && result.styles.length
    ? result.styles
    : officialDefault ? [] : String(layout?.selected || '').split('_').filter(Boolean);
  const notes = ['PlantUML/SVG 由官方 SysML v2 Pilot Implementation 生成。'];
  if (result.viewPolicy?.usedGeneratedView || result.generatedView) {
    const count = Array.isArray(result.generatedView?.exposes) ? result.generatedView.exposes.length : 0;
    notes.push(`当前图形由平台临时生成的 PlantUML view 展示，未写入你的 SysML 代码${count ? `；expose ${count} 个元素` : ''}。`);
  } else {
    notes.push('当前图形来自代码中的显式 view，或官方渲染器自动选择的模型视图。');
  }
  if (officialDefault) {
    notes.push('布局：官方 Pilot 默认布局。');
  } else if (styles.length) {
    notes.push(`布局：${styles.join(' + ')}`);
  }
  if (layout?.mode === 'official-first') {
    const attempted = Number(layout.attempted || 0);
    notes.push(`渲染策略：官方默认优先；共渲染 ${attempted || 1} 次${layout.switched ? '，已采用唯一备选布局。' : '，保持官方默认布局。'}`);
    if (layout.reason) notes.push(`原因：${layout.reason}`);
  }
  return notes;
}

export function friendlyPlantUmlError(error: unknown, result?: PlantUmlRenderResult | null): string {
  const diagnostic = result?.diagnostics?.find((item) => item?.message)?.message;
  const message = String(diagnostic || (error instanceof Error ? error.message : error) || '');
  if (/没有返回 SVG|no svg|empty/i.test(message)) {
    return '官方 PlantUML 渲染没有返回 SVG。请确认当前模型里存在可渲染的 view/expose。';
  }
  if (/syntax|semantic|validation|validator/i.test(message)) {
    return `PlantUML 渲染前校验未通过：${message}`;
  }
  if (/Element 'Namespace'|Namespace/i.test(message)) {
    return 'PlantUML 渲染器无法直接渲染当前命名空间。请补充显式 view/expose，或使用平台临时 view 重新生成。';
  }
  if (/Failed to fetch|NetworkError|Load failed|returned\s+5/i.test(message)) {
    return 'PlantUML 渲染服务暂不可用。代码不会丢失，请稍后重新生成视图。';
  }
  return message || 'PlantUML 视图生成失败。';
}
