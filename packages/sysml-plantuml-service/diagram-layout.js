'use strict';

const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { routeBetween } = require('./orthogonal-router');
const general = require('./general-layout');

const VERSION = 'local-layout-6';
const EPSILON = 0.05;
let activeWorkers = 0;

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateDocument(document) {
  if (!document || !['port-network', 'action-flow', ...general.PROFILES].includes(document.profile)) {
    throw problem('INVALID_DOCUMENT', '不支持的图形投影类型。');
  }
  const { nodes, ports, edges } = document;
  if (!Array.isArray(nodes) || !Array.isArray(ports) || !Array.isArray(edges)
      || nodes.length > 200 || ports.length > 1200 || edges.length > 800) {
    throw problem('INVALID_DOCUMENT', '图形数量超过当前布局能力范围。');
  }
  const ids = new Set();
  for (const item of [...nodes, ...ports, ...edges]) {
    if (!item.id || ids.has(item.id)) throw problem('INVALID_DOCUMENT', '图形身份缺失或重复。');
    ids.add(item.id);
    for (const line of [...(item.labelLines || []), ...(item.documentationLines || []), ...(item.cardRows || [])]) {
      if (typeof line.text !== 'string' || line.text.length > 2000 || !Number.isFinite(line.width)
          || line.width < 0 || line.width > 10000) throw problem('INVALID_DOCUMENT', '文字测量无效。');
    }
  }
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (seen.has(parentId) || !nodeMap.has(parentId)) throw problem('INVALID_DOCUMENT', '图形归属无效。');
      seen.add(parentId);
      parentId = nodeMap.get(parentId).parentId;
    }
  }
  for (const port of ports) {
    if (!nodeMap.has(port.ownerId)) throw problem('INVALID_DOCUMENT', '端口没有所属部件。');
  }
  const endpoints = new Set((document.profile === 'port-network' ? ports : nodes).map(n => n.id));
  for (const edge of edges) {
    if (!endpoints.has(edge.source) || !endpoints.has(edge.target)) throw problem('UNRESOLVED_ENDPOINT', '连接端点未解析。');
  }
}

