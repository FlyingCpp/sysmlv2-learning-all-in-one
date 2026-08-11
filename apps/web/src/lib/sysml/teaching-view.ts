export type TeachingLane = 'control' | 'environment' | 'interface' | 'behavior' | 'evidence' | 'system';
export type TeachingEdgeCategory = 'coolant' | 'refrigerant' | 'air' | 'command' | 'telemetry' | 'satisfy' | 'verify' | 'default';

export interface TeachingNode {
  name?: string;
  typeName?: string;
  kind?: string;
}

export interface TeachingEdge {
  name?: string;
  source?: string;
  target?: string;
  category?: TeachingEdgeCategory | string;
  typeLabel?: string;
  label?: string;
}

export interface TeachingLegendItem {
  kind: string;
  label: string;
  description: string;
}

export function teachingLaneForNode(node: TeachingNode): TeachingLane {
  const signal = `${node.name} ${node.typeName} ${node.kind}`.toLowerCase();
  if (/controller|control|command|telemetry|signal/.test(signal)) return 'control';
  if (/ambient|air|cabin|radiator|road|driver|environment/.test(signal)) return 'environment';
  if (/port|interface|connection|item|flow|coolant|refrigerant|octovalve|router|manifold|pump|compressor|valve|heat\s*pump|heatpump|chiller|evaporator/.test(signal)) return 'interface';
  if (/action|state|behavior|drivecycle|charging/.test(signal)) return 'behavior';
  if (/requirement|analysis|verification|constraint|calc|satisfy|verify|range|evidence/.test(signal)) return 'evidence';
  return 'system';
}

export function humanizeEndpoint(value: unknown): string {
  const text = String(value || '');
  const [base, feature] = text.split('.');
  return feature ? `${teachingDisplayName(base)}.${feature}` : teachingDisplayName(text);
}

export function teachingDisplayName(value: unknown): string {
  const aliases: Record<string, string> = {
    archBattery: '电池热域 / Battery',
    archDriveElectronics: '电驱电控热域 / Drive Electronics',
    archOctovalve: '八通阀 / Octovalve',
    archHeatPump: '热泵换热域 / Heat Pump',
    archCabin: '座舱热域 / Cabin',
    archRadiator: '前端散热器 / Radiator',
    archAmbient: '环境空气 / Ambient',
    archController: '热管理控制器 / Controller',
    archCompressor: '压缩机 / Compressor',
    archChiller: '冷凝器-冷却器 / Chiller',
    archExpansionValve: '膨胀阀 / Expansion Valve',
    archEvaporator: '蒸发器 / Evaporator'
  };
  const key = String(value || '');
  return aliases[key] || humanizeModelName(key);
}

export function teachingLegendItems(edges: readonly TeachingEdge[] = []): TeachingLegendItem[] {
  const labels: Record<string, [string, string]> = {
    coolant: ['冷却液/热流', '部件之间的热量搬运路径'],
    refrigerant: ['制冷剂', '热泵制冷循环介质'],
    air: ['空气', '环境或座舱空气边界'],
    command: ['控制命令', '控制器发出的泵、阀、压缩机指令'],
    telemetry: ['温度反馈', '传感器或热状态回传'],
    satisfy: ['满足需求', '模型对象承担需求'],
    verify: ['验证需求', '验证用例检查需求']
  };
  return Array.from(new Set(edges.map((edge) => String(edge.category || ''))))
    .filter((kind) => labels[kind])
    .map((kind) => ({ kind, label: labels[kind][0], description: labels[kind][1] }));
}

export function teachingLoopSummary(edges: readonly TeachingEdge[] = []): string[] {
  const text = edges.map((edge) => `${edge.label} ${edge.source} ${edge.target} ${edge.typeLabel}`).join('\n').toLowerCase();
  const loops: string[] = [];
  if (/battery/.test(text) && /coolant|冷却液/.test(text)) loops.push('电池冷却回路');
  if (/drive|electronics|电驱/.test(text) && /coolant|冷却液/.test(text)) loops.push('电驱电控冷却回路');
  if (/heat pump|chiller|compressor|evaporator|refrigerant|制冷剂|热泵/.test(text)) loops.push('热泵/制冷剂回路');
  if (/radiator|ambient|散热器|环境/.test(text)) loops.push('散热器与环境换热回路');
  if (/command|telemetry|feedback|控制|反馈/.test(text)) loops.push('控制命令与温度反馈闭环');
  return loops;
}

export function humanizeModelName(value: unknown): string {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
