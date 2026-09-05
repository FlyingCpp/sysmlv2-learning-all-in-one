'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 24;
const CONTEXT_TOKEN_BYTE_ESTIMATE = 4;
const STUDENT_QUESTION_PROTOCOL_CEILING = 20000;

const GROUPS = Object.freeze([
  group('run', 'Run 与恢复', '单 Run 总资源、终态预留和有界恢复。'),
  group('stage', '阶段模型与输出', 'Main、Candidate、Repair 和 Finalizer 的模型与输出策略。'),
  group('tool', 'Tool 与上下文', '只读 Tool 共享预算和对话上下文窗口。'),
  group('knowledge', '知识与领域证据', '已审核知识和工程领域证据的查询预算。'),
  group('candidate', 'Candidate 与 Repair', 'Candidate 尝试、Artifact、Repair 进展和唯一验证候选。'),
  group('validator', 'Validator', 'Official Validator 的容量、排队和执行停滞保护。'),
  group('provider', 'Run Admission', 'Teacher侧只保留整轮Run的Provider并发准入；重试、熔断和请求超时由LiteLLM Provider Owner管理。'),
  group('probe', '健康探测', '后台健康探测频率与超时。'),
  group('scope', 'Scope Gate', '快速范围判读的模型与停滞保护。'),
  group('semanticReview', '工程语义软 Review', '只读软评议；失败不阻断已验证交付。')
]);

