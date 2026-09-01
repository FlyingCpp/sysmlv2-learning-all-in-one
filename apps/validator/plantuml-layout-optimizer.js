'use strict';

const crypto = require('crypto');
const { improveInterconnectionSvg } = require('./interconnection-svg-layout');

const OFFICIAL_DEFAULT_STRATEGY = { id: 'OFFICIAL_DEFAULT', styles: ['DEFAULT'] };
const FALLBACK_STRATEGIES = Object.freeze({
  'state-transition': { id: 'TB_POLYLINE_FALLBACK', styles: ['TB', 'POLYLINE'] },
  generic: { id: 'LR_POLYLINE_FALLBACK', styles: ['LR', 'POLYLINE'] }
});
const VISUAL_INTEGRITY_ISSUES = new Set(['text-overlap', 'text-out-of-bounds']);
const CACHE_MAX_ENTRIES = 80;
const CACHE_TTL_MS = 10 * 60 * 1000;
const candidateCache = new Map();

async function optimizePlantUmlLayout({ content, viewName = '', renderMode = '', renderCandidate }) {
  if (typeof renderCandidate !== 'function') {
    throw new Error('renderCandidate function is required for PlantUML layout optimization');
  }

  const candidates = [];
  const diagramKind = detectDiagramKind(content, viewName, renderMode);
  const defaultStrategy = OFFICIAL_DEFAULT_STRATEGY;
  const defaultCandidate = await renderAndScore({ content, viewName, renderMode, strategy: defaultStrategy, diagramKind, renderCandidate });
  candidates.push(defaultCandidate.summary);

  if (!defaultCandidate.result.ok || !defaultCandidate.result.svg) {
    return buildOptimizedResult(defaultCandidate.result, {
      selected: defaultStrategy,
      defaultCandidate: defaultCandidate.summary,
      candidates,
      switched: false,
      reason: '官方默认渲染未返回可检查的 SVG；布局样式重试不能修复模型或渲染服务错误。'
    });
  }

  if (visualIntegrityIssueCount(defaultCandidate.summary) === 0) {
    return buildOptimizedResult(defaultCandidate.result, {
      selected: defaultStrategy,
      defaultCandidate: defaultCandidate.summary,
      candidates,
      switched: false,
      reason: '官方默认 SVG 未检测到文字重叠或越界，仅渲染一次。'
    });
  }

  const fallbackDiagramKind = defaultCandidate.diagramKind || diagramKind;
  const fallbackStrategy = FALLBACK_STRATEGIES[fallbackDiagramKind] || FALLBACK_STRATEGIES.generic;
  const fallbackCandidate = await renderAndScore({
    content,
    viewName,
    renderMode,
    strategy: fallbackStrategy,
    diagramKind: fallbackDiagramKind,
    renderCandidate
  });
  candidates.push(fallbackCandidate.summary);
  const shouldSwitch = fallbackCandidate.summary.ok
    && visualIntegrityIssueCount(fallbackCandidate.summary) < visualIntegrityIssueCount(defaultCandidate.summary);
  const selected = shouldSwitch ? fallbackCandidate : defaultCandidate;

  return buildOptimizedResult(selected.result, {
    selected: selected.strategy,
    defaultCandidate: defaultCandidate.summary,
    candidates,
    switched: shouldSwitch,
    reason: shouldSwitch
      ? optimizedReason(defaultCandidate.summary)
      : '唯一备选布局没有减少文字重叠或越界，保持官方默认结果。'
  });
}

