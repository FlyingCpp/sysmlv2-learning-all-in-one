export interface ExampleInjectionGroup {
  readonly id: string;
  readonly enabled: boolean;
  readonly constructTags: readonly string[];
  readonly canonicalQuery: string;
  readonly triggersEn: readonly string[];
  readonly triggersZh: readonly string[];
  readonly baselineSuppressPattern?: string | null;
}

export const F4_INJECTION_GROUP_PRIORITY = Object.freeze([
  "G-STATE",
  "G-PORT-CONNECT",
  "G-CALC",
  "G-FLOW",
  "G-ACTION",
  "G-REQ",
  "G-CONSTRAINT",
  "G-ENUM",
  "G-ALLOC",
  "G-VERIFICATION",
  "G-USECASE",
  "G-ANALYSIS",
  "G-OCCURRENCE",
  "G-INDIVIDUAL",
  "G-EXPRESSION",
  "G-METADATA",
  "G-VARIABILITY",
  "G-PACKAGE",
  "G-ATTR",
  "G-PART",
  "G-VIEW",
]);

export const F4_TRIGGER_GROUPS: readonly ExampleInjectionGroup[] = Object.freeze([
  group("G-STATE", true, ["state-def", "transition"], "state def",
    ["state machine", "state def", "state", "transition", "statechart", "mode switch"],
    ["状态机", "状态定义", "状态图", "状态", "状态切换", "状态转换", "状态迁移", "迁移", "切换", "模式切换"],
    "transition\\s+first\\b|first\\s+\\S+\\s+then\\b"),
  group("G-PORT-CONNECT", true, ["port-def", "connect", "interface"], "port connect",
    ["port", "connect", "connection", "interface", "wiring"],
    ["端口", "连接", "接口", "接口定义", "对接", "互联", "连线"],
    "\\bconnect\\s+\\S+\\s+to\\b"),
  group("G-PART", false, ["part-def", "part-usage"], "part def",
    ["part def", "part", "component", "subsystem", "assembly", "decomposition"],
    ["部件", "部件定义", "零件", "组件", "子系统", "结构分解", "装配"],
    "\\bpart\\s+def\\b"),
  group("G-ACTION", true, ["action-def"], "action def",
    ["action", "activity", "behavior step", "workflow"],
    ["动作", "动作定义", "行为", "活动", "流程步骤", "动作序列"],
    "\\baction\\s+def\\b"),
  group("G-FLOW", true, ["flow", "item"], "flow",
    ["flow", "item flow", "data flow", "item def", "signal flow"],
    ["数据流", "物质流", "能量流", "信号流", "物项", "流动"],
    "\\bflow\\s+\\S+\\s+(?:from|to)\\b"),
  group("G-REQ", true, ["requirement"], "requirement def",
    ["requirement", "shall statement"],
    ["需求", "需求定义", "指标要求"],
    "\\brequirement\\s+def\\b"),
  group("G-ATTR", true, ["attribute"], "attribute",
    ["attribute", "property", "parameter", "value type"],
    ["属性", "参数", "特征值", "数值属性"],
    "\\battribute\\b"),
  group("G-CALC", true, ["calc"], "calc def",
    ["calculation", "calc", "formula", "rollup", "compute total"],
    ["计算", "公式", "汇总", "合计", "质量汇总"],
    "\\bcalc\\s+def\\b"),
  group("G-CONSTRAINT", true, ["constraint"], "constraint def",
    ["constraint", "equation", "limit condition"],
    ["约束", "约束方程", "限制条件"],
    "\\bconstraint\\b"),
  group("G-VIEW", false, ["view"], "view",
    ["view", "viewpoint", "expose", "render diagram"],
    ["视图", "视角", "渲染视图"],
    null),
  group("G-ENUM", true, ["enum"], "enumeration",
    ["enum", "enumeration"],
    ["枚举", "枚举定义"],
    "\\benum\\s+def\\b"),
  group("G-ALLOC", true, ["allocation"], "allocation",
    ["allocate", "allocation"],
    ["分配", "分配关系"],
    "\\ballocate\\b"),
  group("G-METADATA", true, ["metadata"], "metadata",
    ["metadata", "stereotype", "annotation"],
    ["元数据", "标注"],
    "\\bmetadata\\s+def\\b"),
  group("G-VARIABILITY", true, ["variability"], "variation",
    ["variant", "variation", "variability", "configuration option"],
    ["变体", "变型", "可变性", "变体配置"],
    "\\bvariation\\b"),
  group("G-VERIFICATION", true, ["verification"], "verification",
    ["verification case", "verify requirement", "test case"],
    ["验证用例", "校验用例", "测试用例", "验证需求"],
    "\\bverification\\b"),
  group("G-USECASE", true, ["use-case"], "use case",
    ["use case"],
    ["用例", "使用场景"],
    "\\buse\\s+case\\b"),
  group("G-ANALYSIS", true, ["analysis"], "analysis",
    ["analysis case", "trade study", "trade-off analysis"],
    ["权衡分析", "分析模型", "分析用例"],
    "\\banalysis\\b"),
  group("G-OCCURRENCE", true, ["occurrence"], "occurrence",
    ["occurrence", "event occurrence", "timeline"],
    ["发生实例", "事件发生", "时序事件"],
    "\\boccurrence\\b"),
  group("G-INDIVIDUAL", true, ["individual"], "individual",
    ["individual", "snapshot", "timeslice"],
    ["个体", "快照", "时间片"],
    "\\bindividual\\b"),
  group("G-EXPRESSION", true, ["expression"], "expression",
    ["expression", "operator expression"],
    ["表达式"],
    null),
  group("G-PACKAGE", true, ["package"], "package",
    ["package", "namespace", "import structure", "library organization"],
    ["包结构", "分包", "模型包", "命名空间", "导入"],
    "\\bpackage\\s+\\S+"),
]);