const DEFINITIONS = Object.freeze([
  integer('run.maxDurationMs', 'run', 'Run 最长执行时间', 600000, 120000, 1200000, 'ms', 'high', 'new_run', 'teacher', '单 Run 最终 hard deadline。'),
  integer('run.finalizationReserveMs', 'run', '终态阶段预留', 60000, 5000, 120000, 'ms', 'high', 'new_run', 'Finalizer、Artifact 绑定和持久化不可被探索阶段借用；缺少安全公开兜底的Finalizer可在Run hard deadline内有界借用一次同等时长。'),
  integer('run.maxAutoContinuationsPerLineage', 'run', '自动续跑上限', 1, 0, 1, 'runs', 'high', 'new_run', '0关闭自动续跑，1允许当前架构支持的唯一自动子Run；多子Run需要lineage架构变更，不能伪装成运行参数。'),

  modelRef('stage.main.modelRoute', 'stage', 'Main 模型', 'ai-teacher-fast', 'Main 意图理解、只读 Tool 与普通回答。'),
  enumDefinition('stage.main.reasoningPolicy', 'stage', 'Main 推理策略', 'disabled', ['disabled', 'provider-managed'], 'high', 'new_run', 'teacher', '默认关闭推理，避免可见正文被 reasoning 吞尽。'),
  integer('stage.temperaturePermille', 'stage', '生成温度', 0, 0, 2000, '‰', 'medium', 'new_run', 'temperature 乘以 1000 后的管理值；0 表示确定性优先。'),
  modelRef('stage.candidate.modelRoute', 'stage', 'Candidate 模型', 'ai-teacher-reasoning', '完整 Candidate 生成。'),
  modelRef('stage.repair.modelRoute', 'stage', 'Repair 模型', 'ai-teacher-reasoning', 'Official Validator FAIL 后的 Repair。'),
  modelRef('stage.finalizer.modelRoute', 'stage', 'Finalizer 模型', 'ai-teacher-fast', '将可信 Artifact 整理为学生可见回答。'),
  enumDefinition('stage.finalizer.reasoningPolicy', 'stage', 'Finalizer 推理策略', 'disabled', ['disabled', 'provider-managed'], 'high', 'new_run', 'teacher', '默认非思考；如 Provider 能稳定返回可见正文，可由管理员切换。'),

  integer('tool.maxCallsPerRun', 'tool', '只读 Tool 共享调用上限', 12, 1, 100, 'calls', 'high', 'new_run', '所有只读 Tool 共用，不再设置逐 Tool 次数门。'),
  integer('tool.maxRetriesPerOperation', 'tool', '单语义 Tool 操作失败重试', 2, 0, 2, 'retries', 'medium', 'new_run', '同一规范化语义操作首次失败后最多重试次数；不同 Tool 和不同操作不共享失败计数，不关闭回答、澄清或终态动作。'),
  integer('tool.defaultTimeoutMs', 'tool', 'Tool 默认超时', 30000, 1000, 120000, 'ms', 'medium', 'new_run', '普通只读 Tool 的单次停滞保护。'),
  integer('context.taskSourceMaxEntries', 'tool', '可信任务来源条目上限', 8, 2, 16, 'entries', 'high', 'new_run', '单次 Agent 执行视图最多包含的可信 TaskSourceSet 条目数；管理页配置值会冻结到 Run Snapshot，后端不得再用固定 8 或 6 二次钳制。'),
  integer('context.studentQuestionMaxChars', 'tool', '学生原文最大字符数', 16000, 4000, STUDENT_QUESTION_PROTOCOL_CEILING, 'chars', 'medium', 'new_run', 'teacher', '当前学生问题的运营上限，冻结到 Run Snapshot。协议天花板是 20000；超限在创建 Thread/Run 前拒绝。完整 SysML 模型应放在编辑器，不占聊天原文额度。'),
  integer('context.mainExecutionReserveTokens', 'tool', 'Main 上下文预留 Token', 4096, 512, 16384, 'tokens', 'medium', 'new_run', 'teacher', 'Main 构造 Execution View 时从模型窗口预留的 Token，避免上下文塞满后主模型无法继续。冻结到 Run Snapshot。'),
  integer('tool.inputMaxBytes', 'tool', '只读 Tool 入参上限', 8192, 1024, 65536, 'bytes', 'high', 'new_run', 'teacher', '只读 Tool 单次入参最大字节数。超限拒绝该次调用，不扩大 Tool 授权。冻结到 Run Snapshot。'),

  integer('domainEvidence.maxQueriesPerRun', 'knowledge', '工程领域问题组上限', 2, 0, 8, 'queries', 'high', 'new_run', '外部工程领域检索问题组 ceiling。'),
  integer('domainEvidence.maxSearchUsesPerQuery', 'knowledge', '单问题搜索使用上限', 2, 1, 8, 'uses', 'medium', 'new_run', 'Provider 单问题搜索使用次数。'),
  integer('domainEvidence.maxProviderStepsPerQuery', 'knowledge', '单问题 Provider 步数', 4, 1, 12, 'steps', 'medium', 'new_run', 'Provider continuation/step ceiling。'),
  integer('domainEvidence.maxOutputTokensPerQuery', 'knowledge', 'Domain Evidence 单问题辅助输出帽', 4800, 512, 16000, 'tokens', 'medium', 'new_run', '限制单个工程领域证据查询返回给模型的辅助输出Token量，用于控制检索成本与延迟；不限制Main、Candidate、Repair或Finalizer的开放式生成。该值属于Domain Evidence Effort Profile，可在管理页配置。'),
  integer('domainEvidence.timeoutMs', 'knowledge', '工程领域检索超时', 60000, 5000, 180000, 'ms', 'medium', 'new_run', '单问题停滞保护。'),

  integer('candidate.maxGenerationAttempts', 'candidate', 'Candidate 生成尝试', 2, 1, 4, 'attempts', 'medium', 'new_run', '初次生成加有界截断恢复。'),
  integer('candidate.maxArtifactBytes', 'candidate', 'Candidate Artifact 上限', 262144, 16384, 2097152, 'bytes', 'high', 'new_run', 'Candidate 存储与输入安全资源边界。'),
  booleanDefinition('repair.enabled', 'candidate', '启用 Repair', true, 'high', 'new_run', 'teacher', 'Validator FAIL 后允许 Repair；关闭不绕过 Validator。'),
  integer('repair.maxRounds', 'candidate', 'Repair 最大有效轮次', 3, 0, 12, 'rounds', 'high', 'new_run', '只有新 Candidate、诊断或证据才构成新轮。'),
  integer('validator.queueLimit', 'validator', 'Validator 队列上限', 8, 0, 64, 'requests', 'medium', 'owner_reload', '等待队列容量。'),
  integer('validator.queueWaitMs', 'validator', 'Validator 排队等待', 30000, 1000, 120000, 'ms', 'medium', 'owner_reload', '进入执行前的停滞保护。'),
  integer('validator.executionTimeoutMs', 'validator', 'Validator 执行超时', 25000, 5000, 120000, 'ms', 'high', 'owner_reload', 'Official Validator 单次执行停滞保护。'),

  integer('provider.maxConcurrentRuns', 'provider', 'Run Admission 最大并发', 2, 1, 16, 'runs', 'high', 'owner_reload', '同时获准进入Provider执行区的完整Agent Run数量；Run内部模型步骤不重复排队。'),
  integer('provider.queueLimit', 'provider', 'Run Admission 等待队列', 20, 0, 200, 'runs', 'medium', 'owner_reload', '尚未获准开始Provider工作的Run等待容量；已准入Run及其内部模型步骤不占队列槽位。'),

  booleanDefinition('probe.enabled', 'probe', '启用后台健康探测', true, 'medium', 'owner_reload', 'teacher', '只控制后台探针，不授予学生联网能力。'),
  integer('probe.hourlyLimit', 'probe', '每小时探针上限', 6, 0, 48, 'calls', 'medium', 'owner_reload', '付费探针小时成本上限。'),
  integer('probe.timeoutMs', 'probe', '探针超时', 30000, 5000, 180000, 'ms', 'medium', 'owner_reload', '单次健康探测停滞保护。'),

  booleanDefinition('scope.enabled', 'scope', '启用 Scope Gate', true, 'high', 'new_run', 'teacher', '关闭只跳过范围判断，不改变授权和安全边界。'),
  modelRef('scope.modelRoute', 'scope', 'Scope Gate 模型', 'ai-teacher-fast', '快速范围判断模型 Alias。'),
  integer('scope.initialTimeoutMs', 'scope', '首次判读超时', 10000, 3000, 60000, 'ms', 'medium', 'new_run', '首次范围判读停滞保护。'),
  integer('scope.reviewTimeoutMs', 'scope', '独立复核超时', 18000, 5000, 120000, 'ms', 'medium', 'new_run', '完全越界时独立复核停滞保护。'),
  integer('scope.maxOutputTokens', 'scope', 'Scope Gate 协议输出帽', 500, 64, 2000, 'tokens', 'low', 'new_run', '限制Scope Gate单次PASS、RISK_MIXED或RISK_FULL协议判读的输出Token量，用于约束协议偏离、成本与延迟；不限制面向用户的正文回答。可在管理页按Provider兼容性配置。'),
  integer('scope.hardInputTokenBudget', 'scope', 'Fast Gate 输入 Token 上限', 4096, 1024, 16384, 'tokens', 'medium', 'new_run', 'teacher', '快速范围判断的输入 Token 上限。超过后本次判读 fail-open 放行，不阻断 Run。冻结到 Run Snapshot。'),


  booleanDefinition('semanticReview.enabled', 'semanticReview', '启用工程语义软 Review', false, 'high', 'new_run', 'teacher', '在首个已验证候选上给出一次只读建议，交由同一个 Main 核心检查处理；失败不重试，不阻断候选交付。'),
  booleanDefinition('semanticReview.shadowOnly', 'semanticReview', '仅运行 Shadow Review', false, 'medium', 'new_run', 'teacher', '仅记录一次只读评议，不向 Main 或 Finalizer 注入意见。'),
  integer('semanticReview.maxCycles', 'semanticReview', '工程评议次数兼容上限', 1, 0, 4, 'cycles', 'high', 'new_run', '兼容旧策略：0 跳过工程评议，正值最多执行一次只读建议；不再执行独立 Revision/Verification 循环。'),
  integer('semanticReview.timeoutMs', 'semanticReview', '工程语义 Review 超时', 120000, 5000, 300000, 'ms', 'high', 'new_run', '一次只读工程建议的超时，不用于复评或候选选择。'),
  modelRef('semanticReview.modelRoute', 'semanticReview', '工程语义 Review 模型', 'ai-teacher-reasoning', '只读工程语义评议模型。')
]);

const HARD_INVARIANTS = Object.freeze([
  invariant('validator.required', true, '生成或修改的 Candidate 必须经过 Official Validator 才能标记为已验证。'),
  invariant('delivery.unvalidatedCodeWithheld', true, '未验证、验证失败或未与终末 Validation Artifact 精确绑定的代码不得作为已验证代码公开。'),
  invariant('delivery.serverOwnedArtifactBinding', true, 'Candidate/Validation Artifact、Hash、权限和最终状态由服务端确定。'),
  invariant('security.resourcePolicyCannotExpandAuthority', true, '资源策略不得扩大 Tool 授权、所有权或 secret 访问。'),
  invariant('run.immutablePolicySnapshot', true, '同一 Run 使用不可变策略版本和校验和。'),
  invariant('evidence.firstFailurePreserved', true, '首次失败证据不得被成功复测覆盖或删除。')
]);