async function renderAndScore({ content, viewName, renderMode, strategy, diagramKind, renderCandidate }) {
  const cacheKey = cacheKeyFor({ content, viewName, renderMode, styles: strategy.styles });
  const cached = getCachedCandidate(cacheKey);
  let result;
  let cacheHit = false;

  if (cached) {
    result = cached;
    cacheHit = true;
  } else {
    try {
      result = await renderCandidate(strategy.styles);
      setCachedCandidate(cacheKey, result);
    } catch (error) {
      result = {
        ok: false,
        kind: 'ERROR',
        styles: strategy.styles,
        diagnostics: [{
          severity: 'error',
          category: 'plantuml-layout',
          message: error.message
        }]
      };
    }
  }

  const effectiveDiagramKind = diagramKindFromResolvedMode(result.resolvedRenderMode) || diagramKind;
  if (result.ok && result.svg && effectiveDiagramKind === 'interconnection') {
    const improved = improveInterconnectionSvg(result.svg);
    result = {
      ...result,
      svg: improved.svg,
      interconnectionLayout: {
        applied: improved.applied,
        reason: improved.reason,
        metrics: improved.metrics || null
      }
    };
  }
  const score = result.ok && result.svg ? scoreSvgLayout(result.svg, { diagramKind: effectiveDiagramKind }) : failedScore(result);
  if (result.interconnectionLayout?.metrics) {
    score.metrics = { ...score.metrics, ...result.interconnectionLayout.metrics };
    const partOverlapCount = Number(result.interconnectionLayout.metrics.partOverlapCount || 0);
    const nonOrthogonalConnectorCount = Number(result.interconnectionLayout.metrics.nonOrthogonalConnectorCount || 0);
    if (partOverlapCount > 0) score.issues.push('part-overlap');
    if (nonOrthogonalConnectorCount > 0) score.issues.push('non-orthogonal-connector');
    score.score = clamp(score.score - partOverlapCount * 12 - nonOrthogonalConnectorCount * 6, 0, 100);
    score.severe = score.issues.length > 0;
  }
  const summary = {
    id: strategy.id,
    styles: strategy.styles,
    ok: Boolean(result.ok && result.svg),
    score: score.score,
    severe: score.severe,
    metrics: score.metrics,
    issues: score.issues,
    cacheHit,
    diagramKind: effectiveDiagramKind
  };
  if (!summary.ok) {
    summary.error = result.diagnostics?.[0]?.message || 'PlantUML candidate did not return SVG.';
  }
  return { strategy, result: { ...result, styles: strategy.styles }, summary, diagramKind: effectiveDiagramKind };
}

function buildOptimizedResult(result, { selected, defaultCandidate, candidates, switched, reason }) {
  return {
    ...result,
    styles: selected.styles,
    layoutOptimization: {
      mode: 'official-first',
      selected: selected.id,
      default: defaultCandidate.id,
      attempted: candidates.length,
      switched,
      reason,
      score: candidates.find((candidate) => candidate.id === selected.id)?.score ?? 0,
      defaultScore: defaultCandidate.score,
      candidates
    }
  };
}

function scoreSvgLayout(svg, { diagramKind = 'generic' } = {}) {
  const box = parseSvgBox(svg);
  const shapes = collectShapeMetrics(svg, box);
  const textLayout = collectTextLayoutMetrics(svg, box);
  const textCount = countMatches(svg, /<text\b/gi);
  const edgeCount = shapes.edgeCount;
  const contentCoverage = shapes.contentCoverage;
  const aspectRatio = box.width > 0 && box.height > 0 ? box.width / box.height : 1;
  const aspectRatioPenalty = aspectPenalty(aspectRatio, diagramKind);
  const coveragePenalty = contentCoverage < 0.22 ? 24 : contentCoverage < 0.35 ? 12 : 0;
  const longEdgePenalty = Math.min(26, shapes.longEdgeCount * 5);
  const crossCanvasPenalty = Math.min(24, shapes.crossCanvasEdgeCount * 8);
  const densityPenalty = edgeCount > 0 && textCount > 0 && edgeCount / Math.max(textCount, 1) > 1.35 ? 8 : 0;
  const textOverlapPenalty = Math.min(42, textLayout.overlapCount * 4);
  const textOutOfBoundsPenalty = Math.min(42, textLayout.outOfBoundsCount * 7);
  const score = clamp(Math.round(
    100
    - aspectRatioPenalty
    - coveragePenalty
    - longEdgePenalty
    - crossCanvasPenalty
    - densityPenalty
    - textOverlapPenalty
    - textOutOfBoundsPenalty
  ), 0, 100);
  const issues = [];
  const wideLimit = diagramKind === 'state-transition' ? 40 : 3.2;
  if (aspectRatio > wideLimit) issues.push('svg-too-wide');
  if (aspectRatio < 0.5) issues.push('svg-too-tall');
  if (contentCoverage < 0.22) issues.push('low-content-coverage');
  if (shapes.crossCanvasEdgeCount >= 3) issues.push('cross-canvas-edges');
  if (textLayout.overlapCount > 0) issues.push('text-overlap');
  if (textLayout.outOfBoundsCount > 0) issues.push('text-out-of-bounds');
  const severe = issues.length > 0;

  return {
    score,
    severe,
    issues,
    metrics: {
      width: round(box.width),
      height: round(box.height),
      aspectRatio: round(aspectRatio),
      aspectRatioPenalty: round(aspectRatioPenalty),
      contentCoverage: round(contentCoverage),
      edgeCount,
      textCount,
      longEdgeCount: shapes.longEdgeCount,
      crossCanvasEdgeCount: shapes.crossCanvasEdgeCount,
      textOverlapCount: textLayout.overlapCount,
      textOutOfBoundsCount: textLayout.outOfBoundsCount
    }
  };
}