export interface ExampleInjectionPlan {
  readonly group: ExampleInjectionGroup;
  readonly query: string;
  readonly constructTags: readonly string[];
}

export function scanExampleInjectionTriggers(
  text: string,
  groups: readonly ExampleInjectionGroup[] = F4_TRIGGER_GROUPS,
): readonly ExampleInjectionGroup[] {
  const haystack = normalizeScanText(text);
  if (!haystack) return [];
  const catalog = triggerCatalog(groups);
  const hits = new Map<string, ExampleInjectionGroup>();
  let index = 0;
  while (index < haystack.length) {
    let matchedLength = 0;
    for (const entry of catalog) {
      if (!entry.group.enabled) continue;
      if (!haystack.startsWith(entry.needle, index)) continue;
      if (entry.kind === "en" && !englishBoundary(haystack, index, entry.needle.length)) continue;
      hits.set(entry.group.id, entry.group);
      matchedLength = entry.needle.length;
      break;
    }
    index += matchedLength > 0 ? matchedLength : 1;
  }
  return [...hits.values()];
}

export function selectExampleInjectionGroup(
  input: {
    scanText: string;
    baselineText?: string;
    groups?: readonly ExampleInjectionGroup[];
  },
): ExampleInjectionPlan | undefined {
  const groups = input.groups ?? F4_TRIGGER_GROUPS;
  const matched = scanExampleInjectionTriggers(input.scanText, groups)
    .filter((group) => group.enabled)
    .filter((group) => !baselineSuppresses(group, input.baselineText));
  if (matched.length === 0) return undefined;
  const ranked = [...matched].sort((left, right) => (
    F4_INJECTION_GROUP_PRIORITY.indexOf(left.id) - F4_INJECTION_GROUP_PRIORITY.indexOf(right.id)
  ));
  const group = ranked[0];
  if (!group) return undefined;
  return {
    group,
    query: group.canonicalQuery,
    constructTags: group.constructTags,
  };
}

export function buildServerInjectedKnowledgeEntry(input: {
  runId: string;
  query: string;
  examples: readonly Record<string, unknown>[];
}): {
  toolCallId: string;
  toolName: "search_reviewed_knowledge";
  input: { query: string; limit: number };
  output: Record<string, unknown>;
} {
  return {
    toolCallId: `server-injected:${input.runId}`,
    toolName: "search_reviewed_knowledge",
    input: { query: input.query, limit: input.examples.length },
    output: {
      coverage: "PARTIAL",
      requestedQuery: input.query,
      effectiveQuery: input.query,
      origin: "server_injected",
      claims: [],
      evidenceBlocks: [],
      examples: input.examples,
    },
  };
}

export function extractInjectableExamples(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const examples = (raw as { examples?: unknown }).examples;
  if (!Array.isArray(examples)) return [];
  return examples.filter((example): example is Record<string, unknown> => (
    Boolean(example)
    && typeof example === "object"
    && !Array.isArray(example)
    && (example as { validatorPassed?: unknown }).validatorPassed === true
    && typeof (example as { modelText?: unknown }).modelText === "string"
    && String((example as { modelText?: unknown }).modelText).trim().length > 0
  ));
}

export function coveredConstructTagsFromExamples(
  examples: readonly { constructTags?: readonly string[] }[],
): readonly string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const example of examples) {
    for (const tag of example.constructTags || []) {
      const text = String(tag || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      tags.push(text);
    }
  }
  return tags;
}

function group(
  id: string,
  enabled: boolean,
  constructTags: readonly string[],
  canonicalQuery: string,
  triggersEn: readonly string[],
  triggersZh: readonly string[],
  baselineSuppressPattern: string | null,
): ExampleInjectionGroup {
  return Object.freeze({
    id,
    enabled,
    constructTags: Object.freeze([...constructTags]),
    canonicalQuery,
    triggersEn: Object.freeze([...triggersEn]),
    triggersZh: Object.freeze([...triggersZh]),
    baselineSuppressPattern,
  });
}

function triggerCatalog(groups: readonly ExampleInjectionGroup[]): readonly {
  group: ExampleInjectionGroup;
  needle: string;
  kind: "en" | "zh";
}[] {
  const entries: { group: ExampleInjectionGroup; needle: string; kind: "en" | "zh" }[] = [];
  for (const item of groups) {
    for (const trigger of item.triggersEn) {
      entries.push({ group: item, needle: trigger.toLowerCase(), kind: "en" });
    }
    for (const trigger of item.triggersZh) {
      entries.push({ group: item, needle: trigger.normalize("NFKC"), kind: "zh" });
    }
  }
  return entries.sort((left, right) => right.needle.length - left.needle.length);
}

function normalizeScanText(value: string): string {
  return String(value || "").normalize("NFKC").replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function englishBoundary(text: string, index: number, length: number): boolean {
  const before = index === 0 ? "" : text[index - 1] ?? "";
  const after = text[index + length] ?? "";
  return !/[a-z0-9_]/i.test(before) && !/[a-z0-9_]/i.test(after);
}

function baselineSuppresses(group: ExampleInjectionGroup, baselineText: string | undefined): boolean {
  const pattern = group.baselineSuppressPattern;
  if (!pattern || !baselineText) return false;
  return new RegExp(pattern, "iu").test(baselineText);
}
