'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');

const SYSON_GRAPHQL_URL = process.env.SYSON_GRAPHQL_URL || `${process.env.SYSON_INTERNAL_URL || 'http://localhost:18080'}/api/graphql`;
const SYSON_DB_HOST = process.env.SYSON_DB_HOST || 'syson-latest-database-1';
const SYSON_DB_PORT = Number(process.env.SYSON_DB_PORT || 5432);
const SYSON_DB_NAME = process.env.SYSON_DB_NAME || 'postgres';
const SYSON_DB_USER = process.env.SYSON_DB_USER || 'username';
const SYSON_DB_PASSWORD = process.env.SYSON_DB_PASSWORD || 'password';

let PgPool;
let pgPool;
try {
  ({ Pool: PgPool } = require('pg'));
} catch {
  PgPool = null;
}

async function enhanceSysONLayout(input = {}) {
  const editingContextId = String(input.editingContextId || '').trim();
  const representationId = String(input.representationId || '').trim();
  if (!editingContextId || !representationId) {
    return {
      ok: false,
      attempted: false,
      applied: false,
      error: 'editingContextId and representationId are required'
    };
  }

  const profile = normalizeLayoutProfile(input.layoutProfile);
  const arrangeAll = await arrangeAllDiagram(editingContextId, representationId).catch((error) => ({
    ok: false,
    error: error.message,
    details: error.details || null
  }));

  let diagram;
  try {
    diagram = await readRepresentationContent(representationId);
  } catch (error) {
    return {
      ok: Boolean(arrangeAll.ok),
      attempted: true,
      applied: false,
      mode: 'arrange-all-only',
      reason: 'representation-content-unavailable',
      message: error.message,
      arrangeAll
    };
  }

  const plan = await buildTeachingLayoutPlan(diagram, profile);
  if (!plan.shouldApply) {
    return {
      ok: Boolean(arrangeAll.ok),
      attempted: true,
      applied: false,
      mode: 'arrange-all-only',
      reason: plan.reason,
      arrangeAll,
      stats: plan.stats
    };
  }

  const layoutInput = buildLayoutDiagramInput({
    editingContextId,
    representationId,
    diagram,
    plan
  });
  const layoutMutation = await layoutDiagram(layoutInput);
  return {
    ok: true,
    attempted: true,
    applied: true,
    mode: 'teaching-layout-profile',
    profileId: profile.id,
    arrangeAll,
    result: layoutMutation,
    stats: plan.stats
  };
}

async function arrangeAllDiagram(editingContextId, representationId) {
  const query = `
    mutation arrangeAll($input: ArrangeAllInput!) {
      arrangeAll(input: $input) {
        __typename
        ... on SuccessPayload { id messages { level body } }
        ... on ErrorPayload { id messages { level body } }
      }
    }
  `;
  const data = await graphql(query, {
    input: {
      id: randomUUID(),
      editingContextId,
      representationId
    }
  });
  const payload = data.arrangeAll;
  if (!payload || payload.__typename === 'ErrorPayload') {
    const error = new Error('SysON arrangeAll failed');
    error.details = payload?.messages || payload;
    throw error;
  }
  return { ok: true, payload };
}

async function layoutDiagram(variables) {
  const query = `
    mutation layoutDiagram($input: LayoutDiagramInput!) {
      layoutDiagram(input: $input) {
        __typename
        ... on SuccessPayload { id messages { level body } }
        ... on ErrorPayload { id messages { level body } }
      }
    }
  `;
  const data = await graphql(query, variables);
  const payload = data.layoutDiagram;
  if (!payload || payload.__typename === 'ErrorPayload') {
    const error = new Error('SysON layoutDiagram failed');
    error.details = payload?.messages || payload;
    throw error;
  }
  return payload;
}

async function graphql(query, variables) {
  const response = await fetch(SYSON_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors) {
    const error = new Error(`SysON GraphQL failed: ${response.status}`);
    error.details = payload.errors || payload;
    throw error;
  }
  return payload.data || {};
}

async function readRepresentationContent(representationId) {
  try {
    return await readRepresentationContentViaPg(representationId);
  } catch (directError) {
    const fallback = readRepresentationContentViaDocker(representationId);
    if (fallback) return fallback;
    throw directError;
  }
}