function collectTextLayoutMetrics(svg, box) {
  const textBoxes = [];
  const textRegex = /<text\b([^>]*)>[\s\S]*?<\/text>/gi;
  for (const match of String(svg || '').matchAll(textRegex)) {
    const attributes = match[1];
    const x = attrNumber(attributes, 'x');
    const y = attrNumber(attributes, 'y');
    const length = attrNumber(attributes, 'textLength');
    const fontSize = attrNumber(attributes, 'font-size');
    if (![x, y, length, fontSize].every(Number.isFinite) || length <= 0 || fontSize <= 0) continue;
    const textAnchor = String(attributes).match(/\btext-anchor=["']([^"']+)["']/i)?.[1]?.toLowerCase() || 'start';
    const left = textAnchor === 'middle' ? x - length / 2 : textAnchor === 'end' ? x - length : x;
    textBoxes.push({
      left,
      right: left + length,
      top: y - fontSize,
      bottom: y + Math.max(2, fontSize * 0.18)
    });
  }

  let overlapCount = 0;
  for (let leftIndex = 0; leftIndex < textBoxes.length; leftIndex += 1) {
    const left = textBoxes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < textBoxes.length; rightIndex += 1) {
      const right = textBoxes[rightIndex];
      const overlapWidth = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const overlapHeight = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (overlapWidth > 2 && overlapHeight > 2) overlapCount += 1;
    }
  }

  const rightBound = box.x + box.width;
  const bottomBound = box.y + box.height;
  const outOfBoundsCount = textBoxes.filter((textBox) => (
    textBox.left < box.x - 1
    || textBox.right > rightBound + 1
    || textBox.top < box.y - 1
    || textBox.bottom > bottomBound + 1
  )).length;

  return { overlapCount, outOfBoundsCount };
}

function parseSvgBox(svg) {
  const viewBoxMatch = String(svg || '').match(/\bviewBox=["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const values = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (values.length >= 4 && values[2] > 0 && values[3] > 0) {
      return { x: values[0], y: values[1], width: values[2], height: values[3] };
    }
  }
  const width = parseSvgLength(svg, 'width') || 1000;
  const height = parseSvgLength(svg, 'height') || 700;
  return { x: 0, y: 0, width, height };
}

function parseSvgLength(svg, attribute) {
  const match = String(svg || '').match(new RegExp(`\\b${attribute}=["']([0-9.]+)`, 'i'));
  return match ? Number(match[1]) : null;
}

function collectShapeMetrics(svg, box) {
  const segments = [];
  const pointsForBounds = [];
  collectNumericAttributes(svg, pointsForBounds);
  collectLineSegments(svg, segments);
  collectPolylineSegments(svg, segments);
  collectPathSegments(svg, segments);

  for (const segment of segments) {
    pointsForBounds.push(segment.x1, segment.y1, segment.x2, segment.y2);
  }

  const bounds = pointBounds(pointsForBounds, box);
  const contentArea = bounds.width * bounds.height;
  const viewArea = Math.max(1, box.width * box.height);
  const contentCoverage = clamp(contentArea / viewArea, 0, 1);
  const spanThreshold = Math.max(box.width, box.height) * 0.42;
  const crossThresholdX = box.width * 0.72;
  const crossThresholdY = box.height * 0.72;
  let longEdgeCount = 0;
  let crossCanvasEdgeCount = 0;

  for (const segment of segments) {
    const dx = Math.abs(segment.x2 - segment.x1);
    const dy = Math.abs(segment.y2 - segment.y1);
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length > spanThreshold) longEdgeCount += 1;
    if (dx > crossThresholdX || dy > crossThresholdY) crossCanvasEdgeCount += 1;
  }

  return {
    edgeCount: segments.length,
    longEdgeCount,
    crossCanvasEdgeCount,
    contentCoverage
  };
}

