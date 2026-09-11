'use strict';

const { routeBetween } = require('./orthogonal-router');

const PROFILES = new Set(['part-hierarchy', 'requirement-hierarchy']);
const KINDS = new Set(['part-membership', 'reference-part', 'required-requirement',
  'feature-typing', 'subclassification', 'required-reference', 'assumed-reference']);
const hierarchy = kind => ['part-membership', 'reference-part', 'required-requirement'].includes(kind);
const dashed = kind => ['feature-typing', 'required-reference', 'assumed-reference'].includes(kind);
const markerFor = kind => kind === 'subclassification' ? 'triangle' : dashed(kind) ? 'open-arrow' : 'none';
const textIdentity = rows => rows.map(({ text, width, separator, sourceElementId }) => ({ text, width, separator, sourceElementId }));
const widthOf = rows => Math.max(0, ...rows.map(row => row.width));

function createGeneralGraph(document) {
  const children = document.nodes.map(node => {
    if (!Array.isArray(node.cardRows)) throw new Error('GENERAL_CARD_MEASUREMENT_MISSING');
    const anchors = document.edges.flatMap(edge => [[edge.source, 's'], [edge.target, 't']]
      .filter(([id]) => id === node.id).map(([, end]) => ({ id: `${edge.id}:${end}`, width: 0, height: 0,
        layoutOptions: { 'elk.port.side': hierarchy(edge.kind) ? (end === 's' ? 'SOUTH' : 'NORTH') : (end === 's' ? 'WEST' : 'EAST') } })));
    return { id: node.id, width: Math.max(220, widthOf(node.cardRows) + 40, anchors.length * 18),
      height: Math.max(72, node.cardRows.reduce((sum, r) => sum + (r.separator ? 28 : 20), 28)), ports: anchors,
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE', 'elk.spacing.portPort': '18' } };
  });
  const edges = document.edges.map(edge => {
    if (!KINDS.has(edge.kind)) throw new Error(`GENERAL_UNSUPPORTED_RELATION:${edge.kind}`);
    return { id: edge.id, sources: [`${edge.id}:s`], targets: [`${edge.id}:t`],
      labels: edge.labelLines.length ? [{ id: `${edge.id}:label`, text: edge.labelLines.map(l => l.text).join('\n'),
        width: widthOf(edge.labelLines), height: edge.labelLines.length * 20 }] : [],
      layoutOptions: { 'elk.layered.priority.direction': hierarchy(edge.kind) ? '100' : '1' } };
  });
  return { graph: { id: 'canvas', children, edges, layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': '60', 'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    'elk.spacing.edgeNode': '24', 'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.spacing.edgeEdge': '18', 'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
    'elk.spacing.labelNode': '16', 'elk.spacing.edgeLabel': '12',
    'elk.layered.mergeEdges': 'false', 'elk.layered.mergeHierarchyEdges': 'false',
    'elk.randomSeed': '1', 'elk.padding': '[top=32,left=32,bottom=32,right=32]'
  } }, portMap: new Map() };
}

function generalScene(document, graph, version) {
  const anchors = new Map();
  const nodes = graph.children.map(box => {
    const node = document.nodes.find(n => n.id === box.id);
    for (const anchor of box.ports) anchors.set(anchor.id, { x: box.x + anchor.x, y: box.y + anchor.y,
      side: anchor.layoutOptions['elk.port.side'], ownerId: node.id });
    let y = box.y + 12;
    const cardRows = node.cardRows.map((line, index) => {
      if (line.separator) y += 8;
      const row = { ...line, id: `${node.id}:row:${index}`, ownerId: node.id, x: box.x + 20, y, height: 18 };
      y += 20;
      return row;
    });
    return { ...node, x: box.x, y: box.y, width: box.width, height: box.height, layoutParentId: '', cardRows };
  });
  const edges = graph.edges.map(route => {
    const edge = document.edges.find(e => e.id === route.id);
    if (route.sections?.length !== 1) throw new Error('GENERAL_MISSING_CONTINUOUS_ROUTE');
    const section = route.sections[0];
    const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
    const labels = (route.labels || []).flatMap(label => edge.labelLines.map((line, i) => ({ ...line,
      id: `${edge.id}:label:${i}`, x: label.x, y: label.y + i * 20, height: 18 })));
    return { ...edge, points, labels, sourceAnchor: anchors.get(`${edge.id}:s`), targetAnchor: anchors.get(`${edge.id}:t`),
      dashed: dashed(edge.kind), marker: markerFor(edge.kind) };
  });
  return { version, profile: document.profile, fontFamily: document.fontFamily, width: graph.width,
    height: graph.height, nodes, ports: document.ports.map(p => ({ ...p, presentation: 'compartment-row' })), edges };
}

const overlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.05
  && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.05;
function hits(a, b, box) {
  return Math.abs(a.y - b.y) < 0.05
    ? a.y > box.y + 0.05 && a.y < box.y + box.height - 0.05 && Math.max(a.x, b.x) > box.x + 0.05 && Math.min(a.x, b.x) < box.x + box.width - 0.05
    : Math.abs(a.x - b.x) < 0.05 && a.x > box.x + 0.05 && a.x < box.x + box.width - 0.05
      && Math.max(a.y, b.y) > box.y + 0.05 && Math.min(a.y, b.y) < box.y + box.height - 0.05;
}

// 只修复 ELK 路径中穿过障碍的线段，保留其他线段、标签和端点；每段最多处理一次。
function repairGeneral(scene, deadline) {
  const boxes = [...scene.nodes, ...scene.edges.flatMap(e => e.labels)];
  const repaired = new Set();
  for (const edge of scene.edges) {
    const points = [edge.points[0]];
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      if (!boxes.some(box => hits(a, b, box))) { points.push(b); continue; }
      const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      const start = i === 1 ? { x: a.x + dx * 12, y: a.y + dy * 12 } : a;
      const finish = i === edge.points.length - 1 ? { x: b.x - dx * 12, y: b.y - dy * 12 } : b;
      const left = Math.max(0, Math.min(a.x, b.x) - 32), top = Math.max(0, Math.min(a.y, b.y) - 32);
      const right = Math.min(scene.width, Math.max(a.x, b.x) + 32), bottom = Math.min(scene.height, Math.max(a.y, b.y) + 32);
      const obstacles = boxes.filter(box => box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top);
      obstacles.push({ x: left - 8, y: top - 8, width: right - left + 16, height: 8 },
        { x: left - 8, y: bottom, width: right - left + 16, height: 8 },
        { x: left - 8, y: top, width: 8, height: bottom - top },
        { x: right, y: top, width: 8, height: bottom - top });
      const detour = routeBetween(start, finish, obstacles, deadline);
      points.push(...detour.filter(p => Math.hypot(p.x - points.at(-1).x, p.y - points.at(-1).y) > 0.05));
      if (Math.hypot(points.at(-1).x - b.x, points.at(-1).y - b.y) > 0.05) points.push(b);
      repaired.add(edge.id);
    }
    edge.points = points;
  }
  scene.repairedEdges = [...repaired];
}