const DEPRECATED_KEYS = Object.freeze({
  'mainReview.modelRoute': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'mainReview.thinkingEnabled': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'mainReview.timeoutMs': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'knowledge.reviewedMaxNewQueriesPerRun': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'knowledge.exampleMaxPerQuery': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'knowledge.exampleViewTokenBudget': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'knowledge.exampleInjectionEnabled': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'run.maxRecoveryAttempts': { replacement: 'candidate.maxGenerationAttempts' },
  'context.windowTokens': { replacement: 'model-capability:contextWindowTokens' },
  'validator.maxUniqueCandidatesPerRun': { replacement: 'derived:initial-candidate+repair.maxRounds' },
  'tool.maxFailuresPerRun': { replacement: 'tool.maxRetriesPerOperation' },
  'stage.main.maxOutputTokens': { replacement: 'removed:open-generation-uses-provider-default-and-run-deadline' },
  'stage.candidate.maxOutputTokens': { replacement: 'removed:complete-candidate-contract-and-provider-capability' },
  'stage.repair.maxOutputTokens': { replacement: 'removed:repair-visible-output-reserve-is-context-only' },
  'stage.finalizer.maxOutputTokens': { replacement: 'removed:open-generation-uses-provider-default-and-deterministic-fallback' },
  'context.historyMaxMessages': { replacement: 'removed:harness-context-compaction' },
  'context.historyMaxTokens': { replacement: 'removed:harness-context-compaction' },
  'validator.maxInFlight': { replacement: 'owner-capability:official-validator-serial-execution' },
  'provider.queueWaitMs': { replacement: 'removed:run-abort-signal' },
  'provider.requestTimeoutMs': { replacement: 'provider-owner:litellm-connection-timeout' },
  'provider.maxRetries': { replacement: 'provider-owner:litellm-num-retries' },
  'provider.retryJitter': { replacement: 'provider-owner:litellm-retry-policy' },
  'provider.retryBaseMs': { replacement: 'provider-owner:litellm-retry-policy' },
  'provider.retryMaxMs': { replacement: 'provider-owner:litellm-retry-policy' },
  'provider.circuitFailureThreshold': { replacement: 'provider-owner:litellm-allowed-fails' },
  'provider.circuitFailureWindowMs': { replacement: 'provider-owner:litellm-health-policy' },
  'provider.circuitOpenMs': { replacement: 'provider-owner:litellm-cooldown' },
  'provider.halfOpenMaxProbes': { replacement: 'provider-owner:litellm-health-policy' },
  'api.outerTimeoutMs': { replacement: 'derived:run.maxDurationMs+transportGraceMs' },
  'run.maxSteps': { replacement: 'derived:allocator.progressState' },
  'run.terminalReserveMs': { replacement: 'run.finalizationReserveMs' },
  'run.convergeLeadMs': { replacement: 'derived:allocator.commitThreshold' },
  'run.toolTimeoutMs': { replacement: 'tool.defaultTimeoutMs' },
  'run.terminalPersistTimeoutMs': { replacement: 'derived:run.finalizationReserveMs' },
  'answer.hardMaxOutputTokens': { replacement: 'removed:open-generation-stage-caps' },
  'answer.contextWindowTokens': { replacement: 'derived:model capability' },
  'answer.lowMaxOutputTokens': { replacement: 'removed:open-generation-stage-caps' },
  'answer.mediumMaxOutputTokens': { replacement: 'removed:open-generation-stage-caps' },
  'answer.highMaxOutputTokens': { replacement: 'removed:open-generation-stage-caps' },
  'tool.inspectLessonContextMaxCallsPerRun': { replacement: 'tool.maxCallsPerRun' },
  'tool.inspectCurrentModelMaxCallsPerRun': { replacement: 'tool.maxCallsPerRun' },
  'tool.skillGuidanceMaxCallsPerRun': { replacement: 'tool.maxCallsPerRun' },
  'tool.reviewedKnowledgeMaxCallsPerRun': { replacement: 'removed:shared-tool-budget-and-single-finalizer' },
  'tool.domainEvidenceMaxCallsPerRun': { replacement: 'domainEvidence.maxQueriesPerRun' },
  'tool.outputMaxBytesPerCall': { replacement: 'removed:harness-context-compaction' },
  'tool.totalOutputMaxBytesPerRun': { replacement: 'removed:harness-context-compaction' },
  'tool.maxVisibleOutputBytesPerRun': { replacement: 'removed:harness-context-compaction' },
  'tool.semanticCompressionReviewedKnowledgeEnabled': { replacement: 'removed:fixed-context-compaction-policy' },
  'tool.semanticCompressionSkillGuidanceEnabled': { replacement: 'removed:fixed-context-compaction-policy' },
  'tool.semanticCompressionDomainEvidenceEnabled': { replacement: 'removed:fixed-context-compaction-policy' },
  'tool.readOnlyTimeoutMs': { replacement: 'tool.defaultTimeoutMs' },
  'tool.domainEvidenceTimeoutMs': { replacement: 'domainEvidence.timeoutMs' },
  'candidate.recoveryMaxAttempts': { replacement: 'candidate.maxGenerationAttempts' },
  'candidate.maxAttemptMs': { replacement: 'derived:allocator.candidateWindowMs' },
  'candidate.repairEnabled': { replacement: 'repair.enabled' },
  'candidate.maxValidatorCallsPerWorker': { replacement: 'derived:initial-candidate+repair.maxRounds' },
  'repair.phaseReserveMs': { replacement: 'derived:allocator.repairWindowMs' },
  'repair.maxOutputTokens': { replacement: 'removed:repair-visible-output-reserve-is-context-only' },
  'repair.materializationMode': { replacement: 'removed:single-stage-repair-tooloop' },
  'repair.decisionMaxOutputTokens': { replacement: 'removed:single-stage-repair-tooloop' },
  'repair.materializationMaxOutputTokens': { replacement: 'removed:single-stage-repair-tooloop' },
  'repair.materializationThinking': { replacement: 'removed:single-stage-repair-tooloop' },
  'semanticReview.assessmentMaxCalls': { replacement: 'semanticReview.maxCycles' },
  'semanticReview.assessmentTimeoutMs': { replacement: 'semanticReview.timeoutMs' },
  'semanticReview.mainDecisionTimeoutMs': { replacement: 'derived:semanticReview.timeoutMs' },
  'semanticReview.verificationMaxCalls': { replacement: 'semanticReview.maxCycles' },
  'semanticReview.verificationTimeoutMs': { replacement: 'semanticReview.timeoutMs' },
  'semanticReview.maxOutputTokens': { replacement: 'removed:provider-default-and-context-admission' },
  'semanticReview.maxIssues': { replacement: 'derived:context envelope' },
  'semanticReview.minimumCompleteChainMs': { replacement: 'derived:allocator.availableWork' },
  'semanticReview.domainSearchReserveMs': { replacement: 'removed' },
  'engineeringRevision.maxCycles': { replacement: 'semanticReview.maxCycles' },
  'engineeringRevision.maxDurationMs': { replacement: 'derived:allocator.candidateWindowMs' },
  'engineeringRevision.validationRepairReserveMs': { replacement: 'derived:allocator.repairWindowMs' },
  'engineeringImprovement.runMaxDurationMs': { replacement: 'run.maxDurationMs' },
  'engineeringImprovement.apiOuterTimeoutMs': { replacement: 'derived:run.maxDurationMs+transportGraceMs' },
  'engineeringImprovement.lineageMaxDurationMs': { replacement: 'derived:run.maxDurationMs*lineage runs' },
  'engineeringImprovement.orchestrationReserveMs': { replacement: 'derived:run.finalizationReserveMs' },
  'engineeringImprovement.minimumCompleteChainMs': { replacement: 'derived:allocator.availableWork' },
  'validator.toolTimeoutMs': { replacement: 'derived:validator.queueWaitMs+validator.executionTimeoutMs+transportGraceMs' },
  'validator.transientRetryMax': { replacement: 'removed:validator-tool-executes-once' },
  'provider.maxConcurrency': { replacement: 'provider.maxConcurrentRuns' },
  'provider.queueTimeoutMs': { replacement: 'removed:run-abort-signal' },
  'model.fastRoute': { replacement: 'scope.modelRoute' },
  'model.mainRoute': { replacement: 'stage.main.modelRoute' },
  'model.mainReasoningPolicy': { replacement: 'stage.main.reasoningPolicy' },
  'model.finalizerReasoningPolicy': { replacement: 'stage.finalizer.reasoningPolicy' },
  'model.candidateRoute': { replacement: 'stage.candidate.modelRoute' },
  'model.repairRoute': { replacement: 'stage.repair.modelRoute' },
  'model.semanticReviewRoute': { replacement: 'semanticReview.modelRoute' },
  'model.finalizerRoute': { replacement: 'stage.finalizer.modelRoute' }
});