function collectNumericAttributes(svg, values) {
  const attributeRegex = /\b(?:x|y|x1|x2|y1|y2|cx|cy)=["'](-?\d+(?:\.\d+)?)/gi;
  for (const match of String(svg || '').matchAll(attributeRegex)) {
    values.push(Number(match[1]));
  }
  const sizedTagRegex = /<(?:rect|image|use|foreignObject)\b[^>]*>/gi;
  for (const match of String(svg || '').matchAll(sizedTagRegex)) {
    const tag = match[0];
    const x = attrNumber(tag, 'x');
    const y = attrNumber(tag, 'y');
    const width = attrNumber(tag, 'width');
    const height = attrNumber(tag, 'height');
    if ([x, y, width, height].every(Number.isFinite)) {
      values.push(x, y, x + width, y + height);
    }
  }
  const circleTagRegex = /<(?:circle|ellipse)\b[^>]*>/gi;
  for (const match of String(svg || '').matchAll(circleTagRegex)) {
    const tag = match[0];
    const cx = attrNumber(tag, 'cx');
    const cy = attrNumber(tag, 'cy');
    const radiusX = attrNumber(tag, 'rx');
    const radiusY = attrNumber(tag, 'ry');
    const radius = attrNumber(tag, 'r');
    const rx = Number.isFinite(radiusX) ? radiusX : radius;
    const ry = Number.isFinite(radiusY) ? radiusY : radius;
    if ([cx, cy, rx, ry].every(Number.isFinite)) {
      values.push(cx - rx, cy - ry, cx + rx, cy + ry);
    }
  }
}

function collectLineSegments(svg, segments) {
  const regex = /<line\b[^>]*>/gi;
  for (const tagMatch of String(svg || '').matchAll(regex)) {
    const tag = tagMatch[0];
    const x1 = attrNumber(tag, 'x1');
    const y1 = attrNumber(tag, 'y1');
    const x2 = attrNumber(tag, 'x2');
    const y2 = attrNumber(tag, 'y2');
    if ([x1, y1, x2, y2].every(Number.isFinite)) segments.push({ x1, y1, x2, y2 });
  }
}

function collectPolylineSegments(svg, segments) {
  const regex = /<polyline\b[^>]*\bpoints=["']([^"']+)["'][^>]*>/gi;
  for (const match of String(svg || '').matchAll(regex)) {
    const points = parsePoints(match[1]);
    appendPointSegments(points, segments);
  }
}

function collectPathSegments(svg, segments) {
  const regex = /<path\b[^>]*\bd=["']([^"']+)["'][^>]*>/gi;
  for (const match of String(svg || '').matchAll(regex)) {
    const tag = match[0];
    if (!isEdgeLikePath(tag)) continue;
    const points = parsePathPoints(match[1]);
    appendPointSegments(points, segments);
  }
}

function isEdgeLikePath(tag) {
  const fill = String(tag || '').match(/\bfill=["']([^"']+)["']/i)?.[1]?.toLowerCase();
  return !fill || fill === 'none' || String(tag || '').includes('marker-end') || String(tag || '').includes('marker-start');
}

function parsePoints(value) {
  const numbers = String(value || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const points = [];
  for (let index = 0; index < numbers.length - 1; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

function parsePathPoints(value) {
  const tokens = String(value || '').match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) || [];
  const points = [];
  let command = '';
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      continue;
    }
    const first = Number(token);
    const second = Number(tokens[index++]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;
    if ('MLCQST'.includes(command.toUpperCase()) || command === '') {
      points.push({ x: first, y: second });
    }
  }
  return points;
}

function appendPointSegments(points, segments) {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    segments.push({ x1: previous.x, y1: previous.y, x2: current.x, y2: current.y });
  }
}

function pointBounds(values, box) {
  const numbers = values.filter(Number.isFinite);
  if (numbers.length < 4) {
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  const xs = [];
  const ys = [];
  for (let index = 0; index < numbers.length - 1; index += 2) {
    xs.push(numbers[index]);
    ys.push(numbers[index + 1]);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function attrNumber(tag, attribute) {
  const match = String(tag || '').match(new RegExp(`\\b${attribute}=["'](-?\\d+(?:\\.\\d+)?)`, 'i'));
  return match ? Number(match[1]) : NaN;
}

function aspectPenalty(ratio, diagramKind = 'generic') {
  if (!Number.isFinite(ratio) || ratio <= 0) return 20;
  if (diagramKind === 'state-transition' && ratio > 3.2) {
    return 8 + Math.min(8, (ratio - 3.2) * 0.3);
  }
  if (ratio > 3.2) return 26 + Math.min(16, (ratio - 3.2) * 4);
  if (ratio > 2.4) return 14 + Math.min(12, (ratio - 2.4) * 6);
  if (ratio < 0.5) return 24 + Math.min(16, (0.5 - ratio) * 18);
  if (ratio < 0.7) return 12 + Math.min(10, (0.7 - ratio) * 16);
  return Math.abs(ratio - 1.6) * 4;
}

function failedScore(result) {
  return {
    score: 0,
    severe: true,
    issues: ['render-failed'],
    metrics: {
      aspectRatio: 0,
      aspectRatioPenalty: 100,
      contentCoverage: 0,
      edgeCount: 0,
      textCount: 0,
      longEdgeCount: 0,
      crossCanvasEdgeCount: 0
    },
    error: result.diagnostics?.[0]?.message || 'PlantUML candidate failed.'
  };
}

function visualIntegrityIssueCount(candidate) {
  const overlapCount = Number(candidate.metrics?.textOverlapCount || 0);
  const outOfBoundsCount = Number(candidate.metrics?.textOutOfBoundsCount || 0);
  if (overlapCount > 0 || outOfBoundsCount > 0) return overlapCount + outOfBoundsCount;
  return (candidate.issues || []).filter((issue) => VISUAL_INTEGRITY_ISSUES.has(issue)).length;
}

function optimizedReason(defaultCandidate) {
  if (defaultCandidate.issues?.includes('text-overlap')) return '官方默认 SVG 存在文字重叠，已使用唯一备选布局。';
  if (defaultCandidate.issues?.includes('text-out-of-bounds')) return '官方默认 SVG 存在文字越界，已使用唯一备选布局。';
  return '官方默认 SVG 存在文字完整性异常，已使用唯一备选布局。';
}

function detectDiagramKind(content, viewName = '', renderMode = '') {
  const requestedKind = diagramKindFromResolvedMode(renderMode);
  if (requestedKind) return requestedKind;
  const source = String(content || '');
  const requestedName = String(viewName || '').trim().split('::').pop() || '';
  const requested = escapeRegExp(requestedName);
  if (requested) {
    const requestedView = new RegExp(`view\\s+(?:'${requested}'|${requested})\\s*:\\s*StandardViewDefinitions::StateTransitionView\\b`);
    if (requestedView.test(source)) return 'state-transition';
    const requestedInterconnectionView = new RegExp(`view\\s+(?:'${requested}'|${requested})\\s*:\\s*StandardViewDefinitions::InterconnectionView\\b`);
    if (requestedInterconnectionView.test(source)) return 'interconnection';
    const requestedNonStateView = new RegExp(`view\\s+(?:'${requested}'|${requested})\\s*:\\s*StandardViewDefinitions::(?:SequenceView|ActionFlowView|GeneralView)\\b`);
    if (requestedNonStateView.test(source)) return 'generic';
  }
  return /view\s+(?!def\b)(?:'[^']+'|[A-Za-z_]\w*)\s*:\s*StandardViewDefinitions::StateTransitionView\b/.test(source)
    ? 'state-transition'
    : 'generic';
}

function diagramKindFromResolvedMode(renderMode) {
  const normalized = String(renderMode || '').trim().toUpperCase();
  if (normalized === 'STATE') return 'state-transition';
  if (normalized === 'INTERCONNECTION') return 'interconnection';
  return '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cacheKeyFor({ content, viewName, renderMode, styles }) {
  return crypto
    .createHash('sha256')
    .update(String(content || ''))
    .update('\0')
    .update(String(viewName || ''))
    .update('\0')
    .update(String(renderMode || ''))
    .update('\0')
    .update(styles.join(','))
    .digest('hex');
}

function getCachedCandidate(key) {
  const cached = candidateCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    candidateCache.delete(key);
    return null;
  }
  candidateCache.delete(key);
  candidateCache.set(key, cached);
  return cached.result;
}

function setCachedCandidate(key, result) {
  candidateCache.set(key, { createdAt: Date.now(), result });
  while (candidateCache.size > CACHE_MAX_ENTRIES) {
    const oldest = candidateCache.keys().next().value;
    candidateCache.delete(oldest);
  }
}

function countMatches(text, regex) {
  return Array.from(String(text || '').matchAll(regex)).length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function clearPlantUmlLayoutCache() {
  candidateCache.clear();
}

module.exports = {
  OFFICIAL_DEFAULT_STRATEGY,
  FALLBACK_STRATEGIES,
  optimizePlantUmlLayout,
  scoreSvgLayout,
  detectDiagramKind,
  clearPlantUmlLayoutCache
};
