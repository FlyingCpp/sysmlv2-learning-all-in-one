'use strict';

const PART_GAP = 44;
const ROOT_PADDING_X = 32;
const ROOT_PADDING_BOTTOM = 24;
const PORT_SIZE = 12;
const PORT_LABEL_GAP = 18;
const MIN_PART_HEIGHT = 88;
const MAX_ENDPOINT_DISTANCE = 24;

function improveInterconnectionSvg(svg) {
  const source = String(svg || '');
  if (!source.includes('cluster_') || !source.includes('stroke-width:3.0')) {
    return { svg: source, applied: false, reason: 'No interconnection clusters or connector edges were found.' };
  }

  const clusters = parseClusters(source);
  if (clusters.length < 2) {
    return { svg: source, applied: false, reason: 'No nested interconnection part clusters were found.' };
  }

  buildClusterHierarchy(clusters);
  const compositeContexts = clusters.filter((cluster) => cluster.children.length > 0);
  if (!compositeContexts.length) {
    return { svg: source, applied: false, reason: 'No part clusters were contained by the interconnection root.' };
  }

  const ports = parsePorts(source).map((port, index) => ({ ...port, index }));
  assignPortsToParts(ports, clusters, { allowDistant: compositeContexts.length > 1 });
  setOriginalPortConnectionPoints(ports);

  if (compositeContexts.length > 1) {
    const connectorRewrite = rewriteConnectorEdges(source, ports);
    const output = connectorRewrite.svg;
    return {
      svg: output,
      applied: connectorRewrite.connectorCount > 0,
      reason: 'Preserved the official multi-context hierarchy and applied containment-aware orthogonal connector routing.',
      metrics: layoutMetrics({
        clusters,
        ports,
        connectorRewrite,
        output,
        layoutMode: 'route-only-multi-context',
        movedClusterCount: 0
      })
    };
  }

  const root = compositeContexts[0];
  const parts = root.children;
  sizePartsForPorts(parts);
  layoutPartRows(parts, root.rect);

  const childBounds = boundsOf(parts.map((part) => part.layoutRect));
  const rootLayout = {
    ...root.rect,
    width: Math.max(root.rect.width, childBounds.right - root.rect.x + ROOT_PADDING_X),
    height: Math.max(root.rect.height, childBounds.bottom - root.rect.y + ROOT_PADDING_BOTTOM)
  };
  root.layoutRect = rootLayout;
  const movableClusters = new Set([root, ...parts]);
  layoutPorts(ports.filter((port) => movableClusters.has(port.part)));

  let output = source;
  for (const part of parts) {
    const updated = updateClusterGroup(part.group, part.rect, part.layoutRect);
    output = output.replace(part.group, updated);
  }
  for (const port of ports) {
    if (!port.part || !port.layoutRect) continue;
    const updated = updatePortPair(port, port.layoutRect, port.labelLayout);
    output = output.replace(port.pair, updated);
  }

  const connectorRewrite = rewriteConnectorEdges(output, ports);
  output = connectorRewrite.svg;

  output = output.replace(root.group, updateClusterGroup(root.group, root.rect, rootLayout));
  output = resizeSvgCanvas(output, rootLayout);

  return {
    svg: output,
    applied: true,
    reason: 'Applied deterministic IBD-style part spacing, internal port labels, and orthogonal connector routing.',
    metrics: layoutMetrics({
      clusters,
      ports,
      connectorRewrite,
      output,
      layoutMode: 'ibd-single-context',
      movedClusterCount: parts.length
    })
  };
}

