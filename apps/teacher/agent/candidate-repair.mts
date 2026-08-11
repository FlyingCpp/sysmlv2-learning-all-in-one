import { createHash } from "node:crypto";

import { z } from "zod";

import { validationOutputSchema } from "./types.mjs";
import { DEFAULT_MAX_UNIQUE_CANDIDATE_VALIDATIONS_PER_WORKER } from "./run-resources.mjs";

export const REPAIR_POLICY = Object.freeze({
  maxCandidateAttempts: DEFAULT_MAX_UNIQUE_CANDIDATE_VALIDATIONS_PER_WORKER - 1,
  maxPatchAttempts: 6,
  maxProposalAttempts: 9,
  maxConsecutiveProposalRejections: 3,
  maxConsecutiveNoProgress: 2,
  maxHypothesesPerRound: 1,
  requestValidatorConcurrency: 1,
  maxValidatorCalls: DEFAULT_MAX_UNIQUE_CANDIDATE_VALIDATIONS_PER_WORKER,
  maxControlledRegenerations: 0,
});

const opaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const repairEditSchema = z.object({
  fileId: opaqueIdSchema,
  regionId: opaqueIdSchema,
  operation: z.enum(["replace", "insert_before", "insert_after"]),
  expectedText: z.string().min(1).max(8_000),
  replacementText: z.string().max(8_000),
}).strict();

export const repairHypothesisSchema = z.object({
  hypothesisId: opaqueIdSchema,
  rootCause: z.string().trim().min(1).max(2_000),
  confidence: z.enum(["high", "medium", "low"]),
  edits: z.array(repairEditSchema).min(1).max(4),
}).strict().superRefine((hypothesis, issueContext) => {
  const fileIds = new Set(hypothesis.edits.map((edit) => edit.fileId));
  if (fileIds.size > 2) {
    issueContext.addIssue({
      code: "custom",
      path: ["edits"],
      message: "A repair hypothesis may edit at most two files.",
    });
  }
  const replacementCharacters = hypothesis.edits.reduce(
    (total, edit) => total + edit.replacementText.length,
    0,
  );
  if (replacementCharacters > 8_000) {
    issueContext.addIssue({
      code: "custom",
      path: ["edits"],
      message: "A repair hypothesis may replace at most 8,000 characters.",
    });
  }
});

export const repairProposalSchema = z.object({
  schemaVersion: z.literal("candidate-repair-proposal-v1"),
  hypotheses: z.array(repairHypothesisSchema).min(1).max(REPAIR_POLICY.maxHypothesesPerRound),
}).strict().superRefine((proposal, issueContext) => {
  const ids = proposal.hypotheses.map((hypothesis) => hypothesis.hypothesisId);
  if (new Set(ids).size !== ids.length) {
    issueContext.addIssue({
      code: "custom",
      path: ["hypotheses"],
      message: "Repair hypothesis IDs must be unique.",
    });
  }
});

export type RepairEdit = z.infer<typeof repairEditSchema>;
export type RepairHypothesis = z.infer<typeof repairHypothesisSchema>;
export type RepairProposal = z.infer<typeof repairProposalSchema>;

export interface RepairCandidateFile {
  fileId: string;
  displayName: string;
  content: string;
  contentHash?: string;
  editable?: boolean;
}

export interface RepairCandidateSnapshot {
  mode: "standalone_model" | "replace_entry" | "apply_edits" | "workspace_files";
  files: RepairCandidateFile[];
}

export interface RepairRegion {
  regionId: string;
  fileId: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  contentHash: string;
  content: string;
  reason:
    | "reported_area"
    | "upstream_statement"
    | "containing_member"
    | "unbalanced_structure"
    | "editable_file"
    | "validator_reported_file_without_location";
}

export interface DiagnosticCluster {
  clusterId: string;
  layer: "official_syntax" | "official_semantic" | "course_rule";
  fileId: string;
  diagnosticIds: string[];
  fingerprints: string[];
  reportedAnchor: {
    from?: number;
    to?: number;
    line?: number;
    column?: number;
  };
  repairRegions: RepairRegion[];
  baseCandidateHash: string;
}

