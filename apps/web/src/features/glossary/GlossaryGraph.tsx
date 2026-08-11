import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { GlossaryGraph as GlossaryGraphData, GlossaryGraphEdge, GlossaryGraphNode, GlossaryTerm } from '../../lib/course/types';
import { categoryForTerm, termKey } from './glossary-graph-model';

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 560;
const NODE_WIDTH = 126;
const NODE_HEIGHT = 48;
const MAX_VISIBLE_NODES = 28;
const MAX_NODES_PER_ROW = 7;

type PositionedNode = GlossaryGraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PositionedEdge = GlossaryGraphEdge & {
  d: string;
};

type LayoutState = {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
};

export function GlossaryGraph({
  graph,
  terms,
  selectedId,
  onSelect
}: {
  graph?: GlossaryGraphData;
  terms: GlossaryTerm[];
  selectedId: string;
  onSelect: (termId: string) => void;
}) {
  const graphView = useMemo(() => buildGraphView(graph, terms, selectedId), [graph, terms, selectedId]);
  const layout = useMemo(() => layeredLayout(graphView.nodes, graphView.edges), [graphView]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragRef = useRef({ pointerId: -1, startX: 0, startY: 0, panX: 0, panY: 0, dragged: false });

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [selectedId]);

  if (!graph) return <p className="muted">正在加载概念关系图。</p>;
  if (!graphView.nodes.length) return <p className="muted">没有可绘制的概念关系。</p>;

  return (
    <div className="glossaryNetwork" data-metamodel-graph>
      <svg
        className={`glossaryNetworkStage${isPanning ? ' isPanning' : ''}`}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="SysML v2 术语概念关系图"
        onPointerDown={(event) => startPan(event, pan, dragRef, setIsPanning)}
        onPointerMove={(event) => updatePan(event, dragRef, setPan)}
        onPointerUp={(event) => endPan(event, dragRef, setIsPanning)}
        onPointerCancel={(event) => endPan(event, dragRef, setIsPanning)}
      >
        <g className="glossaryNetworkViewport" transform={`translate(${pan.x} ${pan.y})`}>
          {layout.edges.map((edge) => (
            <path
              key={edge.id}
              className={`networkLink${graphView.pathEdgeIds.has(edge.id) ? ' isPath' : ''}${graphView.relatedEdgeIds.has(edge.id) ? ' related' : ''}`}
              d={edge.d}
            />
          ))}
          {layout.nodes.map((node) => {
            const isSelected = node.id === selectedId;
            const isPath = graphView.pathNodeIds.has(node.id);
            const isRelated = graphView.relatedNodeIds.has(node.id);
            const labelLines = labelLinesFor(node.label);
            return (
              <g
                key={node.id}
                className={`networkNode graphNode category-${node.category || categoryForTerm(node.label)}${isSelected ? ' isSelected' : ''}${isPath ? ' isPath' : ''}${isRelated ? ' related' : ''}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={node.isPlatformTerm ? 0 : -1}
                aria-current={isSelected}
                aria-disabled={!node.isPlatformTerm}
                data-term-id={node.id}
                onClick={() => {
                  if (node.isPlatformTerm && !dragRef.current.dragged) onSelect(node.termId || node.id);
                }}
                onKeyDown={(event) => {
                  if (node.isPlatformTerm && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onSelect(node.termId || node.id);
                  }
                }}
              >
                <rect width={node.width} height={node.height} rx="6" />
                <text className="networkNodeLabel" x={node.width / 2} y={labelLines.length > 1 ? 18 : 22}>
                  {labelLines.map((line, index) => (
                    <tspan key={`${line}-${index}`} x={node.width / 2} dy={index === 0 ? 0 : 14}>{line}</tspan>
                  ))}
                </text>
                <text className="networkNodeMeta" x={node.width / 2} y={node.height - 8}>{node.metamodelType || node.kind || 'metamodel'}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function startPan(
  event: ReactPointerEvent<SVGSVGElement>,
  pan: { x: number; y: number },
  dragRef: React.MutableRefObject<{ pointerId: number; startX: number; startY: number; panX: number; panY: number; dragged: boolean }>,
  setIsPanning: (value: boolean) => void
) {
  if (event.button !== 0) return;
  if ((event.target as Element).closest('.networkNode')) return;
  dragRef.current = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    panX: pan.x,
    panY: pan.y,
    dragged: false
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  setIsPanning(true);
}

function updatePan(
  event: ReactPointerEvent<SVGSVGElement>,
  dragRef: React.MutableRefObject<{ pointerId: number; startX: number; startY: number; panX: number; panY: number; dragged: boolean }>,
  setPan: (value: { x: number; y: number }) => void
) {
  const drag = dragRef.current;
  if (drag.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.dragged = true;
  setPan({ x: clamp(drag.panX + deltaX, -280, 280), y: clamp(drag.panY + deltaY, -180, 180) });
}

function endPan(
  event: ReactPointerEvent<SVGSVGElement>,
  dragRef: React.MutableRefObject<{ pointerId: number; startX: number; startY: number; panX: number; panY: number; dragged: boolean }>,
  setIsPanning: (value: boolean) => void
) {
  if (dragRef.current.pointerId !== event.pointerId) return;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  dragRef.current.pointerId = -1;
  setIsPanning(false);
}

export function GeneralizationPath({
  graph,
  selectedId,
  onSelect
}: {
  graph?: GlossaryGraphData;
  selectedId: string;
  onSelect: (termId: string) => void;
}) {
  const path = useMemo(() => {
    if (!graph || !selectedId) return [];
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    return ancestorsFor(selectedId, graph.edges).reverse().concat(selectedId)
      .filter((id, index, all) => all.indexOf(id) === index)
      .map((id) => nodeById.get(id))
      .filter(Boolean) as GlossaryGraphNode[];
  }, [graph, selectedId]);

  if (!path.length) return null;
  return (
    <section className="generalizationPath" aria-label="泛化路径">
      <strong>泛化路径</strong>
      <div>
        {path.map((node, index) => (
          <button key={node.id} type="button" onClick={() => onSelect(node.termId || node.id)}>
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {node.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function buildGraphView(graph: GlossaryGraphData | undefined, terms: GlossaryTerm[], selectedId: string) {
  const empty = {
    nodes: [] as GlossaryGraphNode[],
    edges: [] as GlossaryGraphEdge[],
    nodeById: new Map<string, GlossaryGraphNode>(),
    edgeById: new Map<string, GlossaryGraphEdge>(),
    pathNodeIds: new Set<string>(),
    pathEdgeIds: new Set<string>(),
    relatedNodeIds: new Set<string>(),
    relatedEdgeIds: new Set<string>()
  };
  if (!graph) return empty;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const baseIds = terms.map(termKey).filter(Boolean);
  const visibleIds = new Set(baseIds.slice(0, MAX_VISIBLE_NODES));
  if (selectedId) visibleIds.add(selectedId);
  for (const id of selectedId ? ancestorsFor(selectedId, graph.edges) : []) visibleIds.add(id);
  for (const edge of graph.edges) {
    if (edge.source === selectedId || edge.target === selectedId) {
      visibleIds.add(edge.source);
      visibleIds.add(edge.target);
    }
  }
  while (visibleIds.size > MAX_VISIBLE_NODES) {
    const removable = Array.from(visibleIds).find((id) => id !== selectedId && !baseIds.includes(id));
    if (!removable) break;
    visibleIds.delete(removable);
  }
  const nodes = Array.from(visibleIds).map((id) => nodeById.get(id)).filter(Boolean) as GlossaryGraphNode[];
  const includedIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target));
  const pathNodeIds = new Set(selectedId ? ancestorsFor(selectedId, graph.edges).concat(selectedId) : []);
  const pathEdgeIds = new Set(edges.filter((edge) => pathNodeIds.has(edge.source) && pathNodeIds.has(edge.target)).map((edge) => edge.id));
  const relatedEdgeIds = new Set(edges.filter((edge) => edge.source === selectedId || edge.target === selectedId).map((edge) => edge.id));
  const relatedNodeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === selectedId) relatedNodeIds.add(edge.target);
    if (edge.target === selectedId) relatedNodeIds.add(edge.source);
  }
  return {
    nodes,
    edges,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    edgeById: new Map(edges.map((edge) => [edge.id, edge])),
    pathNodeIds,
    pathEdgeIds,
    relatedNodeIds,
    relatedEdgeIds
  };
}

function ancestorsFor(termId: string, edges: GlossaryGraphEdge[]) {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target)?.push(edge.source);
  }
  const seen = new Set<string>();
  const queue = [...(incoming.get(termId) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    queue.push(...(incoming.get(id) || []));
  }
  return Array.from(seen);
}

function edgePath(edge: GlossaryGraphEdge, nodeById: Map<string, PositionedNode>) {
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  if (!source || !target) return '';
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height;
  const endX = target.x + target.width / 2;
  const endY = target.y;
  const verticalGap = Math.max(34, Math.abs(endY - startY) * 0.52);
  const controlY1 = startY + verticalGap;
  const controlY2 = endY - verticalGap;
  return `M ${round(startX)} ${round(startY)} C ${round(startX)} ${round(controlY1)}, ${round(endX)} ${round(controlY2)}, ${round(endX)} ${round(endY)}`;
}

function layeredLayout(nodes: GlossaryGraphNode[], edges: GlossaryGraphEdge[]): LayoutState {
  const visibleIds = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target)?.push(edge.source);
  }
  const depthById = new Map<string, number>();
  const depthFor = (id: string, seen = new Set<string>()): number => {
    if (depthById.has(id)) return depthById.get(id) || 0;
    if (seen.has(id)) return 0;
    const parents = incoming.get(id) || [];
    if (!parents.length) {
      depthById.set(id, 0);
      return 0;
    }
    const depth = Math.max(...parents.map((parent) => depthFor(parent, new Set(seen).add(id)) + 1));
    depthById.set(id, depth);
    return depth;
  };
  nodes.forEach((node) => depthFor(node.id));
  const buckets = new Map<number, GlossaryGraphNode[]>();
  for (const node of nodes) {
    const depth = depthById.get(node.id) || 0;
    if (!buckets.has(depth)) buckets.set(depth, []);
    buckets.get(depth)?.push(node);
  }
  const levels = Array.from(buckets.keys()).sort((left, right) => left - right);
  const width = CANVAS_WIDTH;
  const height = CANVAS_HEIGHT;
  const usableWidth = width - 52;
  const usableHeight = height - 50;
  const rows: GlossaryGraphNode[][] = [];
  for (const level of levels) {
    const bucket = (buckets.get(level) || []).sort((left, right) => {
      const category = (left.category || '').localeCompare(right.category || '');
      return category || left.label.localeCompare(right.label);
    });
    for (let index = 0; index < bucket.length; index += MAX_NODES_PER_ROW) {
      rows.push(bucket.slice(index, index + MAX_NODES_PER_ROW));
    }
  }
  const rowGap = rows.length > 1 ? usableHeight / (rows.length - 1) : 0;
  const positioned: PositionedNode[] = [];
  rows.forEach((row, rowIndex) => {
    const slot = usableWidth / Math.max(1, row.length);
    row.forEach((node, index) => {
      const centerX = 26 + slot * index + slot / 2;
      positioned.push({
        ...node,
        x: round(centerX - NODE_WIDTH / 2),
        y: round(25 + rowIndex * rowGap),
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      });
    });
  });
  const nodeById = new Map(positioned.map((node) => [node.id, node]));
  return {
    width,
    height,
    nodes: positioned,
    edges: edges.map((edge) => ({ ...edge, d: edgePath(edge, nodeById) }))
  };
}

function labelLinesFor(label: string) {
  const value = String(label || '');
  if (value.length <= 15) return [value];
  const parts = value.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
  if (parts.length < 2) return [`${value.slice(0, 14)}...`];
  const lines = ['', ''];
  for (const part of parts) {
    const target = lines[0].length <= lines[1].length ? 0 : 1;
    lines[target] = `${lines[target]} ${part}`.trim();
  }
  return lines.map((line) => line.length > 15 ? `${line.slice(0, 13)}...` : line);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
