'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 6;

const GROUPS = Object.freeze([
  Object.freeze({ id: 'api', label: 'API 外层', description: '平台 API 到 Teacher 的请求宽限与外层终止边界。' }),
  Object.freeze({ id: 'run', label: 'Run 时间', description: '单个 Agent Run 的总时限、收敛窗口与工具等待预算。' }),
  Object.freeze({ id: 'scope', label: 'Scope Gate', description: '首次范围筛选与独立复核预算。' }),
  Object.freeze({ id: 'answer', label: '回答 Token', description: '最终回答的上下文与输出 ceiling。' }),
  Object.freeze({ id: 'knowledge', label: '知识检索', description: '每个 Run 可发起的新知识查询 ceiling。' }),
  Object.freeze({ id: 'candidate', label: 'Candidate', description: '候选生成、内容恢复与 Validator 使用上限；初始 Candidate 输出由 Provider 管理。' }),
  Object.freeze({ id: 'repair', label: 'Repair 阶段', description: 'Validator 失败后的 Repair 时间预留与单步输出预算。' }),
  Object.freeze({ id: 'semanticReview', label: '工程语义软 Review', description: 'Official Validator PASS 后的只读评议、Main 判读、一次工程完善和确认预算。' }),
  Object.freeze({ id: 'engineeringRevision', label: '工程语义完善', description: '工程建议被准入后，由 Candidate Worker 完成一次完整候选修订和必要语法修复。' }),
  Object.freeze({ id: 'engineeringImprovement', label: '工程改进续跑', description: 'Primary Run 无法容纳完整改进链时，唯一 Improvement 子 Run 的时间和 lineage 边界。' }),
  Object.freeze({ id: 'validator', label: 'Validator', description: 'Validator Tool 的排队、执行与总等待预算。' }),
  Object.freeze({ id: 'provider', label: 'Provider', description: '模型 Provider 的并发、排队、重试与熔断策略。' }),
  Object.freeze({ id: 'probe', label: '健康探测', description: '付费 Provider 探针的频率与超时。' }),
  Object.freeze({ id: 'model', label: '阶段模型', description: '从已注册 LiteLLM Alias 中为各执行阶段选择模型；按新 Run 冻结。' })
]);