export interface RepairBudgetState {
  candidateRecoveryAttempts: number;
  patchRoundsUsed: number;
  uniquePatchRounds: number;
  fullRegenerationsUsed: number;
}

let activeGlobalValidatorCalls = 0;
const globalValidatorQueue: Array<() => void> = [];

export async function withGlobalValidatorPermit<T>(
  limit: number,
  operation: () => Promise<T>,
): Promise<T> {
  const boundedLimit = Math.max(1, Math.trunc(limit));
  if (activeGlobalValidatorCalls >= boundedLimit) {
    await new Promise<void>((resolve) => globalValidatorQueue.push(resolve));
  }
  activeGlobalValidatorCalls += 1;
  try {
    return await operation();
  } finally {
    activeGlobalValidatorCalls -= 1;
    globalValidatorQueue.shift()?.();
  }
}

export function createRepairBudgetState(
  input: Partial<RepairBudgetState> = {},
): RepairBudgetState {
  return {
    candidateRecoveryAttempts: boundedInteger(input.candidateRecoveryAttempts, 0),
    patchRoundsUsed: boundedInteger(input.patchRoundsUsed, 0),
    uniquePatchRounds: boundedInteger(input.uniquePatchRounds, 0),
    fullRegenerationsUsed: boundedInteger(input.fullRegenerationsUsed, 0),
  };
}

export function canAdmitControlledRegeneration(input: {
  taskGoal: string;
  budget: RepairBudgetState;
  validatorCallsUsed: number;
}): boolean {
  void input;
  return false;
}

export interface RepairChangeAuthorization {
  baselineSnapshot: RepairCandidateSnapshot;
  ranges: Array<{
    fileId: string;
    startOffset: number;
    endOffset: number;
  }>;
}

export function candidateSnapshotHash(snapshot: RepairCandidateSnapshot): string {
  const canonical = JSON.stringify({
    mode: snapshot.mode,
    files: [...snapshot.files]
      .sort((left, right) => left.fileId.localeCompare(right.fileId))
      .map((file) => ({ fileId: file.fileId, content: file.content })),
  });
  return sha256(canonical);
}

export function buildDiagnosticClusters(input: {
  snapshot: RepairCandidateSnapshot;
  validation: unknown;
}): DiagnosticCluster[] {
  const validation = validationOutputSchema.safeParse(input.validation);
  if (!validation.success || validation.data.completeness !== "complete") return [];
  const layer = failedLayer(validation.data);
  if (!layer) return [];
  const diagnostics = layer === "course_rule"
    ? validation.data.courseRules?.diagnostics ?? []
    : validation.data.official.diagnostics;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return [];
  const first = [...errors].sort(compareDiagnosticLocation)[0];
  if (!first) return [];
  const defaultFile = input.snapshot.files[0];
  const file = input.snapshot.files.find((candidate) => candidate.fileId === first.fileId)
    ?? (input.snapshot.files.length === 1 ? defaultFile : undefined);
  if (!file) return [];
  const reportedRegion = buildReportedRegion(file, first.line, first.from, first.to);
  const editableFileRegions = input.snapshot.files
    .filter((candidate) => candidate.editable !== false)
    .map(buildEditableFileRegion);
  const repairRegions = editableFileRegions.some((candidate) => (
    candidate.fileId === reportedRegion.fileId
    && candidate.startOffset === reportedRegion.startOffset
    && candidate.endOffset === reportedRegion.endOffset
  ))
    ? [reportedRegion, ...editableFileRegions.filter((candidate) => candidate.fileId !== reportedRegion.fileId)]
    : [...editableFileRegions, reportedRegion];
  const fingerprints = errors.map(diagnosticFingerprint);
  const clusterId = stableId("cluster", [layer, file.fileId, ...fingerprints].join("\n"));
  return [{
    clusterId,
    layer,
    fileId: file.fileId,
    diagnosticIds: errors.map((diagnostic, index) => diagnostic.code ?? `${clusterId}-${index + 1}`),
    fingerprints,
    reportedAnchor: compactAnchor(first),
    repairRegions,
    baseCandidateHash: candidateSnapshotHash(input.snapshot),
  }];
}