const BOOTSTRAP_VALUES = Object.freeze(Object.fromEntries(DEFINITIONS.map((definition) => [definition.key, definition.defaultValue])));
const DEFINITION_BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

function group(id, label, description) { return Object.freeze({ id, label, description }); }
function invariant(key, value, reason) { return Object.freeze({ key, label: key, value, reason }); }
function integer(key, groupId, label, defaultValue, minimum, maximum, unit, risk, applyMode, owner, description) {
  if (description === undefined) {
    description = owner;
    owner = defaultOwner(groupId);
  }
  return Object.freeze({ key, group: groupId, label, valueType: 'integer', defaultValue, minimum, maximum, step: 1, unit, risk, applyMode, owner, state: 'active', description });
}
function booleanDefinition(key, groupId, label, defaultValue, risk, applyMode, owner, description) {
  return Object.freeze({ key, group: groupId, label, valueType: 'boolean', defaultValue, risk, applyMode, owner, state: 'active', description });
}
function enumDefinition(key, groupId, label, defaultValue, allowedValues, risk, applyMode, owner, description) {
  return Object.freeze({ key, group: groupId, label, valueType: 'enum', defaultValue, allowedValues: Object.freeze([...allowedValues]), risk, applyMode, owner, state: 'active', description });
}
function modelRef(key, groupId, label, defaultValue, description) {
  return Object.freeze({ key, group: groupId, label, valueType: 'model-ref', defaultValue, risk: 'high', applyMode: 'new_run', owner: 'teacher', state: 'active', choiceSource: 'litellm-active-alias-ids', referenceTarget: 'business-model-alias.aliasId', description });
}
function defaultOwner(groupId) {
  if (groupId === 'validator') return 'validator';
  if (groupId === 'provider') return 'provider';
  return 'teacher';
}

function catalog() {
  return { schemaVersion: SCHEMA_VERSION, groups: GROUPS.map(copy), definitions: DEFINITIONS.map(copy), hardInvariants: HARD_INVARIANTS.map(copy), deprecatedKeys: { ...DEPRECATED_KEYS } };
}