const DEFINITIONS = Object.freeze([
  integer('api.outerTimeoutMs', 'api', 'API 外层超时', 630000, 150000, 1200000, 'ms', 'high', 'new_run', 'api', '平台 API 等待单个 Teacher Run 完成、持久化并关闭响应的外层时限。'),
  integer('run.maxSteps', 'run', 'Run 最大步数', 8, 1, 8, 'steps', 'high', 'new_run', 'teacher', 'AI SDK 主循环的安全上限。'),
  integer('run.maxDurationMs', 'run', 'Run 最长执行时间', 600000, 120000, 900000, 'ms', 'high', 'new_run', 'teacher', '从 Run 开始到终态的 hard deadline。'),
  integer('run.terminalReserveMs', 'run', '终态阶段预留', 30000, 5000, 60000, 'ms', 'high', 'new_run', 'teacher', 'Run 内最终绑定、持久化和安全返回不可被 Candidate 占用的时间。'),
  integer('run.convergeLeadMs', 'run', '收敛提前量', 75000, 30000, 75000, 'ms', 'medium', 'new_run', '到达 hard deadline 前停止探索并进入收敛的窗口。'),
  integer('run.toolTimeoutMs', 'run', 'Tool 超时', 75000, 15000, 120000, 'ms', 'medium', 'new_run', '单次 Tool 调用的停滞保护。'),
  integer('run.terminalPersistTimeoutMs', 'run', '终态持久化超时', 5000, 1000, 25000, 'ms', 'medium', 'owner_reload', 'Run 外写入终态的短窗口。'),

  booleanDefinition('scope.enabled', 'scope', '启用 Scope Gate', true, 'high', 'new_run', 'teacher', '关闭只跳过范围筛选，不改变授权与安全硬门。'),
  integer('scope.initialTimeoutMs', 'scope', '首次筛选超时', 10000, 3000, 30000, 'ms', 'medium', 'new_run', '首次范围判断预算。'),
  integer('scope.reviewTimeoutMs', 'scope', '独立复核超时', 18000, 5000, 30000, 'ms', 'medium', 'new_run', '完全越界时独立复核预算。'),
  integer('scope.maxOutputTokens', 'scope', 'Scope Gate 输出上限', 500, 100, 1000, 'tokens', 'low', 'new_run', '范围判断的最大输出 Token。'),

  integer('answer.hardMaxOutputTokens', 'answer', '单步输出硬上限', 16000, 4096, 16000, 'tokens', 'high', 'new_run', '所有回答档位的绝对上限。'),
  integer('answer.contextWindowTokens', 'answer', '上下文窗口', 64000, 16000, 200000, 'tokens', 'high', 'new_run', '不得超过当前模型组声明能力。'),
  integer('answer.lowMaxOutputTokens', 'answer', 'LOW 回答上限', 3000, 512, 8000, 'tokens', 'medium', 'new_run', 'LOW 档最终回答输出 ceiling。'),
  integer('answer.mediumMaxOutputTokens', 'answer', 'MEDIUM 回答上限', 4500, 512, 8000, 'tokens', 'medium', 'new_run', 'MEDIUM 档最终回答输出 ceiling。'),
  integer('answer.highMaxOutputTokens', 'answer', 'HIGH 回答上限', 6000, 512, 8000, 'tokens', 'medium', 'new_run', 'HIGH 档最终回答输出 ceiling。'),

  integer('knowledge.reviewedMaxNewQueriesPerRun', 'knowledge', 'Reviewed Knowledge 每 Run 最多新查询', 2, 0, 2, 'calls', 'medium', 'new_run', '查询预算是 ceiling，证据充分时允许 0 次。'),

  integer('candidate.recoveryMaxAttempts', 'candidate', 'Candidate 恢复次数', 1, 0, 1, 'calls', 'medium', 'new_run', '候选内容截断或不可解析时的有界恢复。'),
  integer('candidate.maxAttemptMs', 'candidate', 'Candidate 单次上限', 420000, 30000, 600000, 'ms', 'high', 'new_run', 'teacher', '单次 Candidate 生成的绝对上限；实际截止时间还必须保留 Validator、Repair 和终态预算。'),
  booleanDefinition('candidate.repairEnabled', 'candidate', '启用 Repair', true, 'high', 'new_run', 'teacher', '关闭后 Validator FAIL 不进入 Repair，但仍不得绕过 Validator。'),
  integer('candidate.maxValidatorCallsPerWorker', 'candidate', '每 Worker 最大 Validator 次数', 12, 4, 20, 'calls', 'high', 'new_run', '单个 Candidate 或 Repair Worker 的唯一候选验证上限。'),

  integer('repair.phaseReserveMs', 'repair', 'Repair 阶段预留', 120000, 30000, 300000, 'ms', 'high', 'new_run', 'teacher', '为至少一次 Repair、完整候选提交和再验证预留的时间。'),
  integer('repair.maxOutputTokens', 'repair', 'Repair 单步输出上限', 32000, 4096, 64000, 'tokens', 'high', 'new_run', '每次 Repair 模型调用的 completion ceiling；reasoning、可见文本和完整 Candidate Tool 参数共享该额度。'),

  booleanDefinition('semanticReview.enabled', 'semanticReview', '启用工程语义软 Review', false, 'high', 'new_run', 'teacher', '首版默认关闭；启用后只产生建议并允许一次有界工程完善，失败时回退已通过Validator的基线，不形成阻断门。'),
  booleanDefinition('semanticReview.shadowOnly', 'semanticReview', '仅运行 Shadow Assessment', false, 'medium', 'new_run', 'teacher', '启用时只记录Assessment建议，不进入Main或Candidate完善；关闭且Review启用时按taskEffect执行一次完整软审查链。'),
  integer('semanticReview.assessmentMaxCalls', 'semanticReview', 'Assessment 最大调用数', 1, 1, 1, 'calls', 'high', 'new_run', '每个用户授权周期最多执行一次Assessment。'),
  integer('semanticReview.assessmentTimeoutMs', 'semanticReview', 'Assessment 超时', 120000, 5000, 120000, 'ms', 'high', 'new_run', 'Pro只读工程评议的单次时间上限；真实长Candidate评议需要覆盖Provider抖动。'),
  integer('semanticReview.mainDecisionTimeoutMs', 'semanticReview', 'Main 判读超时', 20000, 3000, 60000, 'ms', 'medium', 'new_run', 'Main对已绑定建议进行一次动作选择的时间上限。'),
  integer('semanticReview.verificationMaxCalls', 'semanticReview', 'Verification 最大调用数', 1, 1, 1, 'calls', 'high', 'new_run', '每个用户授权周期最多执行一次只读Verification。'),
  integer('semanticReview.verificationTimeoutMs', 'semanticReview', 'Verification 超时', 30000, 5000, 120000, 'ms', 'high', 'new_run', '修订Candidate再次通过Validator后的单次只读确认上限。'),
  integer('semanticReview.maxOutputTokens', 'semanticReview', 'Review 输出上限', 12000, 512, 16000, 'tokens', 'medium', 'new_run', 'Assessment与Verification建议文本共享的completion ceiling；Assessment需容纳有界推理。'),
  integer('semanticReview.maxIssues', 'semanticReview', 'Review 建议上限', 8, 1, 8, 'issues', 'medium', 'new_run', '服务端接收并绑定的最大工程建议数；这是上限而非配额，相关遗漏应合并为可一次闭合的目标簇。'),
  integer('semanticReview.minimumCompleteChainMs', 'semanticReview', '完整改进链最小预算', 180000, 60000, 600000, 'ms', 'high', 'new_run', '预算不足时不启动Assessment，直接保留已通过Validator的基线。'),
  integer('semanticReview.domainSearchReserveMs', 'semanticReview', '证据查询预留（V1停用）', 0, 0, 0, 'ms', 'medium', 'new_run', 'V1尚未实现Engineering Review内的证据检索动作，因此该值固定为0；后续只有在真实检索链实现并验收后才开放。'),

  integer('engineeringRevision.maxCycles', 'engineeringRevision', '工程完善最大轮次', 1, 1, 1, 'cycles', 'high', 'new_run', '一次用户授权周期最多创建一个Engineering Revision Candidate。'),
  integer('engineeringRevision.maxDurationMs', 'engineeringRevision', '工程完善Candidate上限', 330000, 60000, 600000, 'ms', 'high', 'new_run', 'Engineering Revision Candidate单次生成的时间上限。'),
  integer('engineeringRevision.validationRepairReserveMs', 'engineeringRevision', 'Revision语法修复预留', 255000, 60000, 420000, 'ms', 'high', 'new_run', 'Revision引入Official错误后，为Validation Repair及复验保留的总预算。'),

  integer('engineeringImprovement.runMaxDurationMs', 'engineeringImprovement', 'Improvement Run最长时间', 900000, 300000, 900000, 'ms', 'high', 'new_run', '唯一工程改进子Run的hard deadline。'),
  integer('engineeringImprovement.apiOuterTimeoutMs', 'engineeringImprovement', 'Improvement API外层超时', 930000, 330000, 1200000, 'ms', 'high', 'new_run', '平台API等待Improvement子Run完成、持久化并关闭响应的外层时限。'),
  integer('engineeringImprovement.lineageMaxDurationMs', 'engineeringImprovement', '自动lineage总时限', 1500000, 900000, 1800000, 'ms', 'high', 'new_run', 'Primary与最多一个自动Continuation/Improvement Run的总hard ceiling。'),
  integer('engineeringImprovement.orchestrationReserveMs', 'engineeringImprovement', '跨Run编排预留', 20000, 5000, 60000, 'ms', 'medium', 'new_run', '两个Run之间用于持久化、预算预留和调度的时间。'),
  integer('engineeringImprovement.minimumCompleteChainMs', 'engineeringImprovement', '子Run完整链最小预算', 720000, 300000, 900000, 'ms', 'high', 'new_run', '可用Improvement时间低于该值时不自动创建子Run。'),

  integer('validator.queueLimit', 'validator', 'Validator 队列上限', 8, 0, 32, 'requests', 'medium', 'owner_reload', '等待队列长度，0 表示不排队。'),
  integer('validator.queueWaitMs', 'validator', 'Validator 排队等待', 15000, 1000, 30000, 'ms', 'medium', 'owner_reload', '进入执行前的最大等待时间。'),
  integer('validator.executionTimeoutMs', 'validator', 'Validator 执行超时', 25000, 5000, 45000, 'ms', 'high', 'owner_reload', 'Official Validator 执行段预算。'),
  integer('validator.toolTimeoutMs', 'validator', 'Validator Tool 总超时', 45000, 10000, 60000, 'ms', 'high', 'new_run', 'Teacher 到 API Validator Tool 的总门。'),
  integer('validator.transientRetryMax', 'validator', 'Validator 瞬时重试次数', 1, 0, 1, 'calls', 'medium', 'owner_reload', '只允许对确定尚未开始的瞬时失败重试。'),

  integer('provider.maxConcurrency', 'provider', 'Provider 最大并发', 2, 1, 8, 'requests', 'high', 'owner_reload', 'Teacher 到模型 Provider 的并发上限。'),
  integer('provider.queueLimit', 'provider', 'Provider 队列上限', 20, 0, 100, 'requests', 'medium', 'owner_reload', 'Provider 请求等待队列长度。'),
  integer('provider.queueTimeoutMs', 'provider', 'Provider 排队超时', 8000, 1000, 30000, 'ms', 'medium', 'owner_reload', 'Provider 请求最大排队等待。'),
  integer('provider.maxRetries', 'provider', 'Provider 最大重试', 1, 0, 2, 'calls', 'high', 'owner_reload', '仅对基础设施瞬时错误重试。'),
  booleanDefinition('provider.retryJitter', 'provider', '启用重试抖动', true, 'medium', 'owner_reload', 'provider', '避免多个请求按相同退避节奏同时重试。'),
  integer('provider.retryBaseMs', 'provider', 'Provider 退避起点', 500, 100, 3000, 'ms', 'medium', 'owner_reload', '指数退避起点。'),
  integer('provider.retryMaxMs', 'provider', 'Provider 退避上限', 3000, 500, 10000, 'ms', 'medium', 'owner_reload', '重试等待上限。'),
  integer('provider.circuitFailureThreshold', 'provider', '熔断失败阈值', 5, 2, 20, 'requests', 'high', 'owner_reload', '统计窗口内触发熔断的失败数。'),
  integer('provider.circuitFailureWindowMs', 'provider', '熔断统计窗口', 60000, 10000, 300000, 'ms', 'medium', 'owner_reload', 'Provider 失败统计时间窗。'),
  integer('provider.circuitOpenMs', 'provider', '熔断开启时长', 30000, 5000, 300000, 'ms', 'high', 'owner_reload', '熔断后暂停请求的时间。'),
  integer('provider.halfOpenMaxProbes', 'provider', '半开探测并发', 1, 1, 3, 'requests', 'medium', 'owner_reload', '熔断半开状态允许的探测并发。'),

  booleanDefinition('probe.enabled', 'probe', '启用后台健康探测', true, 'medium', 'owner_reload', 'teacher', '只控制后台探针，不授予学生联网能力。'),
  integer('probe.hourlyLimit', 'probe', '每小时探针上限', 6, 0, 24, 'calls', 'medium', 'owner_reload', '付费探针的小时成本上限。'),
  integer('probe.timeoutMs', 'probe', '探针超时', 30000, 5000, 120000, 'ms', 'medium', 'owner_reload', '单次 Provider 健康探测预算。'),

  modelRef('model.fastRoute', 'Fast Gate 模型', 'ai-teacher-fast', 'Fast Gate 固定非思考调用。'),
  modelRef('model.mainRoute', 'Main 模型', 'ai-teacher-fast', '意图理解、澄清、普通回答与只读 Tool 编排。'),
  modelRef('model.candidateRoute', 'Candidate 模型', 'ai-teacher-reasoning', '完整 SysML v2 Candidate 生成。'),
  modelRef('model.repairRoute', 'Repair 模型', 'ai-teacher-reasoning', 'Validator 失败后的多轮 Repair。'),
  modelRef('model.semanticReviewRoute', '工程语义 Review 模型', 'ai-teacher-reasoning', '用于独立Assessment与Verification；只读建议、失败回退，不形成交付硬门。'),
  modelRef('model.finalizerRoute', 'Finalizer 模型', 'ai-teacher-fast', '将可信结果整理为学生可见回答，固定非思考调用。')
]);