function createGraph(document) {
  validateDocument(document);
  if (general.PROFILES.has(document.profile)) return general.createGeneralGraph(document);
  const action = document.profile === 'action-flow';
  const nodeMap = new Map();
  const portMap = new Map();
  const labelWidth = item => Math.max(0, ...(item.labelLines || []).map(l => l.width));
  const actionWidth = Math.max(200, ...document.nodes.map(n => labelWidth(n) + 48));
  for (const node of document.nodes) {
    const compound = document.nodes.some(n => n.parentId === node.id);
    const ports = document.ports.filter(p => p.ownerId === node.id);
    const sides = { WEST: [], EAST: [] };
    for (const port of ports) {
      // 此方向仅是图形布局偏好，不代表普通 connection 的物理流向。
      const outgoing = document.edges.filter(e => (e.source === port.id && e.contextId !== node.id)
        || (e.target === port.id && e.contextId === node.id)).length;
      const incoming = document.edges.filter(e => (e.target === port.id && e.contextId !== node.id)
        || (e.source === port.id && e.contextId === node.id)).length;
      sides[outgoing > incoming ? 'EAST' : 'WEST'].push(port);
    }
    const width = action ? actionWidth : Math.max(220, labelWidth(node) + 48,
      Math.max(0, ...sides.WEST.map(labelWidth)) + Math.max(0, ...sides.EAST.map(labelWidth)) + 64);
    const header = Math.max(60, (node.labelLines?.length || 1) * 20 + 26);
    const rowHeight = Math.max(58, ...ports.map(p => (p.labelLines?.length || 1) * 20 + 18));
    const height = header + Math.max(sides.WEST.length, sides.EAST.length) * rowHeight + 22;
    const graphNode = {
      id: node.id, width, height: action ? Math.max(72, header) : height,
      children: [], ports: [],
      layoutOptions: {
        'elk.portConstraints': compound ? 'FIXED_SIDE' : 'FIXED_POS',
        // 容器端口由 ELK 排位，也必须预留完整多行标签的高度。
        'elk.spacing.portPort': String(rowHeight),
        'elk.padding': `[top=${header + 22},left=${Math.max(38, ...sides.WEST.map(p => labelWidth(p) + 56))},bottom=38,right=${Math.max(38, ...sides.EAST.map(p => labelWidth(p) + 56))}]`
      }
    };
    for (const [side, list] of Object.entries(sides)) list.forEach((port, index) => {
      const geometry = {
        id: port.id, x: side === 'WEST' ? -10 : width, y: header + index * rowHeight + rowHeight / 2 - 5,
        width: 10, height: 10, layoutOptions: { 'elk.port.side': side }
      };
      graphNode.ports.push(geometry);
      portMap.set(port.id, { ...port, side });
    });
    if (action) {
      // 仅供布局使用的中心锚点，不作为 SysML port 输出。
      for (const [suffix, side, y] of [['in', 'NORTH', 0], ['out', 'SOUTH', graphNode.height]]) {
        if (document.edges.some(e => (suffix === 'in' ? e.target : e.source) === node.id)) {
          graphNode.ports.push({ id: `${node.id}:action-${suffix}`, x: width / 2, y, width: 0, height: 0,
            layoutOptions: { 'elk.port.side': side } });
        }
      }
    }
    nodeMap.set(node.id, graphNode);
  }
  const graph = {
    id: 'canvas', children: [],
    edges: document.edges.map(e => ({ id: e.id,
      sources: [action ? `${e.source}:action-out` : e.source],
      targets: [action ? `${e.target}:action-in` : e.target] })),
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': action ? 'DOWN' : 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '60', 'elk.spacing.edgeNode': '24',
      'elk.layered.spacing.nodeNodeBetweenLayers': '88',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24', 'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.layered.mergeEdges': 'false', 'elk.layered.mergeHierarchyEdges': 'false',
      'elk.randomSeed': '1', 'elk.padding': '[top=24,left=24,bottom=24,right=24]'
    }
  };
  for (const node of document.nodes) {
    (node.parentId ? nodeMap.get(node.parentId) : graph).children.push(nodeMap.get(node.id));
  }
  return { graph, portMap };
}

async function runElk(graph, { timeoutMs = 10000, signal, document, portMap } = {}) {
  if (signal?.aborted) throw problem('LAYOUT_CANCELLED', '布局已取消。');
  if (timeoutMs <= 0) throw problem('LAYOUT_BUDGET_EXCEEDED', '本次渲染预算已用尽。');
  if (activeWorkers >= 2) throw problem('LAYOUT_BUSY', '布局正在处理其他请求，请稍后重试。');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'diagram-layout-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    activeWorkers++;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      activeWorkers--;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => finish(problem('LAYOUT_CANCELLED', '布局已取消。'));
    const timer = setTimeout(() => finish(problem('LAYOUT_BUDGET_EXCEEDED', '布局计算超过预算。')), Math.min(10000, Math.max(1, timeoutMs)));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', m => finish(m.error ? problem(m.code || 'LAYOUT_ENGINE_ERROR', m.error) : null, m.result));
    worker.once('error', error => finish(problem('LAYOUT_ENGINE_ERROR', error.message)));
    worker.once('exit', code => { if (!settled) finish(problem('LAYOUT_ENGINE_ERROR', `布局 Worker 提前退出 (${code})。`)); });
    worker.postMessage({ graph, document, portMap, deadline: Date.now() + Math.min(10000, timeoutMs) });
  });
}