function validatePolicyValues(input, options = {}) {
  const values = isPlainObject(input) ? input : {};
  const errors = [];
  const warnings = [];
  const normalized = {};
  if (!isPlainObject(input)) errors.push(issue('values', 'POLICY_VALUES_OBJECT_REQUIRED', '策略值必须是对象。'));
  for (const key of Object.keys(values)) if (!DEFINITION_BY_KEY.has(key)) errors.push(issue(key, 'POLICY_FIELD_UNKNOWN', `未知或已弃用策略字段：${key}`));
  const registeredAliasIds = normalizedRegisteredAliasIds(options.modelRegistry);
  const modelProfilesByAliasId = normalizedModelProfilesByAliasId(options.modelRegistry);
  for (const definition of DEFINITIONS) {
    if (!Object.hasOwn(values, definition.key)) {
      if (!options.allowPartial) errors.push(issue(definition.key, 'POLICY_FIELD_REQUIRED', `${definition.label}不能为空。`));
      continue;
    }
    const value = values[definition.key];
    if (definition.valueType === 'boolean') {
      if (typeof value !== 'boolean') errors.push(issue(definition.key, 'POLICY_FIELD_TYPE', `${definition.label}必须是布尔值。`));
      else normalized[definition.key] = value;
    } else if (definition.valueType === 'model-ref') {
      const alias = String(value || '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,199}$/.test(alias)) errors.push(issue(definition.key, 'POLICY_MODEL_REFERENCE_INVALID', `${definition.label}必须引用有效的 Alias ID。`));
      else if (registeredAliasIds && !registeredAliasIds.has(alias)) errors.push(issue(definition.key, 'POLICY_MODEL_REFERENCE_NOT_REGISTERED', `${definition.label}引用的 Alias ID 未注册。`));
      else if (modelProfilesByAliasId?.get(alias)?.runtimeProtocolStatus
        && modelProfilesByAliasId.get(alias).runtimeProtocolStatus !== 'ready') {
        errors.push(issue(definition.key, 'POLICY_MODEL_PROTOCOL_UNREADY', `${definition.label}引用的 Alias 没有唯一且可执行的模型协议。`));
      }
      else normalized[definition.key] = alias;
    } else if (definition.valueType === 'enum') {
      if (!definition.allowedValues.includes(value)) errors.push(issue(definition.key, 'POLICY_FIELD_ENUM', `${definition.label}不在允许值内。`));
      else normalized[definition.key] = value;
    } else if (!Number.isInteger(value)) {
      errors.push(issue(definition.key, 'POLICY_FIELD_TYPE', `${definition.label}必须是整数。`));
    } else if (value < definition.minimum || value > definition.maximum) {
      errors.push(issue(definition.key, 'POLICY_FIELD_RANGE', `${definition.label}必须在 ${definition.minimum}–${definition.maximum} 之间。`));
    } else normalized[definition.key] = value;
  }
  if (!errors.length || options.collectCrossFieldErrors) validateCrossFields(normalized, errors, warnings, modelProfilesByAliasId);
  if (options.baseline) for (const definition of DEFINITIONS) if (definition.risk === 'high' && normalized[definition.key] !== undefined && normalized[definition.key] !== options.baseline[definition.key]) warnings.push(issue(definition.key, 'POLICY_HIGH_RISK_CHANGE', `${definition.label}是高风险变更。`, 'warning'));
  return { ok: errors.length === 0, values: normalized, errors, warnings };
}

function validateCrossFields(v, errors, warnings, modelProfilesByAliasId) {
  compare(v, errors, 'run.finalizationReserveMs', '<', v['run.maxDurationMs'], '终态预留必须小于 Run 时限。');
  compare(v, errors, 'scope.initialTimeoutMs', '<=', v['scope.reviewTimeoutMs'], '首次判读超时不能大于独立复核超时。');
  compare(v, errors, 'validator.queueWaitMs', '<', v['run.maxDurationMs'] - v['run.finalizationReserveMs'], 'Validator 排队等待超出 Run 工作窗口。');
  compare(v, errors, 'validator.executionTimeoutMs', '<', v['run.maxDurationMs'] - v['run.finalizationReserveMs'], 'Validator 执行超时超出 Run 工作窗口。');
  if (v['scope.enabled'] === false) warnings.push(issue('scope.enabled', 'POLICY_SCOPE_GATE_DISABLED', 'Scope Gate 将关闭；授权与安全硬门保持。', 'warning'));
  if (v['repair.enabled'] === false) warnings.push(issue('repair.enabled', 'POLICY_REPAIR_DISABLED', 'Repair 将关闭；Validator FAIL 不会绕过。', 'warning'));
  validateModelReasoningCompatibility(v, errors, modelProfilesByAliasId);
}

function validateModelReasoningCompatibility(values, errors, modelProfilesByAliasId) {
  if (!(modelProfilesByAliasId instanceof Map)) return;
  const requirements = [
    ['scope.modelRoute', 'disabled', 'Scope Gate'],
    ['stage.main.modelRoute', values['stage.main.reasoningPolicy'], 'Main'],
    ['stage.candidate.modelRoute', 'provider-managed', 'Candidate'],
    ['stage.repair.modelRoute', 'provider-managed', 'Repair'],
    ['semanticReview.modelRoute', 'provider-managed', 'Semantic Review'],
    ['stage.finalizer.modelRoute', values['stage.finalizer.reasoningPolicy'], 'Finalizer']
  ];
  for (const [routeKey, reasoningPolicy, label] of requirements) {
    const profile = modelProfilesByAliasId.get(String(values[routeKey] || ''));
    const reasoning = profile?.executionPolicy?.reasoning;
    if (!reasoning) continue;
    const supported = reasoningPolicy === 'disabled'
      ? reasoning.disabled?.supported === true
      : reasoningPolicy === 'provider-managed'
        && reasoning.enabled?.supported === true
        && reasoning.enabled?.sdkReasoning !== 'none';
    if (!supported) {
      errors.push(issue(
        routeKey,
        'POLICY_MODEL_REASONING_MODE_UNSUPPORTED',
        `${label}引用的模型协议不支持当前推理策略${reasoningPolicy}。`
      ));
    }
  }
}

function compare(values, errors, key, operator, right, message) {
  const left = values[key];
  if (!Number.isFinite(left) || !Number.isFinite(right)) return;
  const ok = operator === '<' ? left < right : operator === '>' ? left > right : operator === '>=' ? left >= right : left <= right;
  if (!ok) errors.push(issue(key, 'POLICY_CROSS_FIELD_CONFLICT', message));
}
function issue(key, code, message, severity = 'error') { return { key, code, message, severity }; }

function migratePolicyValues(sourceValues = {}, options = {}) {
  const source = isPlainObject(sourceValues) ? sourceValues : {};
  const values = { ...BOOTSTRAP_VALUES };
  for (const key of Object.keys(values)) if (Object.hasOwn(source, key)) values[key] = source[key];
  const map = (target, sourceKey, transform = (value) => value) => { if (Object.hasOwn(source, sourceKey)) values[target] = transform(source[sourceKey]); };
  const mapIfTargetAbsent = (target, sourceKey, transform = (value) => value) => {
    if (!Object.hasOwn(source, target) && Object.hasOwn(source, sourceKey)) values[target] = transform(source[sourceKey]);
  };
  map('run.finalizationReserveMs', 'run.terminalReserveMs');
  map('stage.main.modelRoute', 'model.mainRoute');
  map('stage.candidate.modelRoute', 'model.candidateRoute');
  map('stage.repair.modelRoute', 'model.repairRoute');
  map('stage.finalizer.modelRoute', 'model.finalizerRoute');
  mapIfTargetAbsent('stage.main.reasoningPolicy', 'model.mainReasoningPolicy');
  mapIfTargetAbsent('stage.finalizer.reasoningPolicy', 'model.finalizerReasoningPolicy');
  map('tool.maxRetriesPerOperation', 'tool.maxFailuresPerRun', (value) => Math.min(2, Math.max(0, (Number(value) || 1) - 1)));
  map('tool.defaultTimeoutMs', 'tool.readOnlyTimeoutMs');
  map('domainEvidence.maxQueriesPerRun', 'tool.domainEvidenceMaxCallsPerRun');
  map('domainEvidence.timeoutMs', 'tool.domainEvidenceTimeoutMs');
  mapIfTargetAbsent('candidate.maxGenerationAttempts', 'run.maxRecoveryAttempts', (value) => 1 + Math.max(0, Number(value) || 0));
  mapIfTargetAbsent('candidate.maxGenerationAttempts', 'candidate.recoveryMaxAttempts', (value) => 1 + Math.max(0, Number(value) || 0));
  map('repair.enabled', 'candidate.repairEnabled');
  map('provider.maxConcurrentRuns', 'provider.maxConcurrency');
  map('scope.modelRoute', 'model.fastRoute');
  map('semanticReview.maxCycles', 'engineeringRevision.maxCycles');
  map('semanticReview.timeoutMs', 'semanticReview.assessmentTimeoutMs');
  map('semanticReview.modelRoute', 'model.semanticReviewRoute');
  // 旧策略升级时继承原复核行为；新字段已有值时不得被 Main 或工程 Review 覆盖。


  const legacyModelRouteKeys = {
    'stage.main.modelRoute': 'model.mainRoute',
    'stage.candidate.modelRoute': 'model.candidateRoute',
    'stage.repair.modelRoute': 'model.repairRoute',
    'stage.finalizer.modelRoute': 'model.finalizerRoute',
    'scope.modelRoute': 'model.fastRoute',
    'semanticReview.modelRoute': 'model.semanticReviewRoute'
  };
  const hasNonBlankModelReference = (key) => Object.hasOwn(source, key) && String(source[key] ?? '').trim().length > 0;
  const missingModelRouteKeys = new Set(Object.entries(legacyModelRouteKeys)
    .filter(([target, legacy]) => {
      if (!hasNonBlankModelReference(target) && !hasNonBlankModelReference(legacy)) return true;
      const sourceReference = String(hasNonBlankModelReference(target) ? source[target] : source[legacy]).trim();
      return sourceReference === BOOTSTRAP_VALUES[target];
    })
    .map(([target]) => target));
  const resolvedValues = resolvePolicyModelReferenceValues(values, options.modelRegistry, { fallbackKeys: missingModelRouteKeys });
  // 新增独立模型路由时继承已经解析成功的 Main Alias，不凭名称猜测替换模型。

  const validation = validatePolicyValues(resolvedValues, { modelRegistry: options.modelRegistry });
  if (!validation.ok) {
    const error = new Error('Agent resource policy migration is invalid.');
    error.code = 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID';
    const registryProfiles = Array.isArray(options.modelRegistry?.profiles) ? options.modelRegistry.profiles : [];
    error.details = {
      ...validation,
      migrationDiagnostics: {
        registryProfileCount: registryProfiles.length,
        executableProfileCount: registryProfiles.filter((profile) => String(profile?.aliasId || '').trim()
          && profile?.runtimeProtocolStatus === 'ready').length,
        fallbackEligibleCount: missingModelRouteKeys.size,
        resolvedRouteCount: Object.keys(legacyModelRouteKeys).filter((key) => Object.hasOwn(validation.values, key)).length,
        routes: Object.entries(legacyModelRouteKeys).map(([target, legacy]) => {
          const targetNonBlank = hasNonBlankModelReference(target);
          const legacyNonBlank = hasNonBlankModelReference(legacy);
          const selectedReference = String(targetNonBlank ? source[target] : legacyNonBlank ? source[legacy] : '').trim();
          return {
            key: target,
            targetPresent: Object.hasOwn(source, target),
            targetNonBlank,
            legacyPresent: Object.hasOwn(source, legacy),
            legacyNonBlank,
            selectedMatchesLegacyDefault: selectedReference === BOOTSTRAP_VALUES[target],
            fallbackEligible: missingModelRouteKeys.has(target),
            bootstrapFamilyMatchCount: registryProfiles.filter((profile) => {
              if (!String(profile?.aliasId || '').trim() || profile?.runtimeProtocolStatus !== 'ready') return false;
              const runtimeAlias = String(profile?.litellmAlias || profile?.alias || '').trim();
              const legacyDefault = String(BOOTSTRAP_VALUES[target] || '').trim();
              return runtimeAlias === legacyDefault || runtimeAlias.startsWith(`${legacyDefault}-`);
            }).length,
            resolved: Object.hasOwn(validation.values, target)
          };
        })
      }
    };
    throw error;
  }
  return { values: validation.values, deprecatedKeys: Object.keys(source).filter((key) => DEPRECATED_KEYS[key]), unknownKeys: Object.keys(source).filter((key) => !DEFINITION_BY_KEY.has(key) && !DEPRECATED_KEYS[key]) };
}

function resolvePolicyModelReferenceValues(sourceValues = {}, modelRegistry, options = {}) {
  const values = isPlainObject(sourceValues) ? { ...sourceValues } : {};
  if (!modelRegistry) return values;
  const profiles = Array.isArray(modelRegistry.profiles) ? modelRegistry.profiles : [];
  const byId = new Map(profiles.map((profile) => [String(profile?.aliasId || '').trim(), profile]).filter(([key]) => key));
  const byRuntimeAlias = new Map(profiles.map((profile) => [String(profile?.litellmAlias || profile?.alias || '').trim(), profile]).filter(([key]) => key));
  const fallbackProfiles = profiles
    .filter((profile) => String(profile?.aliasId || '').trim() && profile?.runtimeProtocolStatus === 'ready')
    .sort((left, right) => String(left.aliasId).localeCompare(String(right.aliasId)));
  const fallbackKeys = options.fallbackKeys instanceof Set ? options.fallbackKeys : new Set();
  const resolvedExecutableAliasIds = new Set();
  const ambiguousFamilyFallbackKeys = new Set();
  for (const definition of DEFINITIONS) {
    if (definition.valueType !== 'model-ref' || !Object.hasOwn(values, definition.key)) continue;
    const reference = String(values[definition.key] || '').trim();
    const profile = byId.get(reference) || byRuntimeAlias.get(reference);
    if (profile?.aliasId) {
      values[definition.key] = String(profile.aliasId).trim();
      if (profile.runtimeProtocolStatus === 'ready') {
        resolvedExecutableAliasIds.add(String(profile.aliasId).trim());
      }
    }
  }
  for (const key of fallbackKeys) {
    const reference = String(values[key] || '').trim();
    const currentProfile = byId.get(reference) || byRuntimeAlias.get(reference);
    if (currentProfile && (!currentProfile.runtimeProtocolStatus || currentProfile.runtimeProtocolStatus === 'ready')) continue;
    const legacyDefault = String(BOOTSTRAP_VALUES[key] || '').trim();
    if (reference !== legacyDefault) continue;
    const familyMatches = fallbackProfiles.filter((profile) => {
      const runtimeAlias = String(profile?.litellmAlias || profile?.alias || '').trim();
      return runtimeAlias === legacyDefault || runtimeAlias.startsWith(`${legacyDefault}-`);
    });
    if (familyMatches.length > 1) {
      ambiguousFamilyFallbackKeys.add(key);
      continue;
    }
    if (familyMatches.length !== 1) continue;
    const aliasId = String(familyMatches[0].aliasId).trim();
    values[key] = aliasId;
    resolvedExecutableAliasIds.add(aliasId);
  }
  const consensusFallbackAliasId = resolvedExecutableAliasIds.size === 1
    ? Array.from(resolvedExecutableAliasIds)[0]
    : fallbackProfiles.length === 1
      ? String(fallbackProfiles[0].aliasId).trim()
      : '';
  if (consensusFallbackAliasId) for (const key of fallbackKeys) {
    if (ambiguousFamilyFallbackKeys.has(key)) continue;
    const reference = String(values[key] || '').trim();
    const profile = byId.get(reference) || byRuntimeAlias.get(reference);
    if (!profile || (profile.runtimeProtocolStatus && profile.runtimeProtocolStatus !== 'ready')) values[key] = consensusFallbackAliasId;
  }
  return values;
}

function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function canonicalValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  throw new TypeError('Policy value is not JSON serializable.');
}
function checksumPolicyValues(values) { return `sha256:${crypto.createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex')}`; }