const HARD_INVARIANTS = Object.freeze([
  Object.freeze({ key: 'agent.temperature', label: '温度', value: 0, reason: '保证评测可比性与确定性基线。' }),
  Object.freeze({ key: 'validator.required', label: 'Official Validator 必需', value: true, reason: '未验证候选不得进入最终可见代码。' }),
  Object.freeze({ key: 'validator.maxInFlight', label: 'Validator 最大并行数', value: 1, reason: '当前单 Java backend 仅允许单槽。' }),
  Object.freeze({ key: 'continuation.maxAutoContinuationsPerLineage', label: '整条任务链自动续跑上限', value: 1, reason: '同一根任务链最多自动续跑一次，禁止形成 A→B→C 链式自动续跑。' }),
  Object.freeze({ key: 'agent.reasoningMode', label: '推理模式', value: 'provider-managed', reason: 'Provider wire contract，不属于运营参数。' })
]);

const BOOTSTRAP_VALUES = Object.freeze(Object.fromEntries(DEFINITIONS.map((definition) => [definition.key, definition.defaultValue])));
const DEFINITION_BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

function integer(key, group, label, defaultValue, minimum, maximum, unit, risk, applyMode, owner, description) {
  if (description === undefined) {
    description = owner;
    owner = defaultOwner(key, group);
  }
  return Object.freeze({ key, group, label, valueType: 'integer', defaultValue, minimum, maximum, step: 1, unit, risk, applyMode, owner, state: 'active', description });
}