function sceneFromGraph(document, graph, portMap) {
  const nodes = [], ports = [], edges = [];
  const nodeMap = new Map(document.nodes.map(n => [n.id, n]));
  const offsets = new Map([['canvas', { x: 0, y: 0 }]]);
  const edgeGraphs = [];
  function visit(parent, offset) {
    for (const node of parent.children || []) {
      const absolute = { x: offset.x + node.x, y: offset.y + node.y };
      offsets.set(node.id, absolute);
      nodes.push({ ...nodeMap.get(node.id), ...absolute, width: node.width, height: node.height });
      for (const port of (node.ports || []).filter(p => portMap.has(p.id))) ports.push({
        ...portMap.get(port.id), x: absolute.x + port.x, y: absolute.y + port.y,
        width: port.width, height: port.height,
        anchor: { x: absolute.x + port.x + (portMap.get(port.id).side === 'EAST' ? port.width : 0), y: absolute.y + port.y + port.height / 2 }
      });
      visit(node, absolute);
    }
    for (const edge of parent.edges || []) edgeGraphs.push({ edge, parentId: parent.id });
  }
  visit(graph, { x: 0, y: 0 });
  for (const { edge, parentId } of edgeGraphs) {
    const origin = offsets.get(edge.container || parentId);
    const source = document.edges.find(e => e.id === edge.id);
    if (!origin || !source || edge.sections?.length !== 1) throw problem('GEOMETRY_INVALID', '连接缺少唯一连续路径。');
    const section = edge.sections[0];
    const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint]
      .map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
    // 边界端口内外各有一个引出面：容器内部连接从内侧引出，外部连接从外侧引出。
    for (const [id, index] of [[source.source, 0], [source.target, points.length - 1]]) {
      const port = ports.find(p => p.id === id);
      if (port && source.contextId === port.ownerId) {
        points[index].x = port.anchor.x + (port.side === 'WEST' ? port.width : -port.width);
      }
    }
    edges.push({ ...source, points });
  }
  return { version: VERSION, profile: document.profile, fontFamily: document.fontFamily,
    width: graph.width, height: graph.height, nodes, ports, edges };
}

function segmentHitsBox(a, b, box) {
  const left = box.x + EPSILON, right = box.x + box.width - EPSILON;
  const top = box.y + EPSILON, bottom = box.y + box.height - EPSILON;
  if (Math.abs(a.y - b.y) < EPSILON) return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  if (Math.abs(a.x - b.x) < EPSILON) return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  return false;
}