function parseClusters(svg) {
  const clusters = [];
  const regex = /<g\b[^>]*\bid=["']cluster_(E\d+)["'][^>]*>[\s\S]*?<\/g>/gi;
  for (const match of svg.matchAll(regex)) {
    const group = match[0];
    const rectTag = group.match(new RegExp(`<rect\\b[^>]*\\bid=["']${escapeRegExp(match[1])}["'][^>]*>`, 'i'))?.[0];
    const rect = rectTag ? rectFromTag(rectTag) : null;
    if (rect) clusters.push({ id: match[1], group, rect, ports: [], parent: null, children: [] });
  }
  return clusters;
}

function buildClusterHierarchy(clusters) {
  for (const cluster of clusters) {
    cluster.parent = null;
    cluster.children = [];
  }
  for (const cluster of clusters) {
    const parent = clusters
      .filter((candidate) => candidate !== cluster
        && area(candidate.rect) > area(cluster.rect)
        && containsRect(candidate.rect, cluster.rect))
      .sort((left, right) => area(left.rect) - area(right.rect))[0] || null;
    cluster.parent = parent;
    if (parent) parent.children.push(cluster);
  }
}

function parsePorts(svg) {
  const ports = [];
  const rectRegex = /<rect\b[^>]*\bheight=["']12(?:\.0+)?["'][^>]*\bwidth=["']12(?:\.0+)?["'][^>]*\/?>/gi;
  for (const match of svg.matchAll(rectRegex)) {
    const rectTag = match[0];
    const rect = rectFromTag(rectTag);
    if (!rect) continue;
    const before = svg.slice(Math.max(0, match.index - 800), match.index);
    const after = svg.slice(match.index + rectTag.length, match.index + rectTag.length + 800);
    const beforeMatch = before.match(/(<text\b[^>]*>[^<]*<\/text>)(\s*)$/i);
    const afterMatch = after.match(/^(\s*)(<text\b[^>]*>[^<]*<\/text>)/i);
    const textTag = beforeMatch?.[1] || afterMatch?.[2] || '';
    const rectFirst = !beforeMatch && Boolean(afterMatch);
    const gap = beforeMatch?.[2] || afterMatch?.[1] || '';
    const pair = textTag
      ? rectFirst ? `${rectTag}${gap}${textTag}` : `${textTag}${gap}${rectTag}`
      : rectTag;
    ports.push({
      pair,
      textTag,
      rectTag,
      rectFirst,
      rect,
      labelWidth: numberAttr(textTag, 'textLength') || PORT_SIZE,
      fontSize: numberAttr(textTag, 'font-size') || 14,
      center: rectCenter(rect),
      part: null,
      side: null
    });
  }
  return ports;
}

function assignPortsToParts(ports, parts, { allowDistant = false } = {}) {
  for (const port of ports) {
    let best = null;
    for (const part of parts) {
      const candidate = nearestSide(port.center, part.rect);
      if (!best
        || candidate.score < best.score
        || (candidate.score === best.score && area(part.rect) < area(best.part.rect))) {
        best = { ...candidate, part };
      }
    }
    if (!best || (!allowDistant && best.score > 36)) continue;
    port.part = best.part;
    port.side = best.side;
    best.part.ports.push(port);
  }
}

function setOriginalPortConnectionPoints(ports) {
  for (const port of ports) {
    if (!port.part || !port.side) continue;
    const center = rectCenter(port.rect);
    port.connectionPoint = {
      x: port.side === 'left' ? port.rect.x : port.side === 'right' ? port.rect.x + port.rect.width : center.x,
      y: port.side === 'top' ? port.rect.y : port.side === 'bottom' ? port.rect.y + port.rect.height : center.y,
      side: port.side
    };
  }
}

function nearestSide(point, rect) {
  const withinX = point.x >= rect.x - PORT_SIZE && point.x <= rect.x + rect.width + PORT_SIZE;
  const withinY = point.y >= rect.y - PORT_SIZE && point.y <= rect.y + rect.height + PORT_SIZE;
  const candidates = [
    { side: 'top', score: Math.abs(point.y - rect.y) + (withinX ? 0 : 100) },
    { side: 'bottom', score: Math.abs(point.y - (rect.y + rect.height)) + (withinX ? 0 : 100) },
    { side: 'left', score: Math.abs(point.x - rect.x) + (withinY ? 0 : 100) },
    { side: 'right', score: Math.abs(point.x - (rect.x + rect.width)) + (withinY ? 0 : 100) }
  ];
  return candidates.sort((left, right) => left.score - right.score)[0];
}

function sizePartsForPorts(parts) {
  for (const part of parts) {
    const horizontalPorts = part.ports.filter((port) => port.side === 'top' || port.side === 'bottom');
    const groupedWidth = ['top', 'bottom'].reduce((maximum, side) => {
      const sidePorts = horizontalPorts.filter((port) => port.side === side);
      if (!sidePorts.length) return maximum;
      const labels = sidePorts.reduce((total, port) => total + Math.max(PORT_SIZE, port.labelWidth), 0);
      return Math.max(maximum, labels + Math.max(0, sidePorts.length - 1) * PORT_LABEL_GAP + 32);
    }, 0);
    part.layoutRect = {
      ...part.rect,
      width: Math.max(part.rect.width, groupedWidth),
      height: part.ports.length ? Math.max(part.rect.height, MIN_PART_HEIGHT) : part.rect.height
    };
  }
}

function layoutPartRows(parts, rootRect) {
  const rows = [];
  for (const part of [...parts].sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)) {
    const centerY = part.rect.y + part.rect.height / 2;
    let row = rows.find((candidate) => Math.abs(candidate.centerY - centerY) <= Math.max(candidate.height, part.rect.height) * 0.65);
    if (!row) {
      row = { parts: [], centerY, height: part.rect.height };
      rows.push(row);
    }
    row.parts.push(part);
    row.centerY = row.parts.reduce((total, item) => total + item.rect.y + item.rect.height / 2, 0) / row.parts.length;
    row.height = Math.max(row.height, part.rect.height);
  }

  for (const row of rows) {
    row.parts.sort((left, right) => left.rect.x - right.rect.x);
    const rowWidth = row.parts.reduce((total, part) => total + part.layoutRect.width, 0)
      + Math.max(0, row.parts.length - 1) * PART_GAP;
    const availableLeft = rootRect.x + ROOT_PADDING_X;
    const availableWidth = Math.max(rootRect.width - ROOT_PADDING_X * 2, rowWidth);
    let cursor = availableLeft + Math.max(0, (availableWidth - rowWidth) / 2);
    for (const part of row.parts) {
      part.layoutRect.x = cursor;
      part.layoutRect.y = part.rect.y;
      cursor += part.layoutRect.width + PART_GAP;
    }
  }
}

function layoutPorts(ports) {
  const byPartAndSide = new Map();
  for (const port of ports) {
    if (!port.part || !port.side) continue;
    const key = `${port.part.id}:${port.side}`;
    if (!byPartAndSide.has(key)) byPartAndSide.set(key, []);
    byPartAndSide.get(key).push(port);
  }

  for (const sidePorts of byPartAndSide.values()) {
    sidePorts.sort((left, right) => (
      left.side === 'top' || left.side === 'bottom'
        ? left.center.x - right.center.x
        : left.center.y - right.center.y
    ));
    const partRect = sidePorts[0].part.layoutRect;
    if (sidePorts[0].side === 'top' || sidePorts[0].side === 'bottom') {
      layoutHorizontalPorts(sidePorts, partRect);
    } else {
      layoutVerticalPorts(sidePorts, partRect);
    }
  }
}

function layoutHorizontalPorts(ports, partRect) {
  const totalWidth = ports.reduce((total, port) => total + Math.max(PORT_SIZE, port.labelWidth), 0)
    + Math.max(0, ports.length - 1) * PORT_LABEL_GAP;
  let cursor = partRect.x + (partRect.width - totalWidth) / 2;
  for (const port of ports) {
    const slotWidth = Math.max(PORT_SIZE, port.labelWidth);
    const centerX = cursor + slotWidth / 2;
    const isTop = port.side === 'top';
    port.layoutRect = {
      x: centerX - PORT_SIZE / 2,
      y: (isTop ? partRect.y : partRect.y + partRect.height) - PORT_SIZE / 2,
      width: PORT_SIZE,
      height: PORT_SIZE
    };
    port.labelLayout = {
      x: centerX,
      y: isTop ? partRect.y + 48 : partRect.y + partRect.height - 13,
      anchor: 'middle'
    };
    port.connectionPoint = {
      x: centerX,
      y: isTop ? partRect.y - PORT_SIZE / 2 : partRect.y + partRect.height + PORT_SIZE / 2,
      side: port.side
    };
    cursor += slotWidth + PORT_LABEL_GAP;
  }
}

function layoutVerticalPorts(ports, partRect) {
  const usableTop = partRect.y + 38;
  const usableHeight = Math.max(24, partRect.height - 50);
  const step = usableHeight / Math.max(1, ports.length);
  for (let index = 0; index < ports.length; index += 1) {
    const port = ports[index];
    const centerY = usableTop + step * (index + 0.5);
    const isLeft = port.side === 'left';
    port.layoutRect = {
      x: (isLeft ? partRect.x : partRect.x + partRect.width) - PORT_SIZE / 2,
      y: centerY - PORT_SIZE / 2,
      width: PORT_SIZE,
      height: PORT_SIZE
    };
    port.labelLayout = {
      x: isLeft ? partRect.x + 10 : partRect.x + partRect.width - 10,
      y: centerY + port.fontSize * 0.35,
      anchor: isLeft ? 'start' : 'end'
    };
    port.connectionPoint = {
      x: isLeft ? partRect.x - PORT_SIZE / 2 : partRect.x + partRect.width + PORT_SIZE / 2,
      y: centerY,
      side: port.side
    };
  }
}

function updateClusterGroup(group, originalRect, nextRect) {
  const dx = nextRect.x - originalRect.x;
  const dy = nextRect.y - originalRect.y;
  let updated = group.replace(/<(?:rect|text|line|ellipse|polygon)\b[^>]*>/gi, (tag) => translateTag(tag, dx, dy));
  const rectPattern = new RegExp(`<rect\\b[^>]*\\bid=["']${escapeRegExp(originalRect.id)}["'][^>]*>`, 'i');
  updated = updated.replace(rectPattern, (tag) => setAttrs(tag, {
    x: nextRect.x,
    y: nextRect.y,
    width: nextRect.width,
    height: nextRect.height
  }));
  updated = updated.replace(/<line\b[^>]*>/i, (tag) => setAttrs(tag, {
    x1: nextRect.x,
    x2: nextRect.x + nextRect.width
  }));
  updated = updated.replace(/<text\b[^>]*>/gi, (tag) => {
    const length = numberAttr(tag, 'textLength');
    return Number.isFinite(length) ? setAttrs(tag, { x: nextRect.x + (nextRect.width - length) / 2 }) : tag;
  });
  return updated;
}

function updatePortPair(port, nextRect, labelLayout) {
  const rect = setAttrs(port.rectTag, {
    x: nextRect.x,
    y: nextRect.y,
    width: nextRect.width,
    height: nextRect.height
  });
  if (!port.textTag) return rect;
  const text = setAttrs(port.textTag, {
    x: labelLayout.x,
    y: labelLayout.y,
    'text-anchor': labelLayout.anchor
  });
  const gap = port.pair.includes('\n') ? '\n' : '';
  return port.rectFirst ? `${rect}${gap}${text}` : `${text}${gap}${rect}`;
}

function rewriteConnectorEdges(svg, ports) {
  let connectorCount = 0;
  let unresolvedConnectorCount = 0;
  const output = svg.replace(/<path\b[^>]*\bd=["'][^"']+["'][^>]*\bstyle=["'][^"']*stroke-width:3\.0;[^"']*["'][^>]*>/gi, (tag) => {
    const endpoints = pathEndpoints(stringAttr(tag, 'd'));
    if (!endpoints) {
      unresolvedConnectorCount += 1;
      return tag;
    }
    const sourceMatch = nearestPortMatch(endpoints.start, ports);
    const targetMatch = nearestPortMatch(endpoints.end, ports, sourceMatch?.port?.index);
    const sourcePort = sourceMatch?.distance <= MAX_ENDPOINT_DISTANCE ? sourceMatch.port : null;
    const targetPort = targetMatch?.distance <= MAX_ENDPOINT_DISTANCE ? targetMatch.port : null;
    if (!sourcePort?.connectionPoint || !targetPort?.connectionPoint) {
      unresolvedConnectorCount += 1;
      return tag;
    }
    connectorCount += 1;
    return setAttrs(tag, { d: orthogonalPath(sourcePort.connectionPoint, targetPort.connectionPoint) });
  });
  return { svg: output, connectorCount, unresolvedConnectorCount };
}

function orthogonalPath(start, end) {
  const points = [{ x: start.x, y: start.y }];
  const startHorizontal = start.side === 'left' || start.side === 'right';
  const endHorizontal = end.side === 'left' || end.side === 'right';
  if (startHorizontal && endHorizontal) {
    const middleX = (start.x + end.x) / 2;
    points.push({ x: middleX, y: start.y }, { x: middleX, y: end.y });
  } else if (!startHorizontal && !endHorizontal) {
    const middleY = (start.y + end.y) / 2;
    points.push({ x: start.x, y: middleY }, { x: end.x, y: middleY });
  } else if (startHorizontal) {
    points.push({ x: end.x, y: start.y });
  } else {
    points.push({ x: start.x, y: end.y });
  }
  points.push({ x: end.x, y: end.y });
  return points
    .filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)},${round(point.y)}`)
    .join(' ');
}

function nearestPort(point, ports, excludedIndex = null) {
  const nearest = nearestPortMatch(point, ports, excludedIndex);
  return nearest && nearest.distance <= MAX_ENDPOINT_DISTANCE ? nearest.port : null;
}

function nearestPortMatch(point, ports, excludedIndex = null) {
  return ports
    .filter((port) => port.part && port.index !== excludedIndex)
    .map((port) => ({ port, distance: distance(point, port.center) }))
    .sort((left, right) => left.distance - right.distance)[0];
}

function resizeSvgCanvas(svg, rootRect) {
  const current = svg.match(/\bviewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const width = Math.max(current?.[2] || 0, Math.ceil(rootRect.x + rootRect.width + 7));
  const height = Math.max(current?.[3] || 0, Math.ceil(rootRect.y + rootRect.height + 7));
  return svg.replace(/<svg\b[^>]*>/i, (tag) => {
    const currentStyle = stringAttr(tag, 'style');
    const style = currentStyle
      .replace(/\bwidth\s*:\s*[^;]+;?/i, '')
      .replace(/\bheight\s*:\s*[^;]+;?/i, '')
      .trim();
    return setAttrs(tag, {
      width: `${width}px`,
      height: `${height}px`,
      viewBox: `0 0 ${width} ${height}`,
      style: `width:${width}px;height:${height}px;${style}`
    });
  });
}

function countNonOrthogonalConnectors(svg) {
  let count = 0;
  const regex = /<path\b[^>]*\bd=["']([^"']+)["'][^>]*\bstyle=["'][^"']*stroke-width:3\.0;[^"']*["'][^>]*>/gi;
  for (const match of svg.matchAll(regex)) {
    if (/[CQSAcqsa]/.test(match[1])) {
      count += 1;
      continue;
    }
    const points = [...match[1].matchAll(/[ML]\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/gi)]
      .map((point) => ({ x: Number(point[1]), y: Number(point[2]) }));
    if (points.some((point, index) => index > 0 && point.x !== points[index - 1].x && point.y !== points[index - 1].y)) count += 1;
  }
  return count;
}

function countRectOverlaps(rects) {
  let count = 0;
  for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
      const left = rects[leftIndex];
      const right = rects[rightIndex];
      if (Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x) > 0
        && Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y) > 0) count += 1;
    }
  }
  return count;
}

function layoutMetrics({ clusters, ports, connectorRewrite, output, layoutMode, movedClusterCount }) {
  return {
    layoutMode,
    rootCount: clusters.filter((cluster) => !cluster.parent).length,
    compositeContextCount: clusters.filter((cluster) => cluster.children.length > 0).length,
    movedClusterCount,
    partCount: clusters.filter((cluster) => cluster.parent).length,
    portCount: ports.filter((port) => port.part).length,
    connectorCount: connectorRewrite.connectorCount,
    unresolvedConnectorCount: connectorRewrite.unresolvedConnectorCount,
    partOverlapCount: countUnexpectedClusterOverlaps(clusters),
    nonOrthogonalConnectorCount: countNonOrthogonalConnectors(output)
  };
}

function countUnexpectedClusterOverlaps(clusters) {
  let count = 0;
  for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
      const left = clusters[leftIndex];
      const right = clusters[rightIndex];
      if (isAncestor(left, right) || isAncestor(right, left)) continue;
      const leftRect = left.layoutRect || left.rect;
      const rightRect = right.layoutRect || right.rect;
      if (Math.min(leftRect.x + leftRect.width, rightRect.x + rightRect.width) - Math.max(leftRect.x, rightRect.x) > 0
        && Math.min(leftRect.y + leftRect.height, rightRect.y + rightRect.height) - Math.max(leftRect.y, rightRect.y) > 0) count += 1;
    }
  }
  return count;
}

function isAncestor(candidate, cluster) {
  for (let current = cluster.parent; current; current = current.parent) {
    if (current === candidate) return true;
  }
  return false;
}

function pathEndpoints(path) {
  const numbers = [...String(path || '').matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numbers.length < 4) return null;
  return {
    start: { x: numbers[0], y: numbers[1] },
    end: { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] }
  };
}

function rectFromTag(tag) {
  const x = numberAttr(tag, 'x');
  const y = numberAttr(tag, 'y');
  const width = numberAttr(tag, 'width');
  const height = numberAttr(tag, 'height');
  const id = stringAttr(tag, 'id');
  return [x, y, width, height].every(Number.isFinite) ? { id, x, y, width, height } : null;
}

function translateTag(tag, dx, dy) {
  let updated = tag;
  for (const name of ['x', 'x1', 'x2', 'cx']) {
    const value = numberAttr(updated, name);
    if (Number.isFinite(value)) updated = setAttrs(updated, { [name]: value + dx });
  }
  for (const name of ['y', 'y1', 'y2', 'cy']) {
    const value = numberAttr(updated, name);
    if (Number.isFinite(value)) updated = setAttrs(updated, { [name]: value + dy });
  }
  return updated;
}

function setAttrs(tag, attributes) {
  let updated = tag;
  for (const [name, rawValue] of Object.entries(attributes)) {
    const value = typeof rawValue === 'number' ? round(rawValue) : String(rawValue);
    const regex = new RegExp(`\\b${escapeRegExp(name)}=["'][^"']*["']`, 'i');
    if (regex.test(updated)) {
      updated = updated.replace(regex, `${name}="${value}"`);
    } else {
      updated = updated.replace(/\s*\/?>(?=$)/, (ending) => ` ${name}="${value}"${ending}`);
    }
  }
  return updated;
}

function numberAttr(tag, name) {
  const value = stringAttr(tag, name);
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function stringAttr(tag, name) {
  return String(tag || '').match(new RegExp(`\\b${escapeRegExp(name)}=["']([^"']*)["']`, 'i'))?.[1] || '';
}

function rectCenter(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function containsRect(outer, inner) {
  return inner.x >= outer.x - 1
    && inner.y >= outer.y - 1
    && inner.x + inner.width <= outer.x + outer.width + 1
    && inner.y + inner.height <= outer.y + outer.height + 1;
}

function boundsOf(rects) {
  return {
    left: Math.min(...rects.map((rect) => rect.x)),
    top: Math.min(...rects.map((rect) => rect.y)),
    right: Math.max(...rects.map((rect) => rect.x + rect.width)),
    bottom: Math.max(...rects.map((rect) => rect.y + rect.height))
  };
}

function area(rect) {
  return rect.width * rect.height;
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function round(value) {
  return Number(Number(value).toFixed(2));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  improveInterconnectionSvg,
  countNonOrthogonalConnectors,
  countRectOverlaps,
  orthogonalPath
};