function createPolicySnapshot({ versionId, values, frozenAt = new Date().toISOString() } = {}) {
  const validation = validatePolicyValues(values);
  if (!validation.ok) { const error = new Error('Agent resource policy is invalid.'); error.code = 'AGENT_RESOURCE_POLICY_INVALID'; error.statusCode = 400; error.details = validation; throw error; }
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, versionId: String(versionId || '').trim() || `arp_bootstrap_v${SCHEMA_VERSION}`, checksum: checksumPolicyValues(validation.values), values: Object.freeze({ ...validation.values }), frozenAt });
}
function validatePolicySnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return { ok: false, errors: [issue('snapshot', 'POLICY_SNAPSHOT_REQUIRED', '资源策略快照不能为空。')], warnings: [] };
  const validation = validatePolicyValues(snapshot.values);
  const errors = [...validation.errors];
  if (snapshot.schemaVersion !== SCHEMA_VERSION) errors.push(issue('schemaVersion', 'POLICY_SCHEMA_VERSION_INVALID', '资源策略 Schema 版本不受支持。'));
  if (snapshot.checksum !== (validation.ok ? checksumPolicyValues(validation.values) : '')) errors.push(issue('checksum', 'POLICY_CHECKSUM_MISMATCH', '资源策略 checksum 不匹配。'));
  return { ok: errors.length === 0, values: validation.values, errors, warnings: validation.warnings };
}