function inspectScene(document, scene) {
  if (general.PROFILES.has(document.profile)) return general.inspectGeneral(document, scene);
  const issues = [];
  const nodeMap = new Map(scene.nodes.map(n => [n.id, n]));
  const portMap = new Map(scene.ports.map(p => [p.id, p]));
  const labels = labelBoxes(scene);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const owner = nodeMap.get(label.ownerId);
    if (!owner || label.x < owner.x || label.y < owner.y || label.x + label.width > owner.x + owner.width + EPSILON
        || label.y + label.height > owner.y + owner.height + EPSILON) issues.push(`${label.id}:label-outside`);
    for (const other of labels.slice(i + 1)) {
      if (Math.min(label.x + label.width, other.x + other.width) > Math.max(label.x, other.x) + EPSILON
          && Math.min(label.y + label.height, other.y + other.height) > Math.max(label.y, other.y) + EPSILON) issues.push(`${label.id}:${other.id}:label-overlap`);
    }
  }
  const ancestors = id => {
    const result = new Set();
    let node = nodeMap.get(id);
    while (node?.parentId) { result.add(node.parentId); node = nodeMap.get(node.parentId); }
    return result;
  };
  for (const key of ['nodes', 'ports', 'edges']) {
    const expected = new Set(document[key].map(n => n.id));
    if (scene[key].length !== expected.size || new Set(scene[key].map(n => n.id)).size !== expected.size
        || scene[key].some(n => !expected.has(n.id))) issues.push(`${key}:identity-count`);
  }
  for (const port of scene.ports) {
    const owner = nodeMap.get(port.ownerId);
    const expected = document.ports.find(p => p.id === port.id);
    if (!owner || expected?.ownerId !== port.ownerId || !['WEST', 'EAST'].includes(port.side)
        || Math.abs((port.side === 'WEST' ? port.x + port.width : port.x) - (owner.x + (port.side === 'EAST' ? owner.width : 0))) > EPSILON
        || port.y < owner.y || port.y + port.height > owner.y + owner.height + EPSILON) issues.push(`${port.id}:wrong-boundary`);
  }
  for (const node of scene.nodes) {
    if (![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0) issues.push(`${node.id}:invalid-box`);
    const parent = nodeMap.get(node.parentId);
    if (parent && (node.x < parent.x || node.y < parent.y || node.x + node.width > parent.x + parent.width + EPSILON || node.y + node.height > parent.y + parent.height + EPSILON)) issues.push(`${node.id}:outside-parent`);
    for (const other of scene.nodes) {
      if (node.id >= other.id || ancestors(node.id).has(other.id) || ancestors(other.id).has(node.id)) continue;
      if (Math.min(node.x + node.width, other.x + other.width) > Math.max(node.x, other.x) + EPSILON
          && Math.min(node.y + node.height, other.y + other.height) > Math.max(node.y, other.y) + EPSILON) issues.push(`${node.id}:${other.id}:overlap`);
    }
  }
  for (const edge of scene.edges) {
    const expected = document.edges.find(e => e.id === edge.id);
    if (!expected || edge.source !== expected.source || edge.target !== expected.target) issues.push(`${edge.id}:wrong-endpoint`);
    const source = portMap.get(edge.source), target = portMap.get(edge.target);
    const exempt = new Set([...ancestors(source?.ownerId || edge.source), ...ancestors(target?.ownerId || edge.target)]);
    if (edge.points.length < 2) issues.push(`${edge.id}:missing-route`);
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) issues.push(`${edge.id}:non-finite`);
      if (Math.abs(a.x - b.x) > EPSILON && Math.abs(a.y - b.y) > EPSILON) issues.push(`${edge.id}:diagonal`);
      for (const node of scene.nodes) if (!exempt.has(node.id) && segmentHitsBox(a, b, node)) issues.push(`${edge.id}:${node.id}:crosses-block`);
      for (const label of labels) if (segmentHitsBox(a, b, label)) issues.push(`${edge.id}:${label.id}:crosses-label`);
    }
    for (const [port, end, next] of [[source, edge.points[0], edge.points[1]], [target, edge.points.at(-1), edge.points.at(-2)]]) {
      if (!port) continue;
      const inside = edge.contextId === port.ownerId;
      const anchorX = port.anchor.x + (inside ? (port.side === 'WEST' ? port.width : -port.width) : 0);
      if (Math.hypot(end.x - anchorX, end.y - port.anchor.y) > EPSILON) issues.push(`${edge.id}:${port.id}:detached`);
      if (Math.abs(next.y - end.y) > EPSILON || (next.x - end.x) * (port.side === 'EAST' ? 1 : -1) * (inside ? -1 : 1) <= EPSILON) issues.push(`${edge.id}:${port.id}:wrong-exit`);
    }
    if (document.profile === 'action-flow' && edge.points.length >= 2) {
      for (const [id, end, next, outgoing] of [[edge.source, edge.points[0], edge.points[1], true],
        [edge.target, edge.points.at(-1), edge.points.at(-2), false]]) {
        const node = nodeMap.get(id);
        if (!node || Math.abs(end.x - node.x - node.width / 2) > EPSILON
            || Math.abs(end.y - node.y - (outgoing ? node.height : 0)) > EPSILON) issues.push(`${edge.id}:${id}:detached-action`);
        if (Math.abs(next.x - end.x) > EPSILON || (next.y - end.y) * (outgoing ? 1 : -1) <= EPSILON) issues.push(`${edge.id}:${id}:wrong-action-exit`);
      }
    }
  }
  return { status: issues.length ? 'failed' : 'ready', issues, nodeCount: scene.nodes.length, portCount: scene.ports.length, edgeCount: scene.edges.length };
}

function labelBoxes(scene) {
  const labels = [];
  for (const node of scene.nodes) (node.labelLines || []).forEach((line, index) => labels.push({
    id: `${node.id}:label:${index}`, ownerId: node.id, text: line.text,
    x: node.x + (node.width - line.width) / 2, y: node.y + 8 + index * 20, width: line.width, height: 18
  }));
  for (const port of scene.ports) (port.labelLines || []).forEach((line, index) => labels.push({
    id: `${port.id}:label:${index}`, ownerId: port.ownerId, text: line.text,
    x: port.side === 'WEST' ? port.x + 24 : port.x - 14 - line.width,
    y: port.y - 5 - (port.labelLines.length - 1) * 10 + index * 20, width: line.width, height: 18
  }));
  return labels;
}