function defaultOwner(key, group) {
  if (group === 'api') return 'api';
  if (group === 'provider') return 'provider';
  if (group === 'validator' && !['validator.toolTimeoutMs', 'validator.transientRetryMax'].includes(key)) return 'api-validator';
  return 'teacher';
}

function booleanDefinition(key, group, label, defaultValue, risk, applyMode, owner, description) {
  return Object.freeze({ key, group, label, valueType: 'boolean', defaultValue, risk, applyMode, owner, state: 'active', description });
}

function modelRef(key, label, defaultValue, description) {
  return Object.freeze({
    key,
    group: 'model',
    label,
    valueType: 'model-ref',
    defaultValue,
    risk: 'high',
    applyMode: 'new_run',
    owner: 'teacher',
    state: 'active',
    choiceSource: 'litellm-active-model-groups',
    description
  });
}

function catalog() {
  return {
    schemaVersion: SCHEMA_VERSION,
    groups: GROUPS.map((group) => ({ ...group })),
    definitions: DEFINITIONS.map((definition) => ({ ...definition })),
    hardInvariants: HARD_INVARIANTS.map((item) => ({ ...item }))
  };
}

function validatePolicyValues(input, options = {}) {
  const values = isPlainObject(input) ? input : {};
  const errors = [];
  const warnings = [];
  const normalized = {};
  if (!isPlainObject(input)) errors.push(issue('values', 'POLICY_VALUES_OBJECT_REQUIRED', '策略值必须是对象。'));

  for (const key of Object.keys(values)) {
    if (!DEFINITION_BY_KEY.has(key)) errors.push(issue(key, 'POLICY_FIELD_UNKNOWN', `未知策略字段：${key}`));
  }
  for (const definition of DEFINITIONS) {
    const hasValue = Object.prototype.hasOwnProperty.call(values, definition.key);
    if (!hasValue) {
      if (options.allowPartial === true) continue;
      errors.push(issue(definition.key, 'POLICY_FIELD_REQUIRED', `${definition.label}不能为空。`));
      continue;
    }
    const value = values[definition.key];
    if (definition.valueType === 'model-ref') {
      const alias = String(value || '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,199}$/.test(alias)) {
        errors.push(issue(definition.key, 'POLICY_MODEL_ALIAS_INVALID', `${definition.label}必须引用有效的 LiteLLM Alias。`));
      } else {
        normalized[definition.key] = alias;
        const registeredAliases = normalizedRegisteredAliases(options.modelRegistry);
        if (registeredAliases && !registeredAliases.has(alias)) {
          errors.push(issue(definition.key, 'POLICY_MODEL_ALIAS_NOT_REGISTERED', `${definition.label}引用的 Alias 未在当前 LiteLLM 配置中注册。`));
        }
      }
      continue;
    }
    if (definition.valueType === 'boolean') {
      if (typeof value !== 'boolean') errors.push(issue(definition.key, 'POLICY_FIELD_TYPE', `${definition.label}必须是布尔值。`));
      else normalized[definition.key] = value;
      continue;
    }
    if (!Number.isInteger(value)) {
      errors.push(issue(definition.key, 'POLICY_FIELD_TYPE', `${definition.label}必须是整数。`));
      continue;
    }
    if (value < definition.minimum || value > definition.maximum) {
      errors.push(issue(definition.key, 'POLICY_FIELD_RANGE', `${definition.label}必须在 ${definition.minimum}–${definition.maximum} 之间。`));
      continue;
    }
    normalized[definition.key] = value;
  }

  if (!errors.length || options.collectCrossFieldErrors === true) validateCrossFields(normalized, errors, warnings);
  if (options.baseline && isPlainObject(options.baseline)) {
    for (const definition of DEFINITIONS) {
      if (definition.risk !== 'high') continue;
      if (normalized[definition.key] !== undefined && normalized[definition.key] !== options.baseline[definition.key]) {
        warnings.push(issue(definition.key, 'POLICY_HIGH_RISK_CHANGE', `${definition.label}是高风险变更。`, 'warning'));
      }
    }
  }
  return { ok: errors.length === 0, values: normalized, errors, warnings };
}