function inspectGeneral(document, scene) {
  const issues = [];
  for (const key of ['nodes', 'ports', 'edges']) {
    const ids = new Set(document[key].map(n => n.id));
    if (scene[key].length !== ids.size || new Set(scene[key].map(n => n.id)).size !== ids.size
      || scene[key].some(n => !ids.has(n.id))) issues.push(`${key}:identity-count`);
  }
  const labels = [...scene.nodes.flatMap(n => n.cardRows), ...scene.edges.flatMap(e => e.labels)];
  for (const node of scene.nodes) {
    const expected = document.nodes.find(n => n.id === node.id);
    if (!expected || node.parentId !== expected.parentId || node.layoutParentId !== ''
      || JSON.stringify(textIdentity(node.cardRows)) !== JSON.stringify(textIdentity(expected.cardRows))) issues.push(`${node.id}:card-content`);
    if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) issues.push(`${node.id}:invalid-box`);
    for (const row of node.cardRows) if (row.x < node.x || row.y < node.y
      || row.x + row.width > node.x + node.width + 0.05 || row.y + row.height > node.y + node.height + 0.05) issues.push(`${row.id}:outside-card`);
    for (const other of scene.nodes) if (node.id < other.id && overlap(node, other)) issues.push(`${node.id}:${other.id}:overlap`);
    for (const label of labels) if (label.ownerId !== node.id && overlap(label, node)) issues.push(`${node.id}:${label.id}:label-overlap`);
  }
  for (const port of scene.ports) {
    const expected = document.ports.find(p => p.id === port.id);
    if (!expected || port.ownerId !== expected.ownerId || port.presentation !== 'compartment-row') issues.push(`${port.id}:port-owner`);
  }
  for (let i = 0; i < labels.length; i++) for (const other of labels.slice(i + 1)) {
    if (overlap(labels[i], other)) issues.push(`${labels[i].id}:${other.id}:label-overlap`);
  }
  for (const edge of scene.edges) {
    const expected = document.edges.find(e => e.id === edge.id);
    if (!expected || edge.source !== expected.source || edge.target !== expected.target || edge.kind !== expected.kind) issues.push(`${edge.id}:wrong-endpoint`);
    if (expected && (edge.dashed !== dashed(expected.kind) || edge.marker !== markerFor(expected.kind)
      || JSON.stringify(textIdentity(edge.labels)) !== JSON.stringify(textIdentity(expected.labelLines)))) issues.push(`${edge.id}:relation-presentation`);
    if (edge.points.length < 2) { issues.push(`${edge.id}:missing-route`); continue; }
    if (edge.sourceAnchor?.ownerId !== edge.source || edge.targetAnchor?.ownerId !== edge.target) issues.push(`${edge.id}:anchor-owner`);
    for (const [anchor, end, next] of [[edge.sourceAnchor, edge.points[0], edge.points[1]],
      [edge.targetAnchor, edge.points.at(-1), edge.points.at(-2)]]) {
      const owner = scene.nodes.find(n => n.id === anchor?.ownerId);
      if (!owner || !next || Math.hypot(end.x - anchor.x, end.y - anchor.y) > 0.05) { issues.push(`${edge.id}:detached`); continue; }
      const horizontal = ['WEST', 'EAST'].includes(anchor.side);
      const positive = ['EAST', 'SOUTH'].includes(anchor.side);
      const boundary = horizontal ? owner.x + (positive ? owner.width : 0) : owner.y + (positive ? owner.height : 0);
      if (Math.abs((horizontal ? end.x : end.y) - boundary) > 0.05) issues.push(`${edge.id}:wrong-boundary`);
      if (Math.abs(horizontal ? next.y - end.y : next.x - end.x) > 0.05
        || (horizontal ? next.x - end.x : next.y - end.y) * (positive ? 1 : -1) <= 0) issues.push(`${edge.id}:wrong-exit`);
    }
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) issues.push(`${edge.id}:non-finite`);
      if (Math.abs(a.x - b.x) > 0.05 && Math.abs(a.y - b.y) > 0.05) issues.push(`${edge.id}:diagonal`);
      for (const box of [...scene.nodes, ...labels]) if (hits(a, b, box)) issues.push(`${edge.id}:${box.id}:crosses-obstacle`);
    }
    if (edge.marker !== 'none') {
      const end = edge.points.at(-1), before = edge.points.at(-2);
      const dx = Math.sign(end.x - before.x), dy = Math.sign(end.y - before.y);
      const marker = { x: Math.min(end.x, end.x - dx * 12) - (dy ? 5 : 0),
        y: Math.min(end.y, end.y - dy * 12) - (dx ? 5 : 0), width: dx ? 12 : 10, height: dy ? 12 : 10 };
      for (const label of labels) if (overlap(marker, label)) issues.push(`${edge.id}:${label.id}:marker-overlap`);
      for (const other of scene.edges) if (other.id !== edge.id) for (let i = 1; i < other.points.length; i++) {
        if (hits(other.points[i - 1], other.points[i], marker)) issues.push(`${other.id}:${edge.id}:crosses-marker`);
      }
    }
    for (const other of scene.edges) if (edge.id < other.id) {
      for (let i = 1; i < edge.points.length; i++) for (let j = 1; j < other.points.length; j++) {
        const a = edge.points[i - 1], b = edge.points[i], c = other.points[j - 1], d = other.points[j];
        for (const [fixed, axis] of [['x', 'y'], ['y', 'x']]) {
          if (Math.abs(a[fixed] - b[fixed]) < 0.05 && Math.abs(c[fixed] - d[fixed]) < 0.05 && Math.abs(a[fixed] - c[fixed]) < 0.05
            && Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > 1) {
            issues.push(`${edge.id}:${other.id}:shared-segment`);
          }
        }
      }
    }
  }
  return { status: issues.length ? 'failed' : 'ready', issues, nodeCount: scene.nodes.length,
    portCount: scene.ports.length, edgeCount: scene.edges.length };
}

module.exports = { PROFILES, createGeneralGraph, generalScene, repairGeneral, inspectGeneral };