async function layoutDiagram(document, options = {}) {
  const { graph, portMap } = createGraph(document);
  return runElk(graph, { ...options, document, portMap });
}

// ELK、避障和检查共用一个可取消 Worker，总预算不增加。
function finishLayout(document, laidOut, portMap, deadline) {
  const scene = general.PROFILES.has(document.profile) ? general.generalScene(document, laidOut, VERSION)
    : sceneFromGraph(document, laidOut, portMap);
  if (general.PROFILES.has(document.profile)) {
    try { general.repairGeneral(scene, deadline); }
    catch (error) { throw problem('GEOMETRY_INVALID', `需求/结构关系无法在预算内完成避障：${error.message}`); }
  }
  // 只有障碍冲突边参与修正；端口引出段保持水平且不改变内外侧。
  if (document.profile === 'port-network') {
    const initial = inspectScene(document, scene);
    const labels = labelBoxes(scene);
    for (const edge of scene.edges) {
      if (!initial.issues.some(i => i.startsWith(`${edge.id}:`) && /crosses-(label|block)/.test(i))) continue;
      const ends = [edge.source, edge.target].map(id => scene.ports.find(p => p.id === id));
      const exempt = new Set();
      const chains = [];
      for (const port of ends) {
        let node = scene.nodes.find(n => n.id === port.ownerId);
        const chain = [node.id];
        while (node?.parentId) { exempt.add(node.parentId); chain.push(node.parentId); node = scene.nodes.find(n => n.id === node.parentId); }
        chains.push(chain);
      }
      const container = scene.nodes.find(n => n.id === chains[0].find(id => chains[1].includes(id)));
      const region = container || { x: 0, y: 0, width: scene.width, height: scene.height };
      const obstacles = [...scene.nodes.filter(n => !exempt.has(n.id)), ...labels].filter(b =>
        b.x < region.x + region.width && b.x + b.width > region.x && b.y < region.y + region.height && b.y + b.height > region.y);
      // 根内路径不得绕到另一个根或越过容器边界；边界条只属于布局障碍。
      obstacles.push({ x: region.x - 16, y: region.y - 16, width: region.width + 32, height: 16 },
        { x: region.x - 16, y: region.y + region.height, width: region.width + 32, height: 16 },
        { x: region.x - 16, y: region.y, width: 16, height: region.height },
        { x: region.x + region.width, y: region.y, width: 16, height: region.height });
      const anchors = [edge.points[0], edge.points.at(-1)];
      const stubs = ends.map((p, i) => ({ x: anchors[i].x + 12 * (p.side === 'EAST' ? 1 : -1)
        * (edge.contextId === p.ownerId ? -1 : 1), y: anchors[i].y }));
      try {
        edge.points = [anchors[0], ...routeBetween(stubs[0], stubs[1],
          obstacles, deadline), anchors[1]];
      } catch (error) {
        throw problem('GEOMETRY_INVALID', `端口连接无法在预算内完成避障：${error.message}`);
      }
    }
  }
  const quality = inspectScene(document, scene);
  if (quality.status !== 'ready') throw problem('GEOMETRY_INVALID', `布局几何检查失败：${quality.issues.join(', ')}`);
  const geometryHash = crypto.createHash('sha256').update(JSON.stringify({
    nodes: scene.nodes.map(n => [n.id, n.x, n.y, n.width, n.height]), ports: scene.ports.map(p => [p.id, p.x, p.y, p.side]),
    edges: scene.edges.map(e => [e.id, e.source, e.target, e.points])
  })).digest('hex');
  return { scene, quality, geometryHash, version: VERSION };
}

module.exports = { layoutDiagram, finishLayout, createGraph, sceneFromGraph, inspectScene, segmentHitsBox, VERSION };