function validateCrossFields(values, errors, warnings) {
  compare(values, errors, 'api.outerTimeoutMs', '>', values['run.maxDurationMs'], 'API 外层超时必须大于 Run 最长执行时间。');
  compare(values, errors, 'run.convergeLeadMs', '<', values['run.maxDurationMs'] - values['run.terminalReserveMs'], '收敛提前量必须小于 Run 时限减去终态阶段预留。');
  compare(values, errors, 'run.toolTimeoutMs', '<=', values['run.maxDurationMs'] - values['run.terminalReserveMs'], 'Tool 超时不能超过 Run 可工作窗口。');
  compare(values, errors, 'scope.initialTimeoutMs', '<=', values['scope.reviewTimeoutMs'], '首次筛选超时不能大于独立复核超时。');
  compare(values, errors, 'scope.reviewTimeoutMs', '<=', values['run.toolTimeoutMs'], 'Scope Gate 复核超时不能大于 Tool 超时。');
  compare(values, errors, 'answer.lowMaxOutputTokens', '<=', values['answer.mediumMaxOutputTokens'], 'LOW 回答上限不能大于 MEDIUM。');
  compare(values, errors, 'answer.mediumMaxOutputTokens', '<=', values['answer.highMaxOutputTokens'], 'MEDIUM 回答上限不能大于 HIGH。');
  compare(values, errors, 'answer.highMaxOutputTokens', '<=', values['answer.hardMaxOutputTokens'], 'HIGH 回答上限不能超过硬上限。');
  compare(values, errors, 'repair.maxOutputTokens', '<', values['answer.contextWindowTokens'], 'Repair 单步输出上限必须小于模型上下文窗口。');
  compare(values, errors, 'semanticReview.maxOutputTokens', '<=', values['answer.hardMaxOutputTokens'], '工程语义Review输出上限不能超过单步输出硬上限。');
  compare(values, errors, 'semanticReview.minimumCompleteChainMs', '<', values['run.maxDurationMs'] - values['run.terminalReserveMs'], '完整改进链最小预算必须小于Run可工作窗口。');
  compare(values, errors, 'engineeringRevision.maxDurationMs', '<', values['engineeringImprovement.runMaxDurationMs'] - values['run.terminalReserveMs'], '工程完善Candidate上限必须为Validator、Repair、Verification和终态保留时间。');
  compare(values, errors, 'engineeringRevision.validationRepairReserveMs', '<', values['engineeringImprovement.runMaxDurationMs'] - values['run.terminalReserveMs'], '工程完善后的Validation Repair预留必须小于Improvement工作窗口。');
  compare(values, errors, 'engineeringImprovement.apiOuterTimeoutMs', '>', values['engineeringImprovement.runMaxDurationMs'], 'Improvement API外层超时必须大于Improvement Run时限。');
  compare(values, errors, 'engineeringImprovement.minimumCompleteChainMs', '<=', values['engineeringImprovement.runMaxDurationMs'] - values['run.terminalReserveMs'], 'Improvement完整链最小预算不能超过其工作窗口。');
  compare(values, errors, 'engineeringImprovement.lineageMaxDurationMs', '>=', values['run.maxDurationMs'] + values['engineeringImprovement.runMaxDurationMs'], '自动lineage总时限必须覆盖Primary与Improvement两个Run。');
  compare(values, errors, 'validator.queueWaitMs', '<=', values['validator.toolTimeoutMs'] - values['validator.executionTimeoutMs'], 'Validator 排队等待加执行超时不能超过 Tool 总超时。');
  compare(values, errors, 'validator.toolTimeoutMs', '<', values['run.toolTimeoutMs'], 'Validator Tool 超时必须小于 Agent Tool 超时。');
  compare(values, errors, 'provider.retryBaseMs', '<=', values['provider.retryMaxMs'], 'Provider 退避起点不能大于退避上限。');
  compare(values, errors, 'provider.halfOpenMaxProbes', '<=', values['provider.maxConcurrency'], '半开探测并发不能大于 Provider 最大并发。');
  const engineeringChainMs = values['semanticReview.assessmentTimeoutMs']
    + values['semanticReview.mainDecisionTimeoutMs']
    + values['semanticReview.domainSearchReserveMs']
    + values['engineeringRevision.maxDurationMs']
    + values['validator.toolTimeoutMs']
    + values['engineeringRevision.validationRepairReserveMs']
    + values['semanticReview.verificationTimeoutMs'];
  const engineeringWorkWindowMs = values['engineeringImprovement.runMaxDurationMs']
    - values['engineeringImprovement.orchestrationReserveMs']
    - values['run.terminalReserveMs'];
  if (Number.isFinite(engineeringChainMs)
    && Number.isFinite(engineeringWorkWindowMs)
    && engineeringChainMs > engineeringWorkWindowMs) {
    errors.push(issue(
      'engineeringImprovement.runMaxDurationMs',
      'POLICY_ENGINEERING_CHAIN_BUDGET_CONFLICT',
      'Assessment、Main、Engineering Revision、Validator、Validation Repair 与 Verification 的预算总和不能超过 Improvement 可工作窗口。'
    ));
  }
  const reservedMs = values['run.terminalReserveMs']
    + values['validator.toolTimeoutMs']
    + values['repair.phaseReserveMs'];
  if (Number.isFinite(reservedMs) && Number.isFinite(values['run.maxDurationMs'])) {
    if (reservedMs >= values['run.maxDurationMs']) {
      errors.push(issue(
        'repair.phaseReserveMs',
        'POLICY_RUN_PHASE_RESERVE_CONFLICT',
        '终态、Validator 与 Repair 预留之和必须小于 Run 最长执行时间。'
      ));
    }
    const candidateWindowMs = Math.min(
      values['candidate.maxAttemptMs'],
      values['run.maxDurationMs'] - reservedMs
    );
    if (!Number.isFinite(candidateWindowMs) || candidateWindowMs <= 0) {
      errors.push(issue(
        'candidate.maxAttemptMs',
        'POLICY_CANDIDATE_DEADLINE_UNAVAILABLE',
        '当前阶段预留无法为 Candidate 留出有效执行窗口。'
      ));
    }
  }
  if (values['scope.enabled'] === false) warnings.push(issue('scope.enabled', 'POLICY_SCOPE_GATE_DISABLED', 'Scope Gate 将关闭；授权和安全硬门仍保持。', 'warning'));
  if (values['candidate.repairEnabled'] === false) warnings.push(issue('candidate.repairEnabled', 'POLICY_REPAIR_DISABLED', 'Repair 将关闭；Validator FAIL 不会绕过。', 'warning'));
}

