import { createHash } from "node:crypto";

import type {
  CandidateStructureEvidence,
  ValidationOutput,
} from "./types.mjs";

export type RepairIssueCategory = "syntax" | "semantic" | "course";

export interface RepairIssue {
  readonly issueId: string;
  readonly category: RepairIssueCategory;
  readonly priority: 1 | 2 | 3 | 4;
  readonly severity: "error" | "warning" | "info";
  readonly code?: string;
  readonly message: string;
  readonly fileId?: string;
  readonly line?: number;
  readonly column?: number;
  readonly from?: number;
  readonly to?: number;
  readonly targetConstruct?: "port" | "interface" | "connect";
}

export interface RepairIssueCluster {
  readonly clusterId: string;
  readonly category: RepairIssueCategory;
  readonly priority: 1 | 2 | 3 | 4;
  readonly fileId?: string;
  readonly issueCount: number;
  readonly issues: readonly RepairIssue[];
}

export interface RepairIssueSet {
  readonly protocolVersion: "repair-issue-set-v1";
  readonly candidateHash: string;
  readonly validatorEvidenceHash: string;
  readonly issueCount: number;
  readonly categoryCounts: Readonly<Record<RepairIssueCategory, number>>;
  readonly issues: readonly RepairIssue[];
  readonly clusters: readonly RepairIssueCluster[];
  readonly activeCluster?: RepairIssueCluster;
}

export interface DiagnosticDelta {
  readonly protocolVersion: "repair-diagnostic-delta-v1";
  readonly resolved: readonly RepairIssue[];
  readonly unchanged: readonly RepairIssue[];
  readonly introduced: readonly RepairIssue[];
  readonly regressed: readonly RepairIssue[];
  readonly counts: {
    readonly resolved: number;
    readonly unchanged: number;
    readonly introduced: number;
    readonly regressed: number;
  };
}

export interface CandidateDeclarationChange {
  readonly kind: string;
  readonly name: string;
  readonly line: number;
}

export interface CandidateStructureNodeChange {
  readonly kind: string;
  readonly name?: string;
  readonly qualifiedName?: string;
  readonly fileId?: string;
  readonly line?: number;
}

export interface CandidateChangeSummary {
  readonly protocolVersion: "candidate-change-summary-v1";
  readonly fromCandidateHash: string;
  readonly toCandidateHash: string;
  readonly text: {
    readonly changed: boolean;
    readonly addedLineCount: number;
    readonly removedLineCount: number;
    readonly changedLineCount: number;
    readonly changedRanges: readonly {
      readonly previousStartLine: number;
      readonly previousEndLine: number;
      readonly nextStartLine: number;
      readonly nextEndLine: number;
    }[];
  };
  readonly declarations: {
    readonly added: readonly CandidateDeclarationChange[];
    readonly removed: readonly CandidateDeclarationChange[];
    readonly changedKinds: readonly string[];
  };
  readonly structure: {
    readonly added: readonly CandidateStructureNodeChange[];
    readonly removed: readonly CandidateStructureNodeChange[];
    readonly changedNodeCount: number;
  };
  readonly outOfClusterChange: boolean;
  readonly outOfClusterReasons: readonly string[];
}

export interface RepairRoundTrace {
  readonly round: number;
  readonly candidateHash: string;
  readonly validatorEvidenceHash: string;
  readonly issueCount: number;
  readonly activeClusterId?: string;
  readonly activeCategory?: RepairIssueCategory;
  readonly diagnosticDelta: DiagnosticDelta["counts"];
  readonly changedLineCount: number;
  readonly changedDeclarationKinds: readonly string[];
  readonly changedStructureNodeCount: number;
  readonly outOfClusterChange: boolean;
}

interface DiagnosticSource {
  readonly severity: "error" | "warning" | "info";
  readonly code?: string;
  readonly message: string;
  readonly fileId?: string;
  readonly line?: number;
  readonly column?: number;
  readonly from?: number;
  readonly to?: number;
  readonly targetConstruct?: "port" | "interface" | "connect";
}

const CATEGORY_PRIORITY: Readonly<Record<RepairIssueCategory, 1 | 2 | 3>> = {
  syntax: 1,
  semantic: 2,
  course: 3,
};

const DECLARATION_PATTERN = /^\s*(?:abstract\s+)?(part\s+def|port\s+def|interface\s+def|connection\s+def|action\s+def|state\s+def|requirement\s+def|attribute\s+def|item\s+def|calc\s+def|constraint\s+def|viewpoint\s+def|view\s+def|metadata\s+def|enum\s+def|part|port|interface|connection|connect|action|state|requirement|attribute|item|calc|constraint|view|expose)\b\s*([\p{L}_][\p{L}\p{N}_]*)?/iu;