async function readRepresentationContentViaPg(representationId) {
  if (!PgPool) throw new Error('pg dependency is not available');
  if (!pgPool) {
    pgPool = new PgPool({
      host: SYSON_DB_HOST,
      port: SYSON_DB_PORT,
      database: SYSON_DB_NAME,
      user: SYSON_DB_USER,
      password: SYSON_DB_PASSWORD,
      max: 2
    });
  }

  const queries = [
    {
      text: 'select content from representation_content where representation_metadata_id=$1 order by last_modified_on desc limit 1',
      values: [representationId]
    },
    {
      text: `
        select rc.content
          from representation_content rc
          join representation_metadata rm on rm.id = rc.id
         where rm.representation_metadata_id=$1
         order by rc.last_modified_on desc
         limit 1
      `,
      values: [representationId]
    }
  ];
  let lastError;
  for (const query of queries) {
    try {
      const result = await pgPool.query(query);
      const content = result.rows[0]?.content;
      if (content) return typeof content === 'string' ? JSON.parse(content) : content;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No SysON representation content found for ${representationId}`);
}

function readRepresentationContentViaDocker(representationId) {
  const docker = process.env.DOCKER_CLI || 'docker';
  const script = `
    const { Pool } = require('pg');
    const id = process.argv[1];
    (async () => {
      const pool = new Pool({ host: '${escapeJs(SYSON_DB_HOST)}', port: ${SYSON_DB_PORT}, database: '${escapeJs(SYSON_DB_NAME)}', user: '${escapeJs(SYSON_DB_USER)}', password: '${escapeJs(SYSON_DB_PASSWORD)}' });
      const queries = [
        ['select content from representation_content where representation_metadata_id=$1 order by last_modified_on desc limit 1', [id]],
        ['select rc.content from representation_content rc join representation_metadata rm on rm.id = rc.id where rm.representation_metadata_id=$1 order by rc.last_modified_on desc limit 1', [id]]
      ];
      for (const [text, values] of queries) {
        try {
          const result = await pool.query(text, values);
          const content = result.rows[0]?.content;
          if (content) {
            await pool.end();
            process.stdout.write(typeof content === 'string' ? content : JSON.stringify(content));
            return;
          }
        } catch {}
      }
      await pool.end();
      throw new Error('representation content not found');
    })().catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
  `;
  const result = spawnSync(docker, ['exec', 'quick-syson-viewer', 'node', '-e', script, representationId], {
    env: {
      ...process.env,
      DOCKER_HOST: process.env.DOCKER_HOST || 'tcp://127.0.0.1:2375'
    },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) return null;
  return JSON.parse(result.stdout);
}

async function buildTeachingLayoutPlan(diagram, profile = DEFAULT_THERMAL_PROFILE) {
  const visibleNodes = topLevelVisibleNodes(diagram);
  const ownerByNodeId = topLevelOwnerByNodeId(diagram);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = (diagram.edges || [])
    .filter((edge) => edge.state !== 'Hidden')
    .map((edge) => {
      const sourceTopLevelId = visibleNodeIds.has(edge.sourceId) ? edge.sourceId : ownerByNodeId.get(edge.sourceId);
      const targetTopLevelId = visibleNodeIds.has(edge.targetId) ? edge.targetId : ownerByNodeId.get(edge.targetId);
      return { ...edge, sourceTopLevelId, targetTopLevelId };
    })
    .filter((edge) => edge.sourceTopLevelId && edge.targetTopLevelId && edge.sourceTopLevelId !== edge.targetTopLevelId);
  const laneById = new Map(profile.lanes.map((lane, index) => [lane.id, { ...lane, index }]));
  const existingLayoutById = new Map(layoutMapValues(diagram.layoutData?.nodeLayoutData).map((item) => [item.id, item]));
  const elkLayout = await computeElkLayout(visibleNodes, visibleEdges).catch(() => null);
  const elkNodeById = new Map((elkLayout?.children || []).map((node) => [node.id, node]));

  const nodes = visibleNodes.map((node) => {
    const classification = classifyNode(node, profile);
    const previous = existingLayoutById.get(node.id);
    const size = {
      width: Math.max(round(previous?.size?.width || node.defaultWidth || 210), 150),
      height: Math.max(round(previous?.size?.height || node.defaultHeight || 120), 88)
    };
    return {
      id: node.id,
      label: nodeLabel(node),
      lane: laneById.has(classification.lane) ? classification.lane : profile.defaultLane,
      stage: classification.stage,
      confidence: classification.confidence,
      matched: classification.matched,
      size,
      elkX: round(elkNodeById.get(node.id)?.x),
      elkY: round(elkNodeById.get(node.id)?.y)
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const classifiedCount = nodes.filter((node) => node.matched && node.lane !== profile.defaultLane).length;
  const edgePlans = visibleEdges
    .map((edge) => {
      const source = nodeById.get(edge.sourceTopLevelId);
      const target = nodeById.get(edge.targetTopLevelId);
      if (!source || !target) return null;
      return { ...classifyEdge(edge, source, target, profile), id: edge.id, source, target };
    })
    .filter(Boolean);
  const domainEdgeCount = edgePlans.filter((edge) => edge.matched).length;

  if (nodes.length < 2) {
    return { shouldApply: false, reason: 'not-enough-visible-nodes', stats: { visibleNodeCount: nodes.length } };
  }
  if (classifiedCount < Number(profile.minClassifiedNodes || 2) && domainEdgeCount < Number(profile.minDomainEdges || 1)) {
    return {
      shouldApply: false,
      reason: 'layout-profile-not-matched',
      stats: { visibleNodeCount: nodes.length, classifiedCount, domainEdgeCount }
    };
  }

  assignStages(nodes, edgePlans);
  assignPositions(nodes, profile);
  for (const edge of edgePlans) {
    edge.bendingPoints = routeEdge(edge, profile);
  }

  return {
    shouldApply: true,
    profile,
    nodes,
    edges: edgePlans,
    stats: {
      visibleNodeCount: nodes.length,
      visibleEdgeCount: visibleEdges.length,
      classifiedCount,
      domainEdgeCount,
      unclassifiedNodes: nodes.filter((node) => node.lane === profile.defaultLane).map((node) => node.label).slice(0, 20)
    }
  };
}

function computeElkLayout(visibleNodes, visibleEdges) {
  const ELK = require('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return elk.layout({
    id: 'syson-teaching-layout',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '140',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF'
    },
    children: visibleNodes.map((node) => ({
      id: node.id,
      width: Math.max(Number(node.defaultWidth || 220), 160),
      height: Math.max(Number(node.defaultHeight || 120), 88),
      labels: [{ text: nodeLabel(node) }]
    })),
    edges: visibleEdges.map((edge) => ({
      id: edge.id,
      sources: [edge.sourceTopLevelId],
      targets: [edge.targetTopLevelId],
      labels: edge.targetObjectLabel ? [{ text: edge.targetObjectLabel }] : []
    }))
  });
}

function assignStages(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rank = new Map(nodes.map((node) => [node.id, Number.isFinite(node.stage) ? node.stage : 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const sourceRank = rank.get(edge.source.id) || 0;
      const targetRank = rank.get(edge.target.id) || 0;
      if (!Number.isFinite(edge.target.stage) && targetRank <= sourceRank) {
        rank.set(edge.target.id, sourceRank + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const elkSorted = [...nodes].sort((a, b) => (a.elkX - b.elkX) || (a.elkY - b.elkY));
  elkSorted.forEach((node, index) => {
    if (!rank.get(node.id)) rank.set(node.id, Math.floor(index / 2));
  });
  for (const node of nodes) {
    node.stage = clamp(Number.isFinite(node.stage) ? node.stage : rank.get(node.id), 0, 8);
    nodeById.set(node.id, node);
  }
}

function assignPositions(nodes, profile) {
  const laneIndex = new Map(profile.lanes.map((lane, index) => [lane.id, index]));
  const laneBuckets = new Map();
  for (const node of nodes) {
    const laneId = laneIndex.has(node.lane) ? node.lane : profile.defaultLane;
    const key = `${laneId}:${node.stage}`;
    if (!laneBuckets.has(key)) laneBuckets.set(key, []);
    laneBuckets.get(key).push(node);
  }
  for (const bucket of laneBuckets.values()) {
    bucket.sort((a, b) => (a.elkY - b.elkY) || a.label.localeCompare(b.label));
    bucket.forEach((node, index) => {
      const lane = profile.lanes[laneIndex.get(node.lane) ?? laneIndex.get(profile.defaultLane) ?? 0];
      node.position = {
        x: profile.canvas.paddingX + node.stage * profile.canvas.columnGap,
        y: profile.canvas.paddingY + (lane.order ?? laneIndex.get(lane.id) ?? 0) * profile.canvas.laneGap + index * profile.canvas.stackGap
      };
    });
  }
}

function routeEdge(edge, profile) {
  const source = edge.source;
  const target = edge.target;
  const start = {
    x: source.position.x + source.size.width,
    y: source.position.y + source.size.height / 2
  };
  const end = {
    x: target.position.x,
    y: target.position.y + target.size.height / 2
  };
  if (source.lane === target.lane) {
    const clearance = profile.canvas.edgeClearance || 56;
    const busY = round(Math.max(source.position.y + source.size.height, target.position.y + target.size.height) + clearance);
    const forward = end.x >= start.x;
    const outX = forward ? round(start.x + Math.min(90, Math.max(36, (end.x - start.x) / 4))) : round(start.x + profile.canvas.reverseEdgeDogleg);
    const inX = forward ? round(end.x - Math.min(90, Math.max(36, (end.x - start.x) / 4))) : round(end.x - profile.canvas.reverseEdgeDogleg);
    return [
      { x: outX, y: round(start.y) },
      { x: outX, y: busY },
      { x: inX, y: busY },
      { x: inX, y: round(end.y) }
    ];
  }
  const forward = end.x >= start.x;
  const midX = forward
    ? round((start.x + end.x) / 2)
    : round(Math.max(start.x, end.x) + profile.canvas.reverseEdgeDogleg);
  if (Math.abs(start.y - end.y) < 8) {
    return [{ x: midX, y: round(start.y) }];
  }
  return [
    { x: midX, y: round(start.y) },
    { x: midX, y: round(end.y) }
  ];
}

function buildLayoutDiagramInput({ editingContextId, representationId, diagram, plan }) {
  const nodeLayoutDataById = new Map(layoutMapValues(diagram.layoutData?.nodeLayoutData).map((item) => [item.id, normalizeNodeLayoutInput(item)]));
  const edgeLayoutDataById = new Map(layoutMapValues(diagram.layoutData?.edgeLayoutData).map((item) => [item.id, normalizeEdgeLayoutInput(item)]));
  const labelLayoutData = layoutMapValues(diagram.layoutData?.labelLayoutData).map((item) => normalizeLabelLayoutInput(item));

  for (const node of plan.nodes) {
    const previous = nodeLayoutDataById.get(node.id);
    nodeLayoutDataById.set(node.id, {
      ...(previous || {}),
      id: node.id,
      position: { x: round(node.position.x), y: round(node.position.y) },
      size: { width: round(node.size.width), height: round(node.size.height) },
      resizedByUser: Boolean(previous?.resizedByUser),
      movedByUser: true,
      handleLayoutData: previous?.handleLayoutData || [],
      minComputedSize: previous?.minComputedSize || { width: round(node.size.width), height: round(node.size.height) }
    });
  }

  for (const edge of plan.edges) {
    const previous = edgeLayoutDataById.get(edge.id);
    edgeLayoutDataById.set(edge.id, {
      ...(previous || {}),
      id: edge.id,
      bendingPoints: edge.bendingPoints,
      relativePositionBendingPoints: previous?.relativePositionBendingPoints || [],
      edgeAnchorLayoutData: previous?.edgeAnchorLayoutData || []
    });
  }

  return {
    input: {
      id: randomUUID(),
      editingContextId,
      representationId,
      cause: 'layout',
      diagramLayoutData: {
        nodeLayoutData: [...nodeLayoutDataById.values()].filter((item) => item.id),
        edgeLayoutData: [...edgeLayoutDataById.values()].filter((item) => item.id),
        labelLayoutData,
        autoLayoutState: 'DEACTIVATE'
      }
    }
  };
}

function classifyNode(node, profile) {
  const text = nodeSearchText(node);
  const hints = profile.nodeHints || [];
  for (const hint of hints) {
    if (matchesAny(text, hint.match)) {
      return {
        lane: hint.lane || profile.defaultLane,
        stage: Number.isFinite(hint.stage) ? hint.stage : Number(hint.stage),
        confidence: hint.confidence || 'configured',
        matched: true
      };
    }
  }
  for (const lane of profile.lanes) {
    if (matchesAny(text, lane.match)) {
      return { lane: lane.id, stage: Number.NaN, confidence: 'lane-keyword', matched: lane.id !== profile.defaultLane };
    }
  }
  return { lane: profile.defaultLane, stage: Number.NaN, confidence: 'unclassified', matched: false };
}

function classifyEdge(edge, source, target, profile) {
  const text = `${edge.targetObjectLabel || ''} ${edge.descriptionId || ''} ${edge.style?.edgeType || ''} ${source.label} ${target.label}`.toLowerCase();
  for (const hint of profile.edgeHints || []) {
    if (matchesAny(text, hint.match)) {
      return { kind: hint.kind || hint.lane || 'relationship', lane: hint.lane || source.lane, matched: true };
    }
  }
  if (source.lane === target.lane && source.lane !== profile.defaultLane) {
    return { kind: source.lane, lane: source.lane, matched: true };
  }
  return { kind: 'relationship', lane: source.lane, matched: false };
}

function normalizeLayoutProfile(profile) {
  const input = profile && typeof profile === 'object' ? profile : {};
  const merged = {
    ...DEFAULT_THERMAL_PROFILE,
    ...input,
    canvas: { ...DEFAULT_THERMAL_PROFILE.canvas, ...(input.canvas || {}) },
    lanes: Array.isArray(input.lanes) && input.lanes.length ? input.lanes : DEFAULT_THERMAL_PROFILE.lanes,
    nodeHints: Array.isArray(input.nodeHints) ? input.nodeHints : DEFAULT_THERMAL_PROFILE.nodeHints,
    edgeHints: Array.isArray(input.edgeHints) ? input.edgeHints : DEFAULT_THERMAL_PROFILE.edgeHints
  };
  if (!merged.defaultLane) merged.defaultLane = merged.lanes[merged.lanes.length - 1]?.id || 'custom';
  return merged;
}

function topLevelVisibleNodes(diagram) {
  return (diagram.nodes || []).filter((node) => node.state !== 'Hidden');
}

function topLevelOwnerByNodeId(diagram) {
  const owners = new Map();
  for (const topLevel of diagram.nodes || []) {
    if (topLevel.state === 'Hidden') continue;
    visit(topLevel, topLevel.id);
  }
  return owners;

  function visit(node, ownerId) {
    owners.set(node.id, ownerId);
    for (const borderNode of node.borderNodes || []) visit(borderNode, ownerId);
    for (const child of node.childNodes || []) visit(child, ownerId);
  }
}

function nodeSearchText(node) {
  const parts = [];
  visit(node);
  return parts.join(' ').toLowerCase();

  function visit(item) {
    parts.push(item.targetObjectLabel, item.targetObjectKind, item.descriptionId, item.insideLabel?.text, item.outsideLabels?.map((label) => label.text).join(' '));
    for (const borderNode of item.borderNodes || []) visit(borderNode);
    for (const child of item.childNodes || []) visit(child);
  }
}

function nodeLabel(node) {
  return String(node.targetObjectLabel || node.insideLabel?.text || '').replace(/\s+/g, ' ').trim() || node.id;
}

function matchesAny(text, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns].filter(Boolean);
  return list.some((pattern) => {
    if (!pattern) return false;
    if (pattern instanceof RegExp) return pattern.test(text);
    return new RegExp(String(pattern), 'i').test(text);
  });
}

function layoutMapValues(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

function normalizeNodeLayoutInput(item) {
  const width = Math.max(round(item.size?.width), 1);
  const height = Math.max(round(item.size?.height), 1);
  return {
    id: item.id,
    position: { x: round(item.position?.x), y: round(item.position?.y) },
    size: { width, height },
    resizedByUser: Boolean(item.resizedByUser),
    movedByUser: Boolean(item.movedByUser),
    handleLayoutData: Array.isArray(item.handleLayoutData) ? item.handleLayoutData : [],
    minComputedSize: item.minComputedSize ? { width: round(item.minComputedSize.width), height: round(item.minComputedSize.height) } : { width, height }
  };
}

function normalizeEdgeLayoutInput(item) {
  return {
    id: item.id,
    bendingPoints: normalizePoints(item.bendingPoints),
    relativePositionBendingPoints: normalizePoints(item.relativePositionBendingPoints),
    edgeAnchorLayoutData: Array.isArray(item.edgeAnchorLayoutData) ? item.edgeAnchorLayoutData : []
  };
}

function normalizeLabelLayoutInput(item) {
  return {
    id: item.id,
    position: { x: round(item.position?.x), y: round(item.position?.y) },
    size: { width: Math.max(round(item.size?.width), 1), height: Math.max(round(item.size?.height), 1) },
    resizedByUser: Boolean(item.resizedByUser),
    movedByUser: Boolean(item.movedByUser)
  };
}

function normalizePoints(points) {
  return Array.isArray(points) ? points.map((point) => ({ x: round(point.x), y: round(point.y) })) : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function escapeJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const DEFAULT_THERMAL_PROFILE = {
  id: 'automotive-thermal-v1',
  title: '电动汽车热管理教学布局',
  minClassifiedNodes: 2,
  minDomainEdges: 1,
  defaultLane: 'custom',
  canvas: {
    paddingX: 120,
    paddingY: 80,
    columnGap: 330,
    laneGap: 390,
    stackGap: 185,
    edgeClearance: 56,
    reverseEdgeDogleg: 170
  },
  lanes: [
    {
      id: 'thermal',
      order: 0,
      title: '热源/冷却液主链路',
      match: ['battery|cell|drive|electronics|motor|inverter|coolant|thermal|heatpump|heat pump|octovalve|pump|radiator|chiller']
    },
    {
      id: 'refrigerant',
      order: 1,
      title: '冷媒回路',
      match: ['refrigerant|compressor|condenser|evaporator|expansion|valve|chiller|heat pump']
    },
    {
      id: 'air',
      order: 2,
      title: '空气边界与换热',
      match: ['air|ambient|cabin|blower|hvac|radiator|evaporator']
    },
    {
      id: 'control',
      order: 3,
      title: '控制命令',
      match: ['control|command|controller|actuator|request|setpoint|mode']
    },
    {
      id: 'telemetry',
      order: 4,
      title: '温度遥测',
      match: ['telemetry|sensor|signal|temperature|temp|feedback|measurement']
    },
    {
      id: 'custom',
      order: 5,
      title: '自定义/未分类',
      match: []
    }
  ],
  nodeHints: [
    { match: ['battery|cell|pack'], lane: 'thermal', stage: 0 },
    { match: ['drive|electronics|motor|inverter'], lane: 'thermal', stage: 1 },
    { match: ['octovalve|router|manifold|pump'], lane: 'thermal', stage: 2 },
    { match: ['heatpump|heat pump|chiller'], lane: 'thermal', stage: 3 },
    { match: ['radiator'], lane: 'thermal', stage: 5 },
    { match: ['compressor'], lane: 'refrigerant', stage: 2 },
    { match: ['condenser|chiller'], lane: 'refrigerant', stage: 3 },
    { match: ['expansion'], lane: 'refrigerant', stage: 4 },
    { match: ['evaporator'], lane: 'refrigerant', stage: 5 },
    { match: ['ambient'], lane: 'air', stage: 0 },
    { match: ['cabin|hvac|blower'], lane: 'air', stage: 5 },
    { match: ['controller|control'], lane: 'control', stage: 3 },
    { match: ['command|actuator|setpoint'], lane: 'control', stage: 4 },
    { match: ['telemetry|sensor|temperature|signal|feedback'], lane: 'telemetry', stage: 4 }
  ],
  edgeHints: [
    { match: ['coolant|thermal|heat'], lane: 'thermal', kind: 'coolant' },
    { match: ['refrigerant|compressor|expansion|evaporator|condenser'], lane: 'refrigerant', kind: 'refrigerant' },
    { match: ['air|ambient|cabin|hvac'], lane: 'air', kind: 'air' },
    { match: ['command|control|setpoint|request'], lane: 'control', kind: 'command' },
    { match: ['telemetry|temperature|sensor|signal|feedback'], lane: 'telemetry', kind: 'telemetry' }
  ]
};

module.exports = {
  DEFAULT_THERMAL_PROFILE,
  enhanceSysONLayout,
  buildTeachingLayoutPlan,
  buildLayoutDiagramInput
};