function compare(values, errors, key, operator, right, message) {
  const left = values[key];
  if (!Number.isFinite(left) || !Number.isFinite(right)) return;
  const ok = operator === '<'
    ? left < right
    : operator === '>'
      ? left > right
      : operator === '>='
        ? left >= right
        : left <= right;
  if (!ok) errors.push(issue(key, 'POLICY_CROSS_FIELD_CONFLICT', message));
}

function issue(key, code, message, severity = 'error') {
  return { key, code, message, severity };
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  throw new TypeError('Policy value is not JSON serializable.');
}

function checksumPolicyValues(values) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex')}`;
}

function createPolicySnapshot({ versionId, values, frozenAt = new Date().toISOString() } = {}) {
  const validation = validatePolicyValues(values);
  if (!validation.ok) {
    const error = new Error('Agent resource policy is invalid.');
    error.code = 'AGENT_RESOURCE_POLICY_INVALID';
    error.statusCode = 400;
    error.details = validation;
    throw error;
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    versionId: String(versionId || '').trim() || `arp_bootstrap_v${SCHEMA_VERSION}`,
    checksum: checksumPolicyValues(validation.values),
    values: Object.freeze({ ...validation.values }),
    frozenAt
  });
}

function validatePolicySnapshot(snapshot) {
  const errors = [];
  if (!isPlainObject(snapshot)) return { ok: false, errors: [issue('snapshot', 'POLICY_SNAPSHOT_REQUIRED', '资源策略快照不能为空。')], warnings: [] };
  if (snapshot.schemaVersion !== SCHEMA_VERSION) errors.push(issue('schemaVersion', 'POLICY_SCHEMA_VERSION_INVALID', '资源策略 Schema 版本不受支持。'));
  if (!/^arp_[a-zA-Z0-9_-]{3,120}$/.test(String(snapshot.versionId || ''))) errors.push(issue('versionId', 'POLICY_VERSION_ID_INVALID', '资源策略版本 ID 无效。'));
  const validation = validatePolicyValues(snapshot.values);
  const expectedChecksum = validation.ok ? checksumPolicyValues(validation.values) : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(String(snapshot.checksum || '')) || snapshot.checksum !== expectedChecksum) {
    errors.push(issue('checksum', 'POLICY_CHECKSUM_MISMATCH', '资源策略 checksum 不匹配。'));
  }
  return { ok: errors.length === 0 && validation.ok, values: validation.values, errors: [...validation.errors, ...errors], warnings: validation.warnings };
}