export function createRepairIssueSet(
  validation: ValidationOutput,
  candidateHash: string,
): RepairIssueSet {
  const sources: Array<{ category: RepairIssueCategory; diagnostic: DiagnosticSource }> = [];
  const officialCategory: RepairIssueCategory = validation.official.syntax === "passed"
    ? "semantic"
    : "syntax";
  for (const diagnostic of validation.official.diagnostics) {
    sources.push({ category: officialCategory, diagnostic });
  }
  if (validation.official.syntax === "failed" && validation.official.diagnostics.length === 0) {
    sources.push({
      category: "syntax",
      diagnostic: { severity: "error", code: "OFFICIAL_SYNTAX_FAILED", message: "Official syntax validation failed." },
    });
  } else if (validation.official.syntax === "passed"
    && validation.official.semantic === "failed"
    && validation.official.diagnostics.length === 0) {
    sources.push({
      category: "semantic",
      diagnostic: { severity: "error", code: "OFFICIAL_SEMANTIC_FAILED", message: "Official semantic validation failed." },
    });
  }
  const occurrenceByBaseIdentity = new Map<string, number>();
  const issues = sources
    .sort(compareDiagnosticSources)
    .map(({ category, diagnostic }) => {
      const baseIdentity = stableIssueIdentity(category, diagnostic);
      const occurrence = (occurrenceByBaseIdentity.get(baseIdentity) ?? 0) + 1;
      occurrenceByBaseIdentity.set(baseIdentity, occurrence);
      return {
        issueId: hashValue(`${baseIdentity}\n${occurrence}`),
        category,
        priority: CATEGORY_PRIORITY[category],
        severity: diagnostic.severity,
        ...(diagnostic.code ? { code: diagnostic.code } : {}),
        message: diagnostic.message,
        ...(diagnostic.fileId ? { fileId: diagnostic.fileId } : {}),
        ...(diagnostic.line ? { line: diagnostic.line } : {}),
        ...(diagnostic.column ? { column: diagnostic.column } : {}),
        ...(diagnostic.from !== undefined ? { from: diagnostic.from } : {}),
        ...(diagnostic.to !== undefined ? { to: diagnostic.to } : {}),
        ...(diagnostic.targetConstruct ? { targetConstruct: diagnostic.targetConstruct } : {}),
      } satisfies RepairIssue;
    });
  const clustersByKey = new Map<string, RepairIssue[]>();
  for (const issue of issues) {
    const key = `${issue.category}\n${issue.fileId ?? "workspace"}\n${issue.code ?? "uncoded"}`;
    const clusterIssues = clustersByKey.get(key) ?? [];
    clusterIssues.push(issue);
    clustersByKey.set(key, clusterIssues);
  }
  const clusters = [...clustersByKey.entries()]
    .map(([key, clusterIssues]) => ({
      clusterId: hashValue(key),
      category: clusterIssues[0]!.category,
      priority: clusterIssues[0]!.priority,
      ...(clusterIssues[0]?.fileId ? { fileId: clusterIssues[0].fileId } : {}),
      issueCount: clusterIssues.length,
      issues: clusterIssues,
    } satisfies RepairIssueCluster))
    .sort(compareClusters);
  const categoryCounts = {
    syntax: issues.filter((issue) => issue.category === "syntax").length,
    semantic: issues.filter((issue) => issue.category === "semantic").length,
    course: issues.filter((issue) => issue.category === "course").length,
  };
  return {
    protocolVersion: "repair-issue-set-v1",
    candidateHash,
    validatorEvidenceHash: validation.validator.evidenceHash,
    issueCount: issues.length,
    categoryCounts,
    issues,
    clusters,
    ...(clusters[0] ? { activeCluster: clusters[0] } : {}),
  };
}

export function createInitialDiagnosticDelta(issueSet: RepairIssueSet): DiagnosticDelta {
  return createDelta([], [], issueSet.issues, []);
}

export function computeDiagnosticDelta(
  previous: RepairIssueSet,
  next: RepairIssueSet,
  previouslyResolvedIssueIds: ReadonlySet<string> = new Set<string>(),
): DiagnosticDelta {
  const previousById = new Map(previous.issues.map((issue) => [issue.issueId, issue]));
  const nextById = new Map(next.issues.map((issue) => [issue.issueId, issue]));
  const resolved = previous.issues.filter((issue) => !nextById.has(issue.issueId));
  const unchanged = next.issues.filter((issue) => previousById.has(issue.issueId));
  const newIssues = next.issues.filter((issue) => !previousById.has(issue.issueId));
  const regressed = newIssues.filter((issue) => previouslyResolvedIssueIds.has(issue.issueId));
  const regressedIds = new Set(regressed.map((issue) => issue.issueId));
  const introduced = newIssues.filter((issue) => !regressedIds.has(issue.issueId));
  return createDelta(resolved, unchanged, introduced, regressed);
}

