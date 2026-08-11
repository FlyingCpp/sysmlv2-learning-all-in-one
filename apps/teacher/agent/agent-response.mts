import {
  TOOL_SCHEMA_VERSION,
  reviewedKnowledgeOutputSchema,
  skillGuidanceOutputSchema,
  validationOutputSchema,
  type ToolLedgerEntry,
  type EditorGrounding,
  type TrustedEvidence,
  type TrustedTeacherResponse,
  type TrustedValidatorStatus,
  type ValidationOutput,
} from "./types.mjs";

export interface ModelRunFacts {
  modelText: string;
  workflowVersion?: TrustedTeacherResponse["workflowVersion"];
  answerMode?: TrustedTeacherResponse["answerMode"];
  finishReason: string;
  stepCount: number;
  invalidToolCallCount: number;
  stopReason: TrustedTeacherResponse["stopReason"];
  stopCause?: TrustedTeacherResponse["stopCause"];
  usage: TrustedTeacherResponse["usage"];
  warnings?: string[];
}

export interface EvidenceCitationVisibility {
  skillSourceIds: ReadonlySet<string>;
  knowledgeCardIds: ReadonlySet<string>;
  graphClaimIds: ReadonlySet<string>;
  graphEvidenceIds: ReadonlySet<string>;
}

export interface TrustedResponseOptions {
  grounding?: EditorGrounding;
  courseRulesRequired?: boolean;
  evidenceCitationVisibility?: EvidenceCitationVisibility;
  suppressGroundingDisclosure?: boolean;
  stripInternalProcessNarration?: boolean;
}

export function stripInternalSourceMarkers(value: string): string {
  return value
    .replace(/\s*\[source:[^\]\r\n]{1,320}\]/giu, "")
    .replace(/\s*\*{0,2}[\[【][^\]】\r\n]{0,320}(?:claim-|ev-)[^\]】\r\n]{0,320}[\]】]\*{0,2}/giu, "");
}

const INTERNAL_PROCESS_PREAMBLE_PATTERNS = Object.freeze([
  /^证据(?:已经|已)?(?:充分|足够|齐备)[，,。！!\s]*(?:现在)?(?:可以)?(?:直接)?回答/iu,
  /^(?:当前模型[^\n]{0,240}(?:没有需要分析|无需分析)[^\n]{0,240}(?:不过|但是|但)[，,\s]*)?(?:知识检索|检索结果)[^\n]{0,360}(?:我可以|可以|下面|现在)(?:直接)?回答/iu,
  /^(?:现在)?我(?:已经|已)(?:有了|获得|读取|查看)[^\n]{0,360}(?:草稿|证据|知识)[^\n]{0,240}(?:让我|下面|现在)(?:直接)?(?:基于[^\n]{0,120})?回答/iu,
  /^正在(?:组织回答|检索|调用)[^\n]{0,360}(?:回答|结果|证据)/iu,
  /^(?:retrieval|evidence) (?:is |was )?(?:sufficient|ready)[^\n]{0,240}(?:answer|respond)/iu,
  /^I (?:now )?have (?:the )?(?:model|evidence)[^\n]{0,240}(?:answer|respond)/iu,
]);

function isInternalProcessPreamble(block: string): boolean {
  return INTERNAL_PROCESS_PREAMBLE_PATTERNS.some((pattern) => pattern.test(block));
}

/**
 * 只删除答案开头独立成段的内部过程旁白；正文中讨论证据或模型的实质内容不改写。
 * 该投影不判断SysML语义，也不把文本模式升级为业务通过硬门。
 */
export function stripInternalProcessPreamble(value: string): string {
  const blocks = String(value || "").replace(/\r\n?/gu, "\n").trim().split(/\n{2,}/u);
  let removed = false;
  while (blocks.length > 0) {
    const block = String(blocks[0] || "").trim();
    if (removed && /^-{3,}$/u.test(block)) {
      blocks.shift();
      continue;
    }
    if (block.length <= 1_200 && isInternalProcessPreamble(block)) {
      blocks.shift();
      removed = true;
      continue;
    }
    break;
  }
  return blocks.join("\n\n").trim();
}