export type ApplyRepairResult =
  | {
      ok: true;
      snapshot: RepairCandidateSnapshot;
      candidateHash: string;
      editCount: number;
      changedCharacters: number;
    }
  | {
      ok: false;
      reason:
        | "base_candidate_hash_conflict"
        | "region_not_authorized"
        | "region_out_of_bounds"
        | "region_hash_conflict"
        | "file_not_editable"
        | "expected_text_not_found"
        | "expected_text_not_unique"
        | "change_outside_authorized_region"
        | "edit_conflict"
        | "candidate_hash_unchanged";
      rejectionDetail?: RepairAnchorRejectionDetail;
    };

export interface RepairAnchorRejectionDetail {
  expectedText: string;
  matchCount: number;
  matches: Array<{
    offset: number;
    line: number;
    column: number;
    context: string;
  }>;
}

export function applyRepairHypothesis(input: {
  baseSnapshot: RepairCandidateSnapshot;
  baseCandidateHash: string;
  regions: readonly RepairRegion[];
  hypothesis: RepairHypothesis;
  minimalPatchRequired?: boolean;
  changeAuthorization?: RepairChangeAuthorization;
}): ApplyRepairResult {
  const actualBaseHash = candidateSnapshotHash(input.baseSnapshot);
  if (input.baseCandidateHash !== actualBaseHash) {
    return { ok: false, reason: "base_candidate_hash_conflict" };
  }
  const duplicateEditKey = new Set<string>();
  for (const edit of input.hypothesis.edits) {
    const key = `${edit.fileId}\u0000${edit.regionId}\u0000${edit.operation}\u0000${edit.expectedText}`;
    if (duplicateEditKey.has(key)) return { ok: false, reason: "edit_conflict" };
    duplicateEditKey.add(key);
  }
  const files = input.baseSnapshot.files.map((file) => ({ ...file }));
  const mutationsByFile = new Map<string, Array<{
    start: number;
    end: number;
    replacement: string;
  }>>();
  for (const edit of input.hypothesis.edits) {
    const region = input.regions.find((candidate) => (
      candidate.regionId === edit.regionId && candidate.fileId === edit.fileId
    ));
    if (!region) return { ok: false, reason: "region_not_authorized" };
    const file = files.find((candidate) => candidate.fileId === edit.fileId);
    if (!file) return { ok: false, reason: "region_not_authorized" };
    if (file.editable === false) return { ok: false, reason: "file_not_editable" };
    if (!Number.isInteger(region.startOffset)
      || !Number.isInteger(region.endOffset)
      || region.startOffset < 0
      || region.endOffset < region.startOffset
      || region.endOffset > file.content.length) {
      return { ok: false, reason: "region_out_of_bounds" };
    }
    const currentRegion = file.content.slice(region.startOffset, region.endOffset);
    if (sha256(currentRegion) !== region.contentHash) {
      return { ok: false, reason: "region_hash_conflict" };
    }
    const matches = exactMatches(currentRegion, edit.expectedText);
    const rejectionDetail = anchorRejectionDetail(
      file.content,
      region.startOffset,
      edit.expectedText,
      matches,
    );
    if (matches.length === 0) {
      return { ok: false, reason: "expected_text_not_found", rejectionDetail };
    }
    if (matches.length > 1) {
      return { ok: false, reason: "expected_text_not_unique", rejectionDetail };
    }
    const anchorStart = region.startOffset + (matches[0] ?? 0);
    const anchorEnd = anchorStart + edit.expectedText.length;
    const mutation = edit.operation === "insert_before"
      ? { start: anchorStart, end: anchorStart, replacement: edit.replacementText }
      : edit.operation === "insert_after"
        ? { start: anchorEnd, end: anchorEnd, replacement: edit.replacementText }
        : { start: anchorStart, end: anchorEnd, replacement: edit.replacementText };
    const existing = mutationsByFile.get(file.fileId) ?? [];
    if (existing.some((candidate) => mutationsConflict(candidate, mutation))) {
      return { ok: false, reason: "edit_conflict" };
    }
    existing.push(mutation);
    mutationsByFile.set(file.fileId, existing);
  }
  let changedCharacters = 0;
  for (const file of files) {
    const mutations = mutationsByFile.get(file.fileId);
    if (!mutations) continue;
    for (const mutation of [...mutations].sort((left, right) => right.start - left.start)) {
      const previousLength = mutation.end - mutation.start;
      changedCharacters += Math.max(previousLength, mutation.replacement.length);
      file.content = `${file.content.slice(0, mutation.start)}${mutation.replacement}${file.content.slice(mutation.end)}`;
    }
  }
  const snapshot = { ...input.baseSnapshot, files };
  if (input.changeAuthorization
    && !preservesChangeAuthorization(snapshot, input.changeAuthorization)) {
    return { ok: false, reason: "change_outside_authorized_region" };
  }
  const candidateHash = candidateSnapshotHash(snapshot);
  if (candidateHash === actualBaseHash) return { ok: false, reason: "candidate_hash_unchanged" };
  return {
    ok: true,
    snapshot,
    candidateHash,
    editCount: input.hypothesis.edits.length,
    changedCharacters,
  };
}

