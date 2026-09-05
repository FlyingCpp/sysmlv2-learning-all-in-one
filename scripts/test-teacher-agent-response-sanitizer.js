const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateTeacherCapabilityResponse } = require('../packages/teacher-contract');

const hashContent = (value) => `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;

const facts = (modelText) => ({
  modelText,
  finishReason: 'stop',
  stepCount: 1,
  invalidToolCallCount: 0,
  stopReason: 'completed',
  usage: {},
});

const validationEntry = (output, canonicalArgs = '{}') => ({
  sequence: 0,
  toolCallId: 'validator-terminal',
  toolName: 'validate_candidate_workspace',
  canonicalArgs,
  argsHash: `sha256:${'b'.repeat(64)}`,
  status: 'succeeded',
  replayCount: 0,
  startedAt: '2026-07-17T00:00:00.000Z',
  finishedAt: '2026-07-17T00:00:01.000Z',
  output,
});

const failedValidation = {
  validator: {
    authority: 'official-sysml-v2-validator',
    version: 'test-validator/failed',
    evidenceHash: `sha256:${'c'.repeat(64)}`,
  },
  official: { syntax: 'failed', semantic: 'not_run', diagnostics: [] },
  courseRuleApplicability: 'not_applicable',
  completeness: 'complete',
  candidateWorkspaceHash: `sha256:${'d'.repeat(64)}`,
  patches: [],
};

const passedValidation = {
  validator: {
    authority: 'official-sysml-v2-validator',
    version: 'test-validator/passed',
    evidenceHash: `sha256:${'e'.repeat(64)}`,
  },
  official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
  courseRuleApplicability: 'not_applicable',
  completeness: 'complete',
  candidateWorkspaceHash: `sha256:${'f'.repeat(64)}`,
  patches: [],
};

async function main() {
  const {
    assembleTrustedResponse,
    detectInternalOrchestrationNarration,
    sanitizeInternalOrchestrationNarration,
    stripInternalSourceMarkers
  } = await import('../apps/teacher/dist/agent/agent-response.mjs');
  const {
    enforceValidatedCodeAnswerForTests,
    isDeliverableAgentOutcomeForTests,
    projectPublicRepairActivityForTests,
    summarizePublicValidatorActivityForTests,
    trustedOutcomeToTeacherResponseForTests
  } = require('../apps/teacher/agent-adapter');

  const explanationWithUnsafeParagraph = [
    '已保留通过验证的模型，但温度比较与状态记忆仍未完成。',
    '**Definition 与 Usage**\n- `part sensor : TemperatureSensor` 等写在 `HomeThermostatSystem` 内部，是 **Usage**。\n- 真正的实例是 Usage 的值，模型里最靠近实例的是顶层的 `part homeThermostat : HomeThermostatSystem`。具体数值在这个最小模型里并未建模。',
    'part unsafe : MissingType;',
    '模型声明需要工具解析或仿真，Validator通过不表示已经运行控制逻辑。'
  ].join('\n\n');
  const explanationDelivery = enforceValidatedCodeAnswerForTests({
    validatedCandidateDelivery: {
      version: 'validated-candidate-delivery-v1',
      candidate: { mode: 'standalone_model', fileName: 'Verified.sysml', content: 'package Verified;' },
      validation: passedValidation,
      deliveryTarget: { fileId: 'standalone_model', displayName: 'Verified.sysml' }
    },
    response: { answer: explanationWithUnsafeParagraph }
  }, {}, new Map());
  assert(explanationDelivery.answer.includes('温度比较与状态记忆仍未完成'),
    '一个不安全段落不能吞掉已知限制');
  assert(explanationDelivery.answer.includes('Validator通过不表示已经运行控制逻辑'),
    '必须保留可安全交付的解释');
  assert.doesNotMatch(explanationDelivery.answer, /part unsafe/u);
  assert.equal((explanationDelivery.answer.match(/```sysml/g) || []).length, 1);
  assert(explanationDelivery.answer.includes('```sysml\npackage Verified;\n```'));

  assert.deepEqual(
    summarizePublicValidatorActivityForTests({
      validation: {
        ...failedValidation,
        official: {
          ...failedValidation.official,
          diagnostics: Array.from({ length: 9 }, (_, index) => ({
            severity: 'error',
            code: `E${index + 1}`,
            message: `diagnostic-${index + 1}`
          }))
        },
        diagnosticSummary: { total: 9, included: 9, truncated: false }
      }
    }),
    { count: 9, message: '官方 Validator 检查未通过，发现 9 个问题。' },
    'Validator公开状态必须使用真实ValidationOutput并明确显示失败问题数'
  );
  assert.deepEqual(
    projectPublicRepairActivityForTests({
      phase: 'validation_failed',
      round: 1,
      maxRounds: 3,
      diagnosticCount: 5
    }),
    {
      activityId: 'repair-1',
      kind: 'repair',
      status: 'complete',
      message: '第 1/3 轮修复已完成，剩余 5 个问题。',
      count: 5
    },
    'Repair公开状态必须显示当前轮次、总轮次和剩余问题数'
  );
  assert.equal(
    projectPublicRepairActivityForTests({ phase: 'started', round: 2, maxRounds: 3 }).message,
    '正在进行第 2/3 轮修复。',
    '下一轮Repair开始时不得继续停留在Validator已完成状态'
  );

  assert.throws(
    () => assembleTrustedResponse(facts(''), []),
    /requires non-empty model text/u,
    'a completed run must never publish a placeholder for an empty provider completion'
  );
  const pendingFinalization = assembleTrustedResponse(facts(''), [], { pendingFinalization: true });
  assert.equal(pendingFinalization.answer, '',
    'Main待终末响应允许空草稿，但不得生成可见占位正文');
  assert.throws(
    () => assembleTrustedResponse({ ...facts(''), stopReason: 'provider_error' }, [], { pendingFinalization: true }),
    /requires completed Main orchestration/u,
    'pendingFinalization只能用于已接受终末动作的Main编排边界'
  );
  assert.equal(
    stripInternalSourceMarkers('可见回答 [source:claim-internal-only, claim-second]。'),
    '可见回答。',
    'internal source markers must not leak from feedback revisions into student-visible answers'
  );
  assert.equal(
    stripInternalSourceMarkers('语义解释。 **[来源：claim-redefinition, ev-specialization]**'),
    '语义解释。',
    'localized internal Claim/Evidence markers must not leak into student-visible answers'
  );
  assert.equal(
    stripInternalSourceMarkers('公开规范引用 [OMG SysML v2, 8.3.3] 应保留。'),
    '公开规范引用 [OMG SysML v2, 8.3.3] 应保留。',
    'ordinary public citations must not be removed'
  );
  assert.equal(
    sanitizeInternalOrchestrationNarration(
      '我应该委派delegate_candidate，mode=refine。'
    ),
    '当前回答混入了不能向学生展示的内部处理信息，因此没有作为正式说明返回。',
    'a prose delegation pseudo-call must never become student-visible even if Main continuation is exhausted'
  );
  assert.deepEqual(
    detectInternalOrchestrationNarration('我应该调用候选生成工具，模式为创建。'),
    { actions: ['candidate'], hasGenericPlanningNarration: false },
    '中文同义的候选动作叙述必须绑定到候选Tool类型'
  );
  assert.deepEqual(
    detectInternalOrchestrationNarration('这是一个建模请求，我应该委派candidate，mode为refine。'),
    { actions: ['candidate'], hasGenericPlanningNarration: false },
    'DeepSeek中英混写的candidate伪调用必须归一到同一动作类型'
  );
  const leakedPlanning = '学生说“动力与供电系统，就按这个来”。我认为这里不需要新的委派，我应该确认，我直接确认即可。';
  assert.equal(
    detectInternalOrchestrationNarration(leakedPlanning).hasGenericPlanningNarration,
    true,
    '学生转述与Main内部决策链不能被当成学生回答'
  );
  const conciseLeakedPlanning = '当前模型文件存在且无诊断问题。学生确认“动力与供电系统，就按这个来”，即沿用现有模型。模型已经建立并验证，无需新的委派。\n\n直接确认即可。';
  assert.equal(
    sanitizeInternalOrchestrationNarration(conciseLeakedPlanning),
    '当前回答混入了不能向学生展示的内部处理信息，因此没有作为正式说明返回。',
    'Runner6的简短“学生确认 + 无需委派 + 直接确认”变体也必须隔离'
  );
  assert.equal(
    sanitizeInternalOrchestrationNarration(leakedPlanning),
    '当前回答混入了不能向学生展示的内部处理信息，因此没有作为正式说明返回。',
    '续跑资源耗尽时仍必须在公开层确定性隔离内部规划'
  );

  // Deterministic response assembly must not decide whether a natural-language claim is true.
  // The independent Judge receives this exact visible text and owns that semantic decision.
  const unsupportedClaim = '只能说当前证据不足，不过验证器已通过；仍需人工复核需求意图。';
  const unsupported = assembleTrustedResponse(facts(unsupportedClaim), []);
  assert.equal(unsupported.validatorStatus, 'not_validated');
  assert.equal(unsupported.answer, unsupportedClaim);
  assert(!unsupported.warnings.includes('unverified_validation_claim_removed'));

  const failedClaim = '官方校验失败，不过 validatorStatus=validated_passed 只代表语法没问题；请继续修复。';
  const failed = assembleTrustedResponse(facts(failedClaim), [validationEntry(failedValidation)]);
  assert.equal(failed.validatorStatus, 'validated_failed');
  assert.equal(failed.answer, failedClaim);

  const cited = assembleTrustedResponse(facts(
    `定义和用法需要按端点关系解释。[source:skill_${'a'.repeat(24)}]`,
  ), []);
  assert.equal(cited.answer, '定义和用法需要按端点关系解释。');

  const noFocus = assembleTrustedResponse(facts('这里给出概念解释。'), [], {
    grounding: { kind: 'none', reason: 'no_focus' },
  });
  assert.match(noFocus.answer, /^根据你的描述，当前没有可信代码选区/u);
  assert.match(noFocus.answer, /这里给出概念解释/u);

  const passed = assembleTrustedResponse(facts(
    '候选代码已经由终末 Validator 工具结果绑定。',
  ), [validationEntry(passedValidation)]);
  assert.equal(passed.validatorStatus, 'validated_passed');
  assert.equal(passed.answer, '候选代码已经由终末 Validator 工具结果绑定。');
  assert.doesNotMatch(passed.answer, /服务端验证状态/u,
    'Validator可信状态应通过响应字段承载，不得作为内部状态段落拼进学生正文');

  const courseAdvisoryFailed = assembleTrustedResponse(facts(
    '候选代码通过官方验证，课程规则差距留给工程Review。',
  ), [validationEntry({
    ...passedValidation,
    courseRuleApplicability: 'applicable',
    courseRules: {
      status: 'failed',
      diagnostics: [{ severity: 'error', code: 'COURSE_EXPECTATION', message: '课程目标尚未全部覆盖。' }],
    },
  })]);
  assert.equal(courseAdvisoryFailed.validatorStatus, 'validated_passed',
    '课程规则失败不得覆盖Official Validator PASS状态');

  const safelyDegraded = trustedOutcomeToTeacherResponseForTests({
    ok: true,
    ledger: [],
    response: {
      answer: '概念解释仍可交付。\n\n```sysml\npart unsafe : MissingType;\n```',
      answerMode: 'result_bound_v2',
      answerCompletionStatus: 'complete',
      confidenceCap: 'medium',
      evidence: [],
      patches: [],
      stepCount: 1,
      stopReason: 'completed',
      usage: {},
      validatorStatus: 'not_validated',
      warnings: []
    }
  }, { requestId: 'post-validation-degradation-test' }, new Map());
  assert(safelyDegraded.directAnswer.length > 0, 'safe post-validation projection must still return a visible answer');
  assert.doesNotMatch(safelyDegraded.directAnswer, /part unsafe/u);
  assert(safelyDegraded.warnings.includes('post_validation_answer_safely_degraded'));
  assert(safelyDegraded.warnings.includes('unvalidated_or_unbound_code_withheld'));

  const resumedCandidateContent = 'package Recovered {\n  part def Vehicle;\n}';
  const resumedCandidateInput = {
    mode: 'standalone_model',
    fileName: 'Recovered.sysml',
    content: resumedCandidateContent
  };
  const resumedWorkspaceHash = hashContent(
    `standalone/Recovered.sysml\n${hashContent(resumedCandidateContent)}`
  );
  const resumedValidation = {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: `2026-04/0.59.0/sha256:${'a'.repeat(64)}`,
      evidenceHash: `sha256:${'9'.repeat(64)}`
    },
    official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash: resumedWorkspaceHash,
    patches: []
  };
  const resumedDelivery = trustedOutcomeToTeacherResponseForTests({
    ok: true,
    mainAgentOutcome: {
      type: 'resume_execution',
      action: 'finalizer',
      acceptedToolCallId: 'resume-finalizer'
    },
    validatedCandidateDelivery: {
      version: 'validated-candidate-delivery-v1',
      runId: 'run_resume_delivery',
      taskId: 'task_resume_delivery',
      taskRevision: 1,
      candidate: resumedCandidateInput,
      validation: resumedValidation,
      deliveryTarget: {
        kind: 'standalone_model',
        fileId: 'standalone_model',
        displayName: 'Recovered.sysml'
      }
    },
    ledger: [validationEntry(resumedValidation, JSON.stringify(resumedCandidateInput))],
    response: {
      answer: '修复已经完成，候选模型已通过官方 Validator。',
      answerMode: 'result_bound_v2',
      answerCompletionStatus: 'complete',
      confidenceCap: 'high',
      evidence: [],
      patches: [],
      stepCount: 1,
      stopReason: 'completed',
      usage: {},
      validatorStatus: 'validated_passed',
      validation: resumedValidation,
      candidateWorkspaceHash: resumedWorkspaceHash,
      warnings: []
    }
  }, { requestId: 'resumed-candidate-delivery-test' }, new Map());
  assert.match(resumedDelivery.directAnswer, /```sysml\npackage Recovered/u,
    '续跑完成后必须从 ValidatedCandidateDelivery 直出完整候选代码块');
  assert.equal(resumedDelivery.validatorStatus, 'validated_passed');
  assert.equal(resumedDelivery.candidateDeliveryStatus, 'changed_delivered');
  assert.equal(resumedDelivery.answerCompletionStatus, 'complete');
  assert.equal(resumedDelivery.candidateAttestation.codeBlockContentHashes.length, 1,
    '续跑的Validator PASS不得形成零代码块attestation');
  assert(resumedDelivery.warnings.includes('validated_candidate_rendered_from_delivery'));

  const emptyAttestationContract = validateTeacherCapabilityResponse({
    ...resumedDelivery,
    candidateAttestation: {
      ...resumedDelivery.candidateAttestation,
      codeBlockContentHashes: []
    },
    codeBlockValidations: []
  }, { requestId: 'resumed-candidate-delivery-test' });
  assert(emptyAttestationContract.errors?.includes(
    'candidateAttestation.codeBlockContentHashes must contain at least one sha256 hash'
  ), '公共Validator attestation必须拒绝零代码块集合');

  const unchangedContent = 'package Stable { part def Vehicle; }';
  const unchangedFile = {
    fileId: 'file_stable',
    displayName: 'main.sysml',
    workspacePath: 'main.sysml',
    content: unchangedContent,
    contentHash: hashContent(unchangedContent),
    editable: true
  };
  const unchangedWorkspaceHash = hashContent(`main.sysml\n${hashContent(unchangedContent)}`);
  const unchangedValidation = {
    ...resumedValidation,
    candidateWorkspaceHash: unchangedWorkspaceHash,
    validator: { ...resumedValidation.validator, evidenceHash: `sha256:${'8'.repeat(64)}` }
  };
  const unchangedDelivery = trustedOutcomeToTeacherResponseForTests({
    ok: true,
    validatedCandidateDelivery: {
      version: 'validated-candidate-delivery-v1',
      runId: 'run_no_change',
      taskId: 'task_no_change',
      taskRevision: 1,
      candidate: {
        mode: 'replace_entry',
        fileId: unchangedFile.fileId,
        baseHash: unchangedFile.contentHash,
        content: unchangedContent
      },
      validation: unchangedValidation,
      deliveryTarget: {
        kind: 'no_change',
        fileId: unchangedFile.fileId,
        displayName: unchangedFile.displayName
      }
    },
    ledger: [validationEntry(unchangedValidation, JSON.stringify({
      mode: 'replace_entry',
      fileId: unchangedFile.fileId,
      baseHash: unchangedFile.contentHash,
      content: unchangedContent
    }))],
    response: {
      answer: '检查完成，当前模型不需要修改。',
      answerMode: 'result_bound_v2',
      answerCompletionStatus: 'complete',
      confidenceCap: 'high',
      evidence: [],
      patches: [],
      stepCount: 1,
      stopReason: 'completed',
      usage: {},
      validatorStatus: 'validated_passed',
      validation: unchangedValidation,
      candidateWorkspaceHash: unchangedWorkspaceHash,
      mainAgentDelegation: { action: 'repair' },
      warnings: []
    }
  }, { requestId: 'single-file-no-change-test' }, new Map([
    [unchangedFile.fileId, unchangedFile]
  ]));
  assert.equal(unchangedDelivery.candidateDeliveryStatus, 'no_change');
  assert.equal(unchangedDelivery.answerCompletionStatus, 'complete');
  assert.equal(unchangedDelivery.validatorStatus, 'validated_passed');
  assert.equal(unchangedDelivery.candidateAttestation.codeBlockContentHashes.length, 1);
  assert.match(unchangedDelivery.directAnswer, /```sysml\npackage Stable/u,
    '单文件no-change仍交付已验证完整文件，避免空attestation');

  const crlfBase = 'package LineEnding {\r\n  part def Vehicle;\r\n}\r\n';
  const lfCandidate = 'package LineEnding {\n  part def Vehicle;\n}\n';
  const lineEndingFile = {
    fileId: 'file_line_ending',
    displayName: 'main.sysml',
    workspacePath: 'main.sysml',
    content: crlfBase,
    contentHash: hashContent(crlfBase),
    editable: true
  };
  const lineEndingWorkspaceHash = hashContent(`main.sysml\n${hashContent(lfCandidate)}`);
  const lineEndingValidation = {
    ...resumedValidation,
    candidateWorkspaceHash: lineEndingWorkspaceHash,
    patches: [{
      fileId: lineEndingFile.fileId,
      baseHash: lineEndingFile.contentHash,
      candidateHash: hashContent(lfCandidate),
      kind: 'replace_entry'
    }],
    validator: { ...resumedValidation.validator, evidenceHash: `sha256:${'6'.repeat(64)}` }
  };
  const lineEndingDelivery = trustedOutcomeToTeacherResponseForTests({
    ok: true,
    validatedCandidateDelivery: {
      version: 'validated-candidate-delivery-v1',
      runId: 'run_line_ending',
      taskId: 'task_line_ending',
      taskRevision: 1,
      candidate: {
        mode: 'replace_entry',
        fileId: lineEndingFile.fileId,
        baseHash: lineEndingFile.contentHash,
        content: lfCandidate
      },
      validation: lineEndingValidation,
      deliveryTarget: {
        kind: 'changed_file',
        fileId: lineEndingFile.fileId,
        displayName: lineEndingFile.displayName
      }
    },
    ledger: [validationEntry(lineEndingValidation, JSON.stringify({
      mode: 'replace_entry',
      fileId: lineEndingFile.fileId,
      baseHash: lineEndingFile.contentHash,
      content: lfCandidate
    }))],
    response: {
      answer: '候选已完成并通过官方 Validator。',
      answerMode: 'result_bound_v2',
      answerCompletionStatus: 'complete',
      confidenceCap: 'high',
      evidence: [],
      patches: [],
      stepCount: 1,
      stopReason: 'completed',
      usage: {},
      validatorStatus: 'validated_passed',
      validation: lineEndingValidation,
      candidateWorkspaceHash: lineEndingWorkspaceHash,
      mainAgentDelegation: { action: 'candidate' },
      warnings: []
    }
  }, { requestId: 'line-ending-only-patch-test' }, new Map([
    [lineEndingFile.fileId, lineEndingFile]
  ]));
  assert.equal(lineEndingDelivery.candidateDeliveryStatus, 'changed_delivered',
    'CRLF到LF仍是Validator Hash绑定的真实Patch，不得按展示规范化误判为no-change');
  assert.equal(lineEndingDelivery.validatorStatus, 'validated_passed');
  assert.match(lineEndingDelivery.directAnswer, /```sysml\npackage LineEnding/u);

  const multiFiles = [
    {
      fileId: 'file_a', displayName: 'a.sysml', workspacePath: 'a.sysml',
      content: 'package A {}', contentHash: hashContent('package A {}'), editable: true
    },
    {
      fileId: 'file_b', displayName: 'b.sysml', workspacePath: 'b.sysml',
      content: 'package B {}', contentHash: hashContent('package B {}'), editable: true
    }
  ];
  const multiCandidateFiles = [
    { fileId: 'file_a', baseHash: multiFiles[0].contentHash, content: 'package A { part def A1; }' },
    { fileId: 'file_b', baseHash: multiFiles[1].contentHash, content: 'package B { part def B1; }' }
  ];
  const multiWorkspaceHash = hashContent([
    `a.sysml\n${hashContent(multiCandidateFiles[0].content)}`,
    `b.sysml\n${hashContent(multiCandidateFiles[1].content)}`
  ].join('\n'));
  const multiPatches = multiCandidateFiles.map((candidate) => ({
    fileId: candidate.fileId,
    baseHash: candidate.baseHash,
    candidateHash: hashContent(candidate.content),
    kind: 'workspace_files'
  }));
  const multiValidation = {
    ...resumedValidation,
    candidateWorkspaceHash: multiWorkspaceHash,
    patches: multiPatches,
    validator: { ...resumedValidation.validator, evidenceHash: `sha256:${'7'.repeat(64)}` }
  };
  const multiDelivery = trustedOutcomeToTeacherResponseForTests({
    ok: true,
    mainAgentOutcome: {
      type: 'resume_execution',
      action: 'finalizer',
      acceptedToolCallId: 'resume-multi-file-finalizer'
    },
    ledger: [validationEntry(multiValidation, JSON.stringify({
      mode: 'workspace_files', files: multiCandidateFiles
    }))],
    response: {
      answer: '两个文件都已经修正并通过 Validator。',
      answerMode: 'result_bound_v2',
      answerCompletionStatus: 'complete',
      confidenceCap: 'high',
      evidence: [],
      patches: [],
      stepCount: 1,
      stopReason: 'completed',
      usage: {},
      validatorStatus: 'validated_passed',
      validation: multiValidation,
      candidateWorkspaceHash: multiWorkspaceHash,
      warnings: []
    }
  }, { requestId: 'multi-file-safe-rejection-test' }, new Map(
    multiFiles.map((file) => [file.fileId, file])
  ));
  assert.equal(multiDelivery.candidateDeliveryStatus, 'incomplete');
  assert.equal(multiDelivery.answerCompletionStatus, 'incomplete');
  assert.equal(multiDelivery.validatorStatus, 'not_validated');
  assert.equal(multiDelivery.candidateAttestation, undefined);
  assert(multiDelivery.warnings.includes('candidate_delivery_incomplete:validated_delivery_missing'),
    '多文件 Candidate 不得由 Ledger 重建；缺少 delivery 时必须 incomplete');

  assert.equal(isDeliverableAgentOutcomeForTests({
    ok: false,
    response: { answer: '服务端已经形成安全说明。', stopReason: 'policy_violation' }
  }), true, 'an internal status flag must not discard an already formed safe answer');
  assert.equal(isDeliverableAgentOutcomeForTests({
    ok: false,
    response: { answer: '迟到回答', stopReason: 'cancelled' }
  }), false, 'caller cancellation must not deliver a late answer');
  assert.equal(isDeliverableAgentOutcomeForTests({
    ok: false,
    response: { answer: '', stopReason: 'provider_error' }
  }), false, 'a run without a trusted visible answer must preserve the public error path');

  console.log('teacher agent deterministic response assembly tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