function runtimeProjection(values) {
  const validation = validatePolicyValues(values);
  if (!validation.ok) { const error = new Error('Cannot project an invalid Agent resource policy.'); error.code = 'AGENT_RESOURCE_POLICY_INVALID'; error.details = validation; throw error; }
  const v = validation.values;
  const transportGraceMs = Math.max(5000, Math.floor(v['run.finalizationReserveMs'] / 3));
  const validatorToolTimeoutMs = v['validator.queueWaitMs'] + v['validator.executionTimeoutMs'] + transportGraceMs;
  const maxUniqueCandidateValidationsPerWorker = 1 + v['repair.maxRounds'];
  return Object.freeze({
    api: Object.freeze({ outerTimeoutMs: v['run.maxDurationMs'] + transportGraceMs }),
    teacher: Object.freeze({
      agentMaxDurationMs: v['run.maxDurationMs'], agentTerminalReserveMs: v['run.finalizationReserveMs'], agentConvergeLeadMs: Math.floor((v['run.maxDurationMs'] - v['run.finalizationReserveMs']) / 6), agentToolTimeoutMs: v['tool.defaultTimeoutMs'], agentTerminalPersistenceTimeoutMs: transportGraceMs,
      agentScopeGateEnabled: v['scope.enabled'], agentScopeGateInitialTimeoutMs: v['scope.initialTimeoutMs'], agentScopeGateReviewTimeoutMs: v['scope.reviewTimeoutMs'], agentScopeGateHardInputTokenBudget: v['scope.hardInputTokenBudget'], agentScopeGateMaxOutputTokens: v['scope.maxOutputTokens'], agentMainContextExecutionReserveTokens: v['context.mainExecutionReserveTokens'],
      agentMaxSteps: v['tool.maxCallsPerRun'], agentInspectLessonContextMaxCallsPerRun: v['tool.maxCallsPerRun'], agentInspectCurrentModelMaxCallsPerRun: v['tool.maxCallsPerRun'], agentSkillGuidanceMaxCallsPerRun: v['tool.maxCallsPerRun'], agentReviewedKnowledgeMaxCallsPerRun: v['tool.maxCallsPerRun'], agentDomainEvidenceMaxCallsPerRun: v['domainEvidence.maxQueriesPerRun'],
      agentReadOnlyToolMaxRetriesPerOperation: v['tool.maxRetriesPerOperation'], agentReadOnlyToolInputMaxBytes: v['tool.inputMaxBytes'], agentReadOnlyToolTimeoutMs: v['tool.defaultTimeoutMs'], agentDomainEvidenceToolTimeoutMs: v['domainEvidence.timeoutMs'],
      agentCandidateRecoveryMaxAttempts: Math.max(0, v['candidate.maxGenerationAttempts'] - 1), agentCandidateMaxAttemptMs: v['run.maxDurationMs'] - v['run.finalizationReserveMs'] - validatorToolTimeoutMs, agentCandidateRepairEnabled: v['repair.enabled'], agentRepairPhaseReserveMs: Math.max(validatorToolTimeoutMs, Math.floor((v['run.maxDurationMs'] - v['run.finalizationReserveMs']) / 4)), agentRepairMaxRounds: v['repair.maxRounds'], agentCandidateMaxArtifactBytes: v['candidate.maxArtifactBytes'],
      agentSemanticReviewEnabled: v['semanticReview.enabled'], agentSemanticReviewShadowOnly: v['semanticReview.shadowOnly'], agentSemanticReviewAssessmentMaxCalls: v['semanticReview.maxCycles'], agentSemanticReviewAssessmentTimeoutMs: v['semanticReview.timeoutMs'], agentSemanticReviewMainDecisionTimeoutMs: Math.min(v['semanticReview.timeoutMs'], v['tool.defaultTimeoutMs']), agentSemanticReviewVerificationMaxCalls: v['semanticReview.maxCycles'], agentSemanticReviewVerificationTimeoutMs: v['semanticReview.timeoutMs'], agentSemanticReviewMinimumCompleteChainMs: Math.floor((v['run.maxDurationMs'] - v['run.finalizationReserveMs']) / 3), agentSemanticReviewDomainSearchReserveMs: 0,
      agentEngineeringRevisionMaxCycles: v['semanticReview.maxCycles'], agentEngineeringRevisionMaxDurationMs: Math.floor((v['run.maxDurationMs'] - v['run.finalizationReserveMs']) / 2), agentEngineeringRevisionValidationRepairReserveMs: validatorToolTimeoutMs, agentEngineeringImprovementRunMaxDurationMs: v['run.maxDurationMs'], agentEngineeringImprovementApiOuterTimeoutMs: v['run.maxDurationMs'] + transportGraceMs, agentEngineeringImprovementLineageMaxDurationMs: v['run.maxDurationMs'] * (1 + v['run.maxAutoContinuationsPerLineage']), agentEngineeringImprovementOrchestrationReserveMs: transportGraceMs, agentEngineeringImprovementMinimumCompleteChainMs: Math.floor((v['run.maxDurationMs'] - v['run.finalizationReserveMs']) / 2),
      agentValidatorToolTimeoutMs: validatorToolTimeoutMs, agentTemperature: v['stage.temperaturePermille'] / 1000, agentReasoningMode: v['stage.main.reasoningPolicy'],
      agentStageModelRoutes: Object.freeze({ fastGate: v['scope.modelRoute'], main: v['stage.main.modelRoute'], candidate: v['stage.candidate.modelRoute'], repair: v['stage.repair.modelRoute'], semanticReview: v['semanticReview.modelRoute'], finalizer: v['stage.finalizer.modelRoute'] }),
      agentStageReasoningPolicies: Object.freeze({ fastGate: 'disabled', main: v['stage.main.reasoningPolicy'], candidate: 'provider-managed', repair: 'provider-managed', semanticReview: 'provider-managed', finalizer: v['stage.finalizer.reasoningPolicy'] }),
      run06: Object.freeze({ toolMaxCallsPerRun: v['tool.maxCallsPerRun'], toolMaxRetriesPerOperation: v['tool.maxRetriesPerOperation'], taskSourceMaxEntries: v['context.taskSourceMaxEntries'], studentQuestionMaxChars: v['context.studentQuestionMaxChars'], repairMaxRounds: v['repair.maxRounds'], candidateMaxArtifactBytes: v['candidate.maxArtifactBytes'], maxUniqueCandidateValidationsPerWorker, maxUniqueCandidateValidationsFormula: '1 + repair.maxRounds', maxAutoContinuationsPerLineage: v['run.maxAutoContinuationsPerLineage'], domainEvidenceMaxSearchUsesPerQuery: v['domainEvidence.maxSearchUsesPerQuery'], domainEvidenceMaxProviderStepsPerQuery: v['domainEvidence.maxProviderStepsPerQuery'], domainEvidenceMaxOutputTokensPerQuery: v['domainEvidence.maxOutputTokensPerQuery'] })
    }),
    validator: Object.freeze({ queueLimit: v['validator.queueLimit'], queueWaitMs: v['validator.queueWaitMs'], executionTimeoutMs: v['validator.executionTimeoutMs'], toolTimeoutMs: validatorToolTimeoutMs }),
    provider: Object.freeze({ maxConcurrency: v['provider.maxConcurrentRuns'], queueLimit: v['provider.queueLimit'] }),
    probe: Object.freeze({ enabled: v['probe.enabled'], hourlyLimit: v['probe.hourlyLimit'], timeoutMs: v['probe.timeoutMs'] })
  });
}