function runtimeProjection(values) {
  const validation = validatePolicyValues(values);
  if (!validation.ok) {
    const error = new Error('Cannot project an invalid Agent resource policy.');
    error.code = 'AGENT_RESOURCE_POLICY_INVALID';
    error.details = validation;
    throw error;
  }
  const v = validation.values;
  return Object.freeze({
    api: Object.freeze({
      outerTimeoutMs: v['api.outerTimeoutMs']
    }),
    teacher: Object.freeze({
      agentMaxSteps: v['run.maxSteps'],
      agentMaxDurationMs: v['run.maxDurationMs'],
      agentTerminalReserveMs: v['run.terminalReserveMs'],
      agentConvergeLeadMs: v['run.convergeLeadMs'],
      agentToolTimeoutMs: v['run.toolTimeoutMs'],
      agentTerminalPersistenceTimeoutMs: v['run.terminalPersistTimeoutMs'],
      agentMaxOutputTokens: v['answer.hardMaxOutputTokens'],
      agentContextWindowTokens: v['answer.contextWindowTokens'],
      agentScopeGateEnabled: v['scope.enabled'],
      agentScopeGateInitialTimeoutMs: v['scope.initialTimeoutMs'],
      agentScopeGateReviewTimeoutMs: v['scope.reviewTimeoutMs'],
      agentScopeGateMaxOutputTokens: v['scope.maxOutputTokens'],
      agentCandidateRecoveryMaxAttempts: v['candidate.recoveryMaxAttempts'],
      agentCandidateMaxAttemptMs: v['candidate.maxAttemptMs'],
      agentCandidateRepairEnabled: v['candidate.repairEnabled'],
      agentRepairPhaseReserveMs: v['repair.phaseReserveMs'],
      agentRepairMaxOutputTokens: v['repair.maxOutputTokens'],
      agentSemanticReviewEnabled: v['semanticReview.enabled'],
      agentSemanticReviewShadowOnly: v['semanticReview.shadowOnly'],
      agentSemanticReviewAssessmentMaxCalls: v['semanticReview.assessmentMaxCalls'],
      agentSemanticReviewAssessmentTimeoutMs: v['semanticReview.assessmentTimeoutMs'],
      agentSemanticReviewMainDecisionTimeoutMs: v['semanticReview.mainDecisionTimeoutMs'],
      agentSemanticReviewVerificationMaxCalls: v['semanticReview.verificationMaxCalls'],
      agentSemanticReviewVerificationTimeoutMs: v['semanticReview.verificationTimeoutMs'],
      agentSemanticReviewMaxOutputTokens: v['semanticReview.maxOutputTokens'],
      agentSemanticReviewMaxIssues: v['semanticReview.maxIssues'],
      agentSemanticReviewMinimumCompleteChainMs: v['semanticReview.minimumCompleteChainMs'],
      agentSemanticReviewDomainSearchReserveMs: v['semanticReview.domainSearchReserveMs'],
      agentEngineeringRevisionMaxCycles: v['engineeringRevision.maxCycles'],
      agentEngineeringRevisionMaxDurationMs: v['engineeringRevision.maxDurationMs'],
      agentEngineeringRevisionValidationRepairReserveMs: v['engineeringRevision.validationRepairReserveMs'],
      agentEngineeringImprovementRunMaxDurationMs: v['engineeringImprovement.runMaxDurationMs'],
      agentEngineeringImprovementApiOuterTimeoutMs: v['engineeringImprovement.apiOuterTimeoutMs'],
      agentEngineeringImprovementLineageMaxDurationMs: v['engineeringImprovement.lineageMaxDurationMs'],
      agentEngineeringImprovementOrchestrationReserveMs: v['engineeringImprovement.orchestrationReserveMs'],
      agentEngineeringImprovementMinimumCompleteChainMs: v['engineeringImprovement.minimumCompleteChainMs'],
      agentValidatorToolTimeoutMs: v['validator.toolTimeoutMs'],
      agentMaxUniqueCandidateValidationsPerWorker: v['candidate.maxValidatorCallsPerWorker'],
      agentReviewedKnowledgeMaxNewQueriesPerRun: v['knowledge.reviewedMaxNewQueriesPerRun'],
      agentLowAnswerMaxOutputTokens: v['answer.lowMaxOutputTokens'],
      agentMediumAnswerMaxOutputTokens: v['answer.mediumMaxOutputTokens'],
      agentHighAnswerMaxOutputTokens: v['answer.highMaxOutputTokens'],
      agentTemperature: 0,
      agentReasoningMode: 'provider-managed',
      agentStageModelRoutes: Object.freeze({
        fastGate: v['model.fastRoute'],
        main: v['model.mainRoute'],
        candidate: v['model.candidateRoute'],
        repair: v['model.repairRoute'],
        semanticReview: v['model.semanticReviewRoute'],
        finalizer: v['model.finalizerRoute']
      })
    }),
    validator: Object.freeze({
      maxInFlight: 1,
      queueLimit: v['validator.queueLimit'],
      queueWaitMs: v['validator.queueWaitMs'],
      executionTimeoutMs: v['validator.executionTimeoutMs'],
      toolTimeoutMs: v['validator.toolTimeoutMs'],
      transientRetryMax: v['validator.transientRetryMax']
    }),
    provider: Object.freeze({
      maxConcurrency: v['provider.maxConcurrency'],
      queueLimit: v['provider.queueLimit'],
      queueTimeoutMs: v['provider.queueTimeoutMs'],
      maxRetries: v['provider.maxRetries'],
      retryJitter: v['provider.retryJitter'],
      retryBaseMs: v['provider.retryBaseMs'],
      retryMaxMs: v['provider.retryMaxMs'],
      circuitFailureThreshold: v['provider.circuitFailureThreshold'],
      circuitFailureWindowMs: v['provider.circuitFailureWindowMs'],
      circuitOpenMs: v['provider.circuitOpenMs'],
      halfOpenMaxProbes: v['provider.halfOpenMaxProbes'],
      contextWindowTokens: v['answer.contextWindowTokens'],
      hardMaxTier: v['answer.hardMaxOutputTokens']
    }),
    probe: Object.freeze({
      enabled: v['probe.enabled'],
      hourlyLimit: v['probe.hourlyLimit'],
      timeoutMs: v['probe.timeoutMs']
    })
  });
}

function diffPolicyValues(before = {}, after = {}) {
  return DEFINITIONS.flatMap((definition) => {
    if (before[definition.key] === after[definition.key]) return [];
    return [{ key: definition.key, label: definition.label, before: before[definition.key], after: after[definition.key], risk: definition.risk, owner: definition.owner, applyMode: definition.applyMode }];
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedRegisteredAliases(modelRegistry) {
  if (!modelRegistry) return null;
  const source = Array.isArray(modelRegistry)
    ? modelRegistry
    : Array.isArray(modelRegistry.aliases)
      ? modelRegistry.aliases
      : Array.isArray(modelRegistry.profiles)
        ? modelRegistry.profiles.map((profile) => profile?.litellmAlias || profile?.alias)
        : [];
  return new Set(source.map((value) => String(value || '').trim()).filter(Boolean));
}

module.exports = {
  SCHEMA_VERSION,
  GROUPS,
  DEFINITIONS,
  HARD_INVARIANTS,
  BOOTSTRAP_VALUES,
  catalog,
  validatePolicyValues,
  validatePolicySnapshot,
  checksumPolicyValues,
  createPolicySnapshot,
  runtimeProjection,
  diffPolicyValues,
  canonicalJson
};