export function summarizeCandidateChanges(input: {
  previousContent: string;
  nextContent: string;
  previousStructure?: CandidateStructureEvidence;
  nextStructure?: CandidateStructureEvidence;
  activeCluster?: RepairIssueCluster;
}): CandidateChangeSummary {
  const previousLines = splitLines(input.previousContent);
  const nextLines = splitLines(input.nextContent);
  const text = summarizeTextChange(previousLines, nextLines);
  const declarationDelta = diffDeclarations(
    extractDeclarations(previousLines),
    extractDeclarations(nextLines),
  );
  const structureDelta = diffStructureNodes(
    input.previousStructure?.nodes ?? [],
    input.nextStructure?.nodes ?? [],
  );
  const locality = assessChangeLocality({
    activeCluster: input.activeCluster,
    text,
    declarationDelta,
    structureDelta,
  });
  return {
    protocolVersion: "candidate-change-summary-v1",
    fromCandidateHash: hashValue(input.previousContent),
    toCandidateHash: hashValue(input.nextContent),
    text,
    declarations: declarationDelta,
    structure: structureDelta,
    outOfClusterChange: locality.reasons.length > 0,
    outOfClusterReasons: locality.reasons,
  };
}

export function toRepairRoundTrace(input: {
  round: number;
  issueSet: RepairIssueSet;
  diagnosticDelta: DiagnosticDelta;
  changeSummary: CandidateChangeSummary;
}): RepairRoundTrace {
  return {
    round: input.round,
    candidateHash: input.issueSet.candidateHash,
    validatorEvidenceHash: input.issueSet.validatorEvidenceHash,
    issueCount: input.issueSet.issueCount,
    ...(input.issueSet.activeCluster ? {
      activeClusterId: input.issueSet.activeCluster.clusterId,
      activeCategory: input.issueSet.activeCluster.category,
    } : {}),
    diagnosticDelta: input.diagnosticDelta.counts,
    changedLineCount: input.changeSummary.text.changedLineCount,
    changedDeclarationKinds: input.changeSummary.declarations.changedKinds,
    changedStructureNodeCount: input.changeSummary.structure.changedNodeCount,
    outOfClusterChange: input.changeSummary.outOfClusterChange,
  };
}

function createDelta(
  resolved: readonly RepairIssue[],
  unchanged: readonly RepairIssue[],
  introduced: readonly RepairIssue[],
  regressed: readonly RepairIssue[],
): DiagnosticDelta {
  return {
    protocolVersion: "repair-diagnostic-delta-v1",
    resolved,
    unchanged,
    introduced,
    regressed,
    counts: {
      resolved: resolved.length,
      unchanged: unchanged.length,
      introduced: introduced.length,
      regressed: regressed.length,
    },
  };
}

function stableIssueIdentity(category: RepairIssueCategory, diagnostic: DiagnosticSource): string {
  return JSON.stringify({
    category,
    severity: diagnostic.severity,
    code: diagnostic.code ?? "",
    message: normalizeText(diagnostic.message),
    fileId: diagnostic.fileId ?? "",
    targetConstruct: diagnostic.targetConstruct ?? "",
  });
}

function compareDiagnosticSources(
  left: { category: RepairIssueCategory; diagnostic: DiagnosticSource },
  right: { category: RepairIssueCategory; diagnostic: DiagnosticSource },
): number {
  return CATEGORY_PRIORITY[left.category] - CATEGORY_PRIORITY[right.category]
    || severityRank(left.diagnostic.severity) - severityRank(right.diagnostic.severity)
    || (left.diagnostic.fileId ?? "").localeCompare(right.diagnostic.fileId ?? "")
    || (left.diagnostic.code ?? "").localeCompare(right.diagnostic.code ?? "")
    || normalizeText(left.diagnostic.message).localeCompare(normalizeText(right.diagnostic.message))
    || (left.diagnostic.line ?? 0) - (right.diagnostic.line ?? 0)
    || (left.diagnostic.column ?? 0) - (right.diagnostic.column ?? 0);
}

function compareClusters(left: RepairIssueCluster, right: RepairIssueCluster): number {
  return left.priority - right.priority
    || severityRank(left.issues[0]?.severity ?? "info") - severityRank(right.issues[0]?.severity ?? "info")
    || (left.issues[0]?.line ?? Number.MAX_SAFE_INTEGER) - (right.issues[0]?.line ?? Number.MAX_SAFE_INTEGER)
    || left.clusterId.localeCompare(right.clusterId);
}