function deriveRequestEnvelopeMaxBytes(candidateArtifactBytesValue, contextWindowTokensValue) {
  const candidateArtifactBytes = Number(candidateArtifactBytesValue);
  const contextWindowTokens = Number(contextWindowTokensValue);
  if (!Number.isInteger(candidateArtifactBytes) || candidateArtifactBytes <= 0
    || !Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    const error = new Error('Request envelope size requires positive Candidate bytes and context tokens.');
    error.code = 'AGENT_RESOURCE_POLICY_REQUEST_SIZE_INVALID';
    throw error;
  }
  return candidateArtifactBytes + contextWindowTokens * CONTEXT_TOKEN_BYTE_ESTIMATE;
}

function diffPolicyValues(before = {}, after = {}) { return DEFINITIONS.flatMap((definition) => before[definition.key] === after[definition.key] ? [] : [{ key: definition.key, label: definition.label, before: before[definition.key], after: after[definition.key], risk: definition.risk, owner: definition.owner, applyMode: definition.applyMode }]); }
function normalizedRegisteredAliasIds(modelRegistry) { if (!modelRegistry) return null; const source = Array.isArray(modelRegistry) ? modelRegistry : Array.isArray(modelRegistry.aliasIds) ? modelRegistry.aliasIds : Array.isArray(modelRegistry.profiles) ? modelRegistry.profiles.map((item) => item?.aliasId) : []; return new Set(source.map((item) => String(item || '').trim()).filter(Boolean)); }
function normalizedModelProfilesByAliasId(modelRegistry) { if (!modelRegistry || !Array.isArray(modelRegistry.profiles)) return null; return new Map(modelRegistry.profiles.map((profile) => [String(profile?.aliasId || '').trim(), profile]).filter(([key]) => key)); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function copy(value) { return { ...value, ...(value.allowedValues ? { allowedValues: [...value.allowedValues] } : {}) }; }

module.exports = { SCHEMA_VERSION, CONTEXT_TOKEN_BYTE_ESTIMATE, STUDENT_QUESTION_PROTOCOL_CEILING, GROUPS, DEFINITIONS, HARD_INVARIANTS, DEPRECATED_KEYS, BOOTSTRAP_VALUES, catalog, validatePolicyValues, validatePolicySnapshot, checksumPolicyValues, createPolicySnapshot, runtimeProjection, deriveRequestEnvelopeMaxBytes, migratePolicyValues, resolvePolicyModelReferenceValues, diffPolicyValues, canonicalJson };