const INTERNAL_ORCHESTRATION_PATTERNS = Object.freeze([
  /(?:DSML[^\n]{0,120}(?:tool_calls|invoke|parameter)|record_task_understanding)/iu,
  /工具\s*调用\s*参数/iu,
  /(?:工具\s*调用\s*(?:的\s*)?参数|参数[^\n]{0,100}工具\s*调用)/iu,
  /(?:Tool(?:[-\s]+)calls?(?:['’]s)?[-\s]+(?:arguments?|args?|parameters?)|(?:arguments?|args?|parameters?)[^\n]{0,100}Tool(?:[-\s]+)calls?)/iu,
  /(?:Internal[-_\s]*Ledger)[\s\S]{0,300}(?:Tool(?:[-_\s]+)calls?|arguments?|args?|hash(?:es)?)/iu,
  /(?:Tool(?:[-_\s]+)calls?|arguments?|args?|hash(?:es)?)[\s\S]{0,300}(?:Internal[-_\s]*Ledger)/iu,
  /\bruntimeAssignment(?:Id)?\b/u,
  /\b(?:inspect_current_model|search_reviewed_knowledge|search_skill_guidance|resolve_scope_hints)\b/iu,
  /Fast[-_\s]*Gate[\s\S]{0,220}Reviewed[-_\s]*Knowledge/iu,
  /本(?:次)?对话路径/iu,
  /(?:其他|内部|当前)\s*Workers?\s*路径/iu,
  /本(?:次)?\s*Run[^\n]{0,140}(?:伪装执行|内部|Worker|路径|只能解释|不具备(?:生成|修复|写入|验证)|没有生成候选)/iu,
  /\b(?:argsHash|requestPlanHash|promptHash|toolTrace)\b/iu,
  /\bworkflowVersion\s*[:=]/iu,
]);
const CAPABILITY_BOUNDARY_NARRATION = /(?:无法|不能|不具备|没有|仅|只)[^\n]{0,200}(?:生成|修复|改写|写入|替换|验证|Validator|候选)/su;
const SAFE_CAPABILITY_BOUNDARY_ANSWER = "我这次只能解释，不能替你生成、改写或验证模型；本次没有生成候选、替换文件或执行 Validator，因此不能声称 Validator 已通过。";
const SAFE_INTERNAL_NARRATION_FALLBACK = "当前回答混入了不能向学生展示的内部处理信息，因此没有作为正式说明返回。";

const INTERNAL_ORCHESTRATION_SIGNAL_GROUPS = Object.freeze([
  Object.freeze([
    /runtime[-_\s]*assignment/iu,
    /\b(?:provider|agent)\b/iu,
    /\b(?:selected|assigned)\b/iu,
    /\b(?:request|run)\b/iu,
  ]),
  Object.freeze([
    /(?:Tool(?:[-\s]+)calls?|工具\s*调用)/iu,
    /(?:complete(?:d)?|return(?:s|ed)?|succeed(?:s|ed)?|fail(?:s|ed)?|ready|完成|返回|成功|失败|已就绪)/iu,
    /(?:current\s+model|this\s+request|\banswer\b|internal\s+error|当前模型|本次请求|回答|内部错误)/iu,
  ]),
  Object.freeze([
    /(?:Candidate|Repair|Validator[-_\s]*Repair|Research)[-_\s]*Worker/iu,
    /(?:\b(?:this|the|current)\s+(?:request|run|answer)\b|本次(?:请求|运行|回答))/iu,
  ]),
  Object.freeze([
    /(?:Skills?[^\n]{0,100}(?:search|retriev|检索)|Reviewed[-_\s]*Knowledge)/iu,
    /(?:\b(?:this|the|current)\s+(?:request|run|answer)\b|本次(?:请求|运行|回答)|下面(?:直接)?回答|开始回答)/iu,
  ]),
  Object.freeze([
    /(?:Tools?|Workers?|Skills?)[^\n]{0,160}(?:evidence\s+(?:is\s+)?sufficient|证据(?:已经|已)?充分)/iu,
    /(?:\b(?:this|the|current)\s+(?:request|run|answer)\b|本次(?:请求|运行|回答)|下面(?:直接)?回答|开始回答)/iu,
  ]),
  Object.freeze([
    /内部(?:编排|路由|处理路径)/iu,
    /(?:本次|当前)(?:请求|回答|运行)|(?:Agent|Worker|Tool)[-_\s]*(?:请求|回答|路径|路由|handoff)|模型服务/iu,
  ]),
  Object.freeze([
    /(?:知识|证据)检索/iu,
    /(?:本次|当前)(?:请求|回答|运行)|下面(?:直接)?回答|开始回答|我(?:可以|将|来)(?:直接)?回答/iu,
  ]),
]);

const INTERNAL_ORCHESTRATION_ADJACENT_SIGNAL_GROUPS = Object.freeze([
  Object.freeze([
    /(?:\b(?:this|the|current)\s+(?:request|answer)\b[^.!?。！？]{0,100}\b(?:ready|complete(?:d)?|succeed(?:s|ed)?|fail(?:s|ed)?)\b|(?:本次|当前)(?:请求|回答)[^.!?。！？]{0,100}(?:就绪|完成|成功|失败))/iu,
    /(?:\bTool(?:[-\s]+)calls?\b[^.!?。！？]{0,160}\b(?:complete(?:d)?|return(?:s|ed)?|succeed(?:s|ed)?|fail(?:s|ed)?|ready)\b|工具\s*调用[^.!?。！？]{0,120}(?:已经|已)?(?:完成|返回|成功|失败|就绪))/iu,
  ]),
]);

function hasBoundedSignalGroup(
  value: string,
  signals: readonly RegExp[],
  radius = 260,
): boolean {
  const [anchor, ...rest] = signals;
  if (!anchor) return false;
  const flags = anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`;
  for (const match of value.matchAll(new RegExp(anchor.source, flags))) {
    const index = match.index ?? 0;
    const window = value.slice(
      Math.max(0, index - radius),
      Math.min(value.length, index + match[0].length + radius),
    );
    if (rest.every((signal) => signal.test(window))) return true;
  }
  return false;
}

/**
 * 检测学生正文中的高置信内部编排叙述。规则使用短语与上下文组合，
 * 不把run、tool、claim等普通工程词单独列为禁词；任何Markdown格式都必须扫描。
 * 命中后整体降级为确定性学生说明，避免散点替换损坏技术正文。
 */
export function sanitizeInternalOrchestrationNarration(value: string): string {
  const text = String(value || "");
  const scanText = text.replace(/\s+/gu, " ");
  const hasStaticPattern = INTERNAL_ORCHESTRATION_PATTERNS.some((pattern) => pattern.test(scanText));
  const scanParagraphs = text
    .split(/\r?\n[\t ]*\r?\n/u)
    .map((paragraph) => paragraph
      .split(/(?<=[。！？])(?:["'”’）)\]}*_`~]{0,8})?|(?<=[.!?])(?:["'”’）)\]}*_`~]{0,8})?\s+/u)
      .map((segment) => segment.replace(/\s+/gu, " ").trim())
      .filter(Boolean))
    .filter((segments) => segments.length > 0);
  const scanSegments = scanParagraphs.flat();
  const hasContextualPattern = scanSegments.some((segment) => (
    INTERNAL_ORCHESTRATION_SIGNAL_GROUPS.some((signals) => (
      hasBoundedSignalGroup(segment, signals)
    ))
  ));
  const hasAdjacentContextualPattern = scanParagraphs.some((segments) => (
    segments.some((segment, index) => {
      const next = segments[index + 1];
      if (!next) return false;
      const adjacent = `${segment} ${next}`;
      return INTERNAL_ORCHESTRATION_ADJACENT_SIGNAL_GROUPS.some((signals) => (
        hasBoundedSignalGroup(adjacent, signals, 520)
      ));
    })
  ));
  if (!hasStaticPattern && !hasContextualPattern && !hasAdjacentContextualPattern) return text;
  return CAPABILITY_BOUNDARY_NARRATION.test(scanText)
    ? SAFE_CAPABILITY_BOUNDARY_ANSWER
    : SAFE_INTERNAL_NARRATION_FALLBACK;
}

function terminalValidation(entries: readonly ToolLedgerEntry[]): ValidationOutput | undefined {
  const attempts = entries.filter((entry) => entry.toolName === "validate_candidate_workspace");
  const terminal = attempts.at(-1);
  if (!terminal || terminal.status !== "succeeded") {
    return undefined;
  }
  const parsed = validationOutputSchema.safeParse(terminal.output);
  return parsed.success ? parsed.data : undefined;
}

function deriveValidatorStatus(
  validation: ValidationOutput | undefined,
  courseRulesRequired = true,
): TrustedValidatorStatus {
  if (!validation) {
    return "not_validated";
  }
  const officialFailed =
    validation.official.syntax === "failed" || validation.official.semantic === "failed";
  const courseFailed = courseRulesRequired && validation.courseRules?.status === "failed";
  if (officialFailed || courseFailed) {
    return "validated_failed";
  }
  const officialPassed =
    validation.official.syntax === "passed" && validation.official.semantic === "passed";
  const coursePassed = !courseRulesRequired
    || validation.courseRuleApplicability === "not_applicable"
    || (validation.courseRuleApplicability === "applicable"
      && validation.courseRules?.status === "passed");
  return officialPassed &&
    coursePassed &&
    validation.completeness === "complete" &&
    Boolean(validation.candidateWorkspaceHash)
    ? "validated_passed"
    : "not_validated";
}

function collectEvidence(
  entries: readonly ToolLedgerEntry[],
  validation: ValidationOutput | undefined,
  modelText: string,
  visibility?: EvidenceCitationVisibility,
): {
  evidence: TrustedEvidence[];
  recoveredFromSingleTrustedTool: boolean;
  referenceBudgetExceeded: boolean;
} {
  const evidence: TrustedEvidence[] = [];
  // 仅保留历史上的单一 Skill 来源恢复。Knowledge Claim/Evidence 必须由模型
  // 显式引用，并由服务端在本次 Run 的成功 Tool Ledger 中解析与绑定。
  const recoverableSkillCandidates: TrustedEvidence[] = [];
  const citedSourceIds = new Set(
    [...modelText.matchAll(/\[source:([a-zA-Z0-9._:-]{1,160})\]/gu)].map((match) => match[1]),
  );
  const hasAnySourceMarker = /\[source\s*:/iu.test(modelText);
  for (const entry of entries) {
    if (entry.status !== "succeeded") {
      continue;
    }
    if (entry.toolName === "search_skill_guidance") {
      const parsed = skillGuidanceOutputSchema.safeParse(entry.output);
      if (parsed.success) {
        for (const item of parsed.data.items.filter((candidate) =>
          citedSourceIds.has(candidate.sourceId)
          && (!visibility || visibility.skillSourceIds.has(candidate.sourceId)))) {
          evidence.push({
            sourceType: "skill",
            sourceId: item.sourceId,
            authority: item.authority,
            version: item.version,
            contentHash: item.contentHash,
          });
        }
        for (const item of parsed.data.items.filter((candidate) =>
          !visibility || visibility.skillSourceIds.has(candidate.sourceId))) {
          recoverableSkillCandidates.push({
            sourceType: "skill",
            sourceId: item.sourceId,
            authority: item.authority,
            version: item.version,
            contentHash: item.contentHash,
          });
        }
      }
    }
    if (entry.toolName === "search_reviewed_knowledge") {
      const parsed = reviewedKnowledgeOutputSchema.safeParse(entry.output);
      if (parsed.success) {
        for (const item of parsed.data.items.filter((candidate) =>
          citedSourceIds.has(candidate.cardId)
          && (!visibility || visibility.knowledgeCardIds.has(candidate.cardId)))) {
          evidence.push({
            sourceType: "knowledge",
            sourceId: item.cardId,
            authority: item.evidenceLevel,
            version: item.version,
            contentHash: item.contentHash,
          });
        }

        const graphEvidenceById = new Map(
          parsed.data.evidenceBlocks.map((item) => [item.evidenceId, item]),
        );
        const citedGraphEvidenceIds = new Set<string>();
        for (const item of parsed.data.evidenceBlocks) {
          if (citedSourceIds.has(item.evidenceId)
            && (!visibility || visibility.graphEvidenceIds.has(item.evidenceId))) {
            citedGraphEvidenceIds.add(item.evidenceId);
          }
        }
        for (const claim of parsed.data.claims) {
          if (!citedSourceIds.has(claim.claimId)
            || (visibility && !visibility.graphClaimIds.has(claim.claimId))) continue;
          for (const evidenceId of claim.evidenceIds) {
            if (graphEvidenceById.has(evidenceId)
              && (!visibility || visibility.graphEvidenceIds.has(evidenceId))) {
              citedGraphEvidenceIds.add(evidenceId);
            }
          }
        }
        for (const evidenceId of citedGraphEvidenceIds) {
          const item = graphEvidenceById.get(evidenceId);
          if (!item) continue;
          // evidenceId 与 claimId 是 graph 的可引用标识；公共可信引用统一落到
          // 本轮模型实际可见的规范 Evidence ID。
          evidence.push({
            sourceType: "knowledge",
            sourceId: item.evidenceId,
            authority: item.authorityLevel === "A1" ? "official" : "reviewed_project",
            version: parsed.data.bundleVersion ?? "unversioned",
            contentHash: item.textHash,
          });
        }
      }
    }
  }
  const uniqueCandidates = uniqueEvidence(recoverableSkillCandidates);
  const recoveredCandidate = !hasAnySourceMarker && uniqueCandidates.length === 1
    ? uniqueCandidates[0]
    : undefined;
  const recoveredFromSingleTrustedTool = recoveredCandidate !== undefined;
  if (recoveredCandidate) {
    evidence.push(recoveredCandidate);
  }
  if (validation) {
    evidence.push({
      sourceType: "validator",
      sourceId: "official-sysml-v2-validator",
      authority: validation.validator.authority,
      version: validation.validator.version,
      contentHash: validation.validator.evidenceHash,
    });
  }
  const unique = uniqueEvidence(evidence);
  const prioritized = [
    ...unique.filter((item) => item.sourceType === "validator"),
    ...unique.filter((item) => item.sourceType !== "validator"),
  ];
  return {
    evidence: prioritized.slice(0, 64),
    recoveredFromSingleTrustedTool,
    referenceBudgetExceeded: prioritized.length > 64,
  };
}

function uniqueEvidence(items: readonly TrustedEvidence[]): TrustedEvidence[] {
  const unique = new Map<string, TrustedEvidence>();
  for (const item of items) {
    unique.set(`${item.sourceType}:${item.sourceId}:${item.contentHash}`, item);
  }
  return [...unique.values()];
}

function fallbackAnswer(stopReason: TrustedTeacherResponse["stopReason"]): string {
  switch (stopReason) {
    case "step_limit":
      return "已达到 Agent 步骤上限，当前结果不能视为完成或已验证。";
    case "cancelled":
      return "本次回答已取消，未产生可采信的最终结论。";
    case "timeout":
      return "本次回答超时，未产生可采信的最终结论。";
    case "hard_timeout":
      return "本次运行已到达硬截止时间；已停止模型与工具调用，当前仅返回可确认的最小终态。";
    case "repair_step_timeout":
      return "修复模型本轮未能在单步时限内提交候选，当前工作区保持不变。";
    case "validator_queue_full":
      return "Validator 当前并发繁忙，候选未获得验证结论；已保留本轮工作进度，不能声称验证通过。";
    case "validator_queue_timeout":
      return "候选在 Validator 队列中等待超时，未获得验证结论；已保留本轮工作进度，不能声称验证通过。";
    case "validator_execution_timeout":
      return "Validator 执行超时，候选未获得验证结论；已保留本轮工作进度，不能声称验证通过。";
    case "validator_unavailable":
      return "Validator 当前不可用，候选未获得验证结论；已保留本轮工作进度，不能声称验证通过。";
    case "provider_error":
      return "模型服务调用失败，未产生可采信的最终结论。";
    case "policy_violation":
      return "Agent 未完成服务端要求的可信上下文、证据或候选验证步骤，当前回答不可采信。";
    case "completed":
      throw new Error("Completed AI Teacher response requires non-empty model text");
  }
}

function discloseGroundingScope(
  answer: string,
  grounding: EditorGrounding | undefined,
  stopReason: TrustedTeacherResponse["stopReason"],
): { answer: string; disclosed: boolean } {
  if (!grounding || stopReason !== "completed" || grounding.kind === "selection" || grounding.kind === "code_cursor") {
    return { answer, disclosed: false };
  }
  if (/(?:根据你的描述|从当前草稿整体来看|based on your description)/iu.test(answer)) {
    return { answer, disclosed: false };
  }
  const disclosure = grounding.kind === "none" && grounding.reason === "no_focus"
    ? "根据你的描述，当前没有可信代码选区、当前代码光标或活动文件；以下回答不把任何代码位置视为当前目标。"
    : "根据你的描述和当前草稿整体来看，以下回答不把先前代码光标或选区视为当前目标。";
  return { answer: `${disclosure}\n\n${answer}`, disclosed: true };
}

const OFFICIAL_VALIDATION_SCOPE_NOTICE = "服务端验证状态：仅终末候选工作区已在官方 SysML v2 Validator 中通过语法/语义检查；这不证明原始草稿、自然语言概念结论、数值结果或工程系统已经验证。";

export function assembleTrustedResponse(
  facts: ModelRunFacts,
  ledger: readonly ToolLedgerEntry[],
  options: TrustedResponseOptions = {},
): TrustedTeacherResponse {
  const validation = terminalValidation(ledger);
  const validatorStatus = deriveValidatorStatus(
    validation,
    options.courseRulesRequired ?? true,
  );
  const modelText = facts.modelText.trim() || fallbackAnswer(facts.stopReason);
  const markerFreeAnswer = stripInternalSourceMarkers(modelText);
  const preambleFreeAnswer = options.stripInternalProcessNarration
    ? stripInternalProcessPreamble(markerFreeAnswer)
    : markerFreeAnswer;
  const narrationFreeAnswer = options.stripInternalProcessNarration
    ? sanitizeInternalOrchestrationNarration(preambleFreeAnswer)
    : preambleFreeAnswer;
  const processPreambleRemoved = preambleFreeAnswer !== markerFreeAnswer;
  const orchestrationNarrationNeutralized = narrationFreeAnswer !== preambleFreeAnswer;
  const grounded = options.suppressGroundingDisclosure
    ? { answer: narrationFreeAnswer, disclosed: false }
    : discloseGroundingScope(narrationFreeAnswer, options.grounding, facts.stopReason);
  const visibleAnswer = validatorStatus === "validated_passed" && facts.stopReason === "completed"
    ? `${grounded.answer}\n\n${OFFICIAL_VALIDATION_SCOPE_NOTICE}`
    : grounded.answer;
  const collectedEvidence = collectEvidence(
    ledger,
    validation,
    modelText,
    options.evidenceCitationVisibility,
  );
  const evidence = collectedEvidence.evidence;
  const warnings = new Set(facts.warnings ?? []);
  if (collectedEvidence.recoveredFromSingleTrustedTool) {
    warnings.add("source_marker_recovered_from_single_trusted_tool");
  }
  if (collectedEvidence.referenceBudgetExceeded) {
    warnings.add("source_reference_budget_exceeded");
  }
  if (facts.invalidToolCallCount > 0) {
    warnings.add("invalid_tool_arguments_rejected");
  }
  if (ledger.some((entry) => entry.status === "failed")) {
    warnings.add("tool_execution_failed");
  }
  const validationAttempts = ledger.filter(
    (entry) => entry.toolName === "validate_candidate_workspace",
  );
  if (validationAttempts.length > 0 && !validation) {
    warnings.add("terminal_validation_attempt_unusable");
  }
  if (grounded.disclosed) {
    warnings.add("grounding_scope_disclosed");
  }
  if (processPreambleRemoved) {
    warnings.add("internal_process_preamble_removed");
  }
  if (orchestrationNarrationNeutralized) {
    warnings.add("internal_orchestration_narration_suppressed");
  }
  if (facts.stopReason !== "completed") {
    warnings.add(`agent_stopped:${facts.stopReason}`);
  }
  if (validatorStatus === "not_validated" && validation) {
    warnings.add("validation_incomplete_or_unavailable");
  }

  const patches =
    validatorStatus === "validated_passed" && validation
      ? validation.patches.map((patch) => ({ ...patch, applicable: true }))
      : [];
  const confidenceCap =
    facts.stopReason !== "completed"
      ? "low"
      : validatorStatus === "validated_passed"
        ? "high"
        : evidence.length > 0
          ? "medium"
          : "low";

  return {
    answer: visibleAnswer,
    answerMode: "result_bound_v2",
    runtimeUsed: "ai-sdk",
    workflowVersion: "intent-orchestrator-v2",
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    validatorStatus,
    validation,
    evidence,
    patches,
    candidateWorkspaceHash:
      validatorStatus === "validated_passed" ? validation?.candidateWorkspaceHash : undefined,
    toolTrace: ledger.map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      argsHash: entry.argsHash,
      status: entry.status,
      replayCount: entry.replayCount,
    })),
    usage: facts.usage,
    stepCount: facts.stepCount,
    stopReason: facts.stopReason,
    ...(facts.stopCause ? { stopCause: facts.stopCause } : {}),
    confidenceCap,
    warnings: [...warnings],
  };
}