function severityRank(severity: RepairIssue["severity"]): number {
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function summarizeTextChange(
  previousLines: readonly string[],
  nextLines: readonly string[],
): CandidateChangeSummary["text"] {
  let prefix = 0;
  const commonLimit = Math.min(previousLines.length, nextLines.length);
  while (prefix < commonLimit && previousLines[prefix] === nextLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < commonLimit - prefix
    && previousLines[previousLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]) {
    suffix += 1;
  }
  const removedLineCount = previousLines.length - prefix - suffix;
  const addedLineCount = nextLines.length - prefix - suffix;
  const changed = removedLineCount > 0 || addedLineCount > 0;
  return {
    changed,
    addedLineCount,
    removedLineCount,
    changedLineCount: Math.max(addedLineCount, removedLineCount),
    changedRanges: changed ? [{
      previousStartLine: prefix + 1,
      previousEndLine: Math.max(prefix + 1, previousLines.length - suffix),
      nextStartLine: prefix + 1,
      nextEndLine: Math.max(prefix + 1, nextLines.length - suffix),
    }] : [],
  };
}

function extractDeclarations(lines: readonly string[]): CandidateDeclarationChange[] {
  return lines.flatMap((line, index) => {
    const match = DECLARATION_PATTERN.exec(line);
    if (!match?.[1]) return [];
    const kind = normalizeText(match[1]);
    const name = match[2] ?? normalizeText(line).slice(0, 160);
    return [{ kind, name, line: index + 1 }];
  });
}

function diffDeclarations(
  previous: readonly CandidateDeclarationChange[],
  next: readonly CandidateDeclarationChange[],
): CandidateChangeSummary["declarations"] {
  const previousByKey = groupByStableKey(previous, declarationKey);
  const nextByKey = groupByStableKey(next, declarationKey);
  const removed = consumeDifference(previousByKey, nextByKey);
  const added = consumeDifference(nextByKey, previousByKey);
  return {
    added,
    removed,
    changedKinds: [...new Set([...added, ...removed].map((item) => item.kind))].sort(),
  };
}

function declarationKey(value: CandidateDeclarationChange): string {
  return `${value.kind}\n${value.name}`;
}

function diffStructureNodes(
  previous: CandidateStructureEvidence["nodes"],
  next: CandidateStructureEvidence["nodes"],
): CandidateChangeSummary["structure"] {
  const previousByKey = groupByStableKey(previous, structureNodeKey);
  const nextByKey = groupByStableKey(next, structureNodeKey);
  const removed = consumeDifference(previousByKey, nextByKey).map(projectStructureNode);
  const added = consumeDifference(nextByKey, previousByKey).map(projectStructureNode);
  return {
    added,
    removed,
    changedNodeCount: added.length + removed.length,
  };
}

function structureNodeKey(value: CandidateStructureEvidence["nodes"][number]): string {
  return JSON.stringify({
    kind: normalizeText(value.kind),
    name: value.qualifiedName ?? value.name ?? "",
    ownerPath: value.ownerPath ?? [],
    fileId: value.fileId ?? "",
  });
}

function projectStructureNode(
  value: CandidateStructureEvidence["nodes"][number],
): CandidateStructureNodeChange {
  return {
    kind: value.kind,
    ...(value.name ? { name: value.name } : {}),
    ...(value.qualifiedName ? { qualifiedName: value.qualifiedName } : {}),
    ...(value.fileId ? { fileId: value.fileId } : {}),
    ...(value.line ? { line: value.line } : {}),
  };
}

function assessChangeLocality(input: {
  activeCluster?: RepairIssueCluster;
  text: CandidateChangeSummary["text"];
  declarationDelta: CandidateChangeSummary["declarations"];
  structureDelta: CandidateChangeSummary["structure"];
}): { reasons: string[] } {
  const cluster = input.activeCluster;
  if (!cluster || !input.text.changed) return { reasons: [] };
  const reasons: string[] = [];
  const anchoredLines = cluster.issues.flatMap((issue) => issue.line ? [issue.line] : []);
  if (anchoredLines.length > 0) {
    const allowedStart = Math.max(1, Math.min(...anchoredLines) - 8);
    const allowedEnd = Math.max(...anchoredLines) + 8;
    if (input.text.changedRanges.some((range) => (
      range.nextStartLine < allowedStart || range.nextEndLine > allowedEnd
    ))) {
      reasons.push("text_change_outside_active_cluster_line_window");
    }
  }
  const clusterFileIds = new Set(cluster.issues.flatMap((issue) => issue.fileId ? [issue.fileId] : []));
  if (clusterFileIds.size > 0 && input.structureDelta.added.concat(input.structureDelta.removed)
    .some((node) => node.fileId && !clusterFileIds.has(node.fileId))) {
    reasons.push("structure_change_outside_active_cluster_file");
  }
  return { reasons };
}

function groupByStableKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function consumeDifference<T>(left: Map<string, T[]>, right: Map<string, T[]>): T[] {
  return [...left.entries()].flatMap(([key, values]) => {
    const rightCount = right.get(key)?.length ?? 0;
    return values.slice(rightCount);
  });
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n?/gu, "\n").split("\n");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function hashValue(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