export function compareValidationProgress(
  left: unknown,
  right: unknown,
  targetCluster?: DiagnosticCluster,
  courseRulesRequired = true,
): number {
  const leftScore = validationProgressScore(left, targetCluster, courseRulesRequired);
  const rightScore = validationProgressScore(right, targetCluster, courseRulesRequired);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface RepairRoundAttempt {
  hypothesisId: string;
  status: "rejected" | "validated_failed" | "validated_passed";
  candidateHash?: string;
  rejectionReason?: string;
  rejectionDetail?: RepairAnchorRejectionDetail;
  validation?: unknown;
  snapshot?: RepairCandidateSnapshot;
  editCount?: number;
  changedCharacters?: number;
}

export async function runIsolatedRepairRound(input: {
  baseSnapshot: RepairCandidateSnapshot;
  baseValidation: unknown;
  cluster: DiagnosticCluster;
  proposal: unknown;
  validatorCallsUsed: number;
  maxValidatorCalls?: number;
  requestConcurrency?: number;
  courseRulesRequired?: boolean;
  minimalPatchRequired?: boolean;
  changeAuthorization?: RepairChangeAuthorization;
  validationCache?: Map<string, unknown>;
  validate: (snapshot: RepairCandidateSnapshot, candidateHash: string) => Promise<unknown>;
}): Promise<{
  attempts: RepairRoundAttempt[];
  passed: boolean;
  exhausted: boolean;
  selectedHypothesisId?: string;
  selectedSnapshot?: RepairCandidateSnapshot;
  selectedValidation?: unknown;
  selectedCandidateHash?: string;
  validatorCallsUsed: number;
  informationGain: boolean;
}> {
  const proposal = repairProposalSchema.safeParse(input.proposal);
  if (!proposal.success) {
    return {
      attempts: [],
      passed: false,
      exhausted: false,
      validatorCallsUsed: input.validatorCallsUsed,
      informationGain: false,
    };
  }
  const maxCalls = Math.min(
    REPAIR_POLICY.maxValidatorCalls,
    Math.max(0, Math.trunc(input.maxValidatorCalls ?? REPAIR_POLICY.maxValidatorCalls)),
  );
  const concurrency = Math.max(1, Math.min(
    REPAIR_POLICY.requestValidatorConcurrency,
    Math.trunc(input.requestConcurrency ?? REPAIR_POLICY.requestValidatorConcurrency),
  ));
  const cache = input.validationCache ?? new Map<string, unknown>();
  const attempts: RepairRoundAttempt[] = [];
  const pending: Array<RepairRoundAttempt & {
    snapshot: RepairCandidateSnapshot;
    candidateHash: string;
  }> = [];
  for (const hypothesis of proposal.data.hypotheses) {
    const applied = applyRepairHypothesis({
      baseSnapshot: input.baseSnapshot,
      baseCandidateHash: input.cluster.baseCandidateHash,
      regions: input.cluster.repairRegions,
      hypothesis,
      minimalPatchRequired: input.minimalPatchRequired,
      changeAuthorization: input.changeAuthorization,
    });
    if (!applied.ok) {
      attempts.push({
        hypothesisId: hypothesis.hypothesisId,
        status: "rejected",
        rejectionReason: applied.reason,
        ...(applied.rejectionDetail ? { rejectionDetail: applied.rejectionDetail } : {}),
      });
      continue;
    }
    pending.push({
      hypothesisId: hypothesis.hypothesisId,
      status: "validated_failed",
      candidateHash: applied.candidateHash,
      snapshot: applied.snapshot,
      editCount: applied.editCount,
      changedCharacters: applied.changedCharacters,
    });
  }
  let validatorCallsUsed = Math.max(0, Math.trunc(input.validatorCallsUsed));
  let selected: RepairRoundAttempt | undefined;
  for (let index = 0; index < pending.length && !selected; index += concurrency) {
    const remaining = maxCalls - validatorCallsUsed;
    if (remaining <= 0) break;
    const batch = pending.slice(index, index + Math.min(concurrency, remaining));
    const uniqueByHash = new Map<string, typeof batch[number]>();
    for (const attempt of batch) {
      if (!uniqueByHash.has(attempt.candidateHash)) uniqueByHash.set(attempt.candidateHash, attempt);
    }
    const validationByHash = new Map<string, unknown>();
    await Promise.all([...uniqueByHash.values()].map(async (attempt) => {
      const cached = cache.get(attempt.candidateHash);
      if (cached !== undefined) {
        validationByHash.set(attempt.candidateHash, cached);
        return;
      }
      validatorCallsUsed += 1;
      const validation = await input.validate(attempt.snapshot, attempt.candidateHash);
      cache.set(attempt.candidateHash, validation);
      validationByHash.set(attempt.candidateHash, validation);
    }));
    for (const attempt of batch) {
      const validation = validationByHash.get(attempt.candidateHash)
        ?? cache.get(attempt.candidateHash);
      const completed: RepairRoundAttempt = {
        ...attempt,
        status: validationPassed(validation, input.courseRulesRequired ?? true)
          ? "validated_passed"
          : "validated_failed",
        validation,
      };
      attempts.push(completed);
      if (!selected && validationPassed(validation, input.courseRulesRequired ?? true)) selected = completed;
    }
  }
  if (!selected) {
    selected = attempts
      .filter((attempt) => attempt.validation !== undefined)
      .sort((left, right) => (
        compareValidationProgress(
          right.validation,
          left.validation,
          input.cluster,
          input.courseRulesRequired ?? true,
        )
        || (left.changedCharacters ?? Number.MAX_SAFE_INTEGER) - (right.changedCharacters ?? Number.MAX_SAFE_INTEGER)
      ))[0];
  }
  const informationGain = Boolean(
    selected?.validation !== undefined
    && compareValidationProgress(
      selected.validation,
      input.baseValidation,
      input.cluster,
      input.courseRulesRequired ?? true,
    ) > 0,
  );
  return {
    attempts,
    passed: selected?.status === "validated_passed",
    exhausted: validatorCallsUsed >= maxCalls && selected?.status !== "validated_passed",
    ...(selected ? {
      selectedHypothesisId: selected.hypothesisId,
      selectedSnapshot: selected.snapshot,
      selectedValidation: selected.validation,
      selectedCandidateHash: selected.candidateHash,
    } : {}),
    validatorCallsUsed,
    informationGain,
  };
}

function buildReportedRegion(
  file: RepairCandidateFile,
  diagnosticLine?: number,
  diagnosticFrom?: number,
  diagnosticTo?: number,
): RepairRegion {
  const offsets = lineOffsets(file.content);
  const hasReportedLocation = diagnosticLine !== undefined
    || diagnosticFrom !== undefined
    || diagnosticTo !== undefined;
  if (!hasReportedLocation && offsets.length <= 40 && file.content.length <= 8_000) {
    return {
      regionId: stableId("region", `${file.fileId}:0:${file.content.length}:${sha256(file.content)}`),
      fileId: file.fileId,
      startLine: 1,
      endLine: offsets.length,
      startOffset: 0,
      endOffset: file.content.length,
      content: file.content,
      contentHash: sha256(file.content),
      reason: "validator_reported_file_without_location",
    };
  }
  const anchorLine = diagnosticLine
    ?? lineForOffset(offsets, diagnosticFrom ?? 0);
  let startLine = Math.max(1, anchorLine - 5);
  let endLine = Math.min(offsets.length, anchorLine + 3);
  if (endLine - startLine + 1 > 40) endLine = startLine + 39;
  let startOffset = offsets[startLine - 1] ?? 0;
  let endOffset = endLine < offsets.length ? offsets[endLine] ?? file.content.length : file.content.length;
  if (endOffset - startOffset > 8_000) {
    endOffset = startOffset + 8_000;
    endLine = lineForOffset(offsets, endOffset);
  }
  if (diagnosticFrom !== undefined && diagnosticFrom < startOffset) {
    startOffset = diagnosticFrom;
    startLine = lineForOffset(offsets, startOffset);
  }
  if (diagnosticTo !== undefined && diagnosticTo > endOffset) {
    endOffset = Math.min(file.content.length, diagnosticTo);
    endLine = lineForOffset(offsets, endOffset);
  }
  const content = file.content.slice(startOffset, endOffset);
  return {
    regionId: stableId("region", `${file.fileId}:${startOffset}:${endOffset}:${sha256(content)}`),
    fileId: file.fileId,
    startOffset,
    endOffset,
    startLine,
    endLine,
    contentHash: sha256(content),
    content,
    reason: anchorLine > 1 ? "upstream_statement" : "reported_area",
  };
}

function buildEditableFileRegion(file: RepairCandidateFile): RepairRegion {
  const offsets = lineOffsets(file.content);
  return {
    regionId: stableId("region", `${file.fileId}:0:${file.content.length}:${sha256(file.content)}`),
    fileId: file.fileId,
    startOffset: 0,
    endOffset: file.content.length,
    startLine: 1,
    endLine: offsets.length,
    contentHash: sha256(file.content),
    content: file.content,
    reason: "editable_file",
  };
}

function validationProgressScore(
  output: unknown,
  targetCluster?: DiagnosticCluster,
  courseRulesRequired = true,
): number[] {
  const parsed = validationOutputSchema.safeParse(output);
  if (!parsed.success) return [0, 0, 0, 0, -1_000_000];
  const result = parsed.data;
  const syntaxPassed = Number(result.official.syntax === "passed");
  const semanticPassed = Number(result.official.semantic === "passed");
  const coursePassed = Number(
    !courseRulesRequired
    || result.courseRuleApplicability !== "applicable"
    || result.courseRules?.status === "passed",
  );
  const diagnostics = activeErrorDiagnostics(result, courseRulesRequired);
  void targetCluster;
  return [
    Number(result.completeness === "complete"),
    syntaxPassed,
    semanticPassed,
    coursePassed,
    -diagnostics.length,
  ];
}

function activeErrorDiagnostics(
  result: z.infer<typeof validationOutputSchema>,
  courseRulesRequired = true,
) {
  if (result.official.syntax !== "passed" || result.official.semantic !== "passed") {
    return result.official.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  }
  return courseRulesRequired
    ? (result.courseRules?.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error")
    : [];
}

function failedLayer(result: z.infer<typeof validationOutputSchema>): DiagnosticCluster["layer"] | undefined {
  if (result.official.syntax === "failed") return "official_syntax";
  if (result.official.semantic === "failed") return "official_semantic";
  if (result.courseRuleApplicability === "applicable" && result.courseRules?.status === "failed") {
    return "course_rule";
  }
  return undefined;
}

function validationPassed(output: unknown, courseRulesRequired = true): boolean {
  const parsed = validationOutputSchema.safeParse(output);
  if (!parsed.success || parsed.data.completeness !== "complete") return false;
  const officialPassed = parsed.data.official.syntax === "passed"
    && parsed.data.official.semantic === "passed";
  const coursePassed = !courseRulesRequired
    || parsed.data.courseRuleApplicability !== "applicable"
    || parsed.data.courseRules?.status === "passed";
  return officialPassed && coursePassed;
}

function compareDiagnosticLocation(
  left: { line?: number; column?: number; from?: number },
  right: { line?: number; column?: number; from?: number },
): number {
  return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
    || (left.from ?? Number.MAX_SAFE_INTEGER) - (right.from ?? Number.MAX_SAFE_INTEGER);
}

function compactAnchor(diagnostic: {
  from?: number;
  to?: number;
  line?: number;
  column?: number;
}): DiagnosticCluster["reportedAnchor"] {
  return {
    ...(diagnostic.from !== undefined ? { from: diagnostic.from } : {}),
    ...(diagnostic.to !== undefined ? { to: diagnostic.to } : {}),
    ...(diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
    ...(diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
  };
}

function diagnosticFingerprint(diagnostic: { code?: string; message: string; fileId?: string }): string {
  return sha256(`${diagnostic.fileId ?? "unknown"}\n${diagnostic.code ?? "validator"}\n${diagnostic.message}`);
}

function mutationsConflict(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  if (left.start === left.end && right.start === right.end) return left.start === right.start;
  return left.start < right.end && right.start < left.end
    || left.start === right.start
    || left.end === right.end;
}

function exactMatches(content: string, expectedText: string): number[] {
  const matches: number[] = [];
  let offset = 0;
  while (offset <= content.length - expectedText.length) {
    const found = content.indexOf(expectedText, offset);
    if (found < 0) break;
    matches.push(found);
    offset = found + Math.max(1, expectedText.length);
  }
  return matches;
}

function preservesChangeAuthorization(
  snapshot: RepairCandidateSnapshot,
  authorization: RepairChangeAuthorization,
): boolean {
  const baselineFiles = new Map(
    authorization.baselineSnapshot.files.map((file) => [file.fileId, file]),
  );
  if (snapshot.files.length !== baselineFiles.size) return false;
  const rangesByFile = new Map<string, RepairChangeAuthorization["ranges"]>();
  for (const range of authorization.ranges) {
    if (!Number.isInteger(range.startOffset)
      || !Number.isInteger(range.endOffset)
      || range.startOffset < 0
      || range.endOffset < range.startOffset) return false;
    const values = rangesByFile.get(range.fileId) ?? [];
    values.push(range);
    rangesByFile.set(range.fileId, values);
  }
  for (const file of snapshot.files) {
    const baseline = baselineFiles.get(file.fileId);
    if (!baseline) return false;
    const ranges = rangesByFile.get(file.fileId) ?? [];
    if (ranges.length === 0) {
      if (file.content !== baseline.content) return false;
      continue;
    }
    // The current HostContext contract exposes at most one active selection.
    // Keeping one bounded range makes the outside-byte invariant provable even
    // when an earlier Patch changed the selected text length.
    if (ranges.length !== 1) return false;
    const range = ranges[0];
    if (!range || range.endOffset > baseline.content.length) return false;
    const prefix = baseline.content.slice(0, range.startOffset);
    const suffix = baseline.content.slice(range.endOffset);
    if (!file.content.startsWith(prefix) || !file.content.endsWith(suffix)) return false;
    if (file.content.length < prefix.length + suffix.length) return false;
  }
  return true;
}

function anchorRejectionDetail(
  fileContent: string,
  regionStartOffset: number,
  expectedText: string,
  regionMatches: readonly number[],
): RepairAnchorRejectionDetail {
  const offsets = lineOffsets(fileContent);
  return {
    expectedText,
    matchCount: regionMatches.length,
    matches: regionMatches.slice(0, 8).map((regionOffset) => {
      const offset = regionStartOffset + regionOffset;
      const line = lineForOffset(offsets, offset);
      const lineStart = offsets[line - 1] ?? 0;
      const lineEnd = fileContent.indexOf("\n", lineStart);
      return {
        offset,
        line,
        column: offset - lineStart + 1,
        context: fileContent.slice(lineStart, lineEnd < 0 ? fileContent.length : lineEnd).slice(0, 500),
      };
    }),
  };
}

function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function lineForOffset(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, high + 1);
}

function boundedInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
