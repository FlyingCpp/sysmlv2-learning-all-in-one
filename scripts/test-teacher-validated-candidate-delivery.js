'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('path');

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function request(runId) {
  const content = 'package Demo {\r\n  part def Vehicle;\r\n}';
  return {
    runId,
    question: '生成一个最小车辆模型。',
    currentStudentQuestion: '生成一个最小车辆模型。',
    capabilityGrant: ['validate_candidate_workspace'],
    context: {
      tenantId: 'tenant-delivery', userId: 'user-delivery', threadId: 'thread-delivery',
      lesson: { courseId: 'course-d', lessonId: 'lesson-d', title: 'Delivery', objectives: [], taskHints: [] },
      model: {
        files: [{
          fileId: 'file-d', displayName: 'model.sysml', content,
          contentHash: hash(content), editable: true
        }],
        entryFileId: 'file-d', activeFileId: 'file-d', diagnostics: []
      }
    }
  };
}

async function main() {
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  const adapter = require('../apps/teacher/agent-adapter.js');
  const adapterSource = fs.readFileSync(
    path.join(__dirname, '../apps/teacher/agent-adapter.js'),
    'utf8'
  );
  assert(!adapterSource.includes('function terminalValidatedCandidateBinding'),
    'Slice 4: terminalValidatedCandidateBinding must be deleted from the adapter');
  assert(!adapterSource.includes('function candidateRecordsFromLedger'),
    'Slice 4: candidateRecordsFromLedger must be deleted from the adapter');
  assert(!/finalizeVisibleAnswer[\s\S]{0,800}terminalValidatedCandidateBinding/.test(adapterSource));

  runtime.resetDeliveryTelemetry();
  const parsed = runtime.agentRunRequestSchema.parse(request('run_delivery_factory'));
  const resources = runtime.createRunResources({
    request: parsed,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const outcome = {
    type: 'delegate_candidate', mode: 'create', subject: 'current_workspace', acceptedToolCallId: 'delivery-delegation'
  };
  const task = resources.tasks.materialize({
    questionHash: resources.input.questionHash, outcome, context: parsed.context
  });
  const running = resources.tasks.transition(task.taskId, task.revision, { type: 'worker_started' });
  const view = runtime.projectWorkerTaskView(resources, running);
  const lfContent = 'package Demo {\n  part def Vehicle;\n  part vehicle : Vehicle;\n}';
  const candidate = {
    mode: 'replace_entry', fileId: view.target.fileId, baseHash: view.target.baseHash, content: lfContent
  };
  const workspaceHash = runtime.computeCandidateWorkspaceHash(view, candidate);
  const validation = {
    validator: {
      authority: 'official-sysml-v2-validator', version: 'test', evidenceHash: hash('evidence-delivery')
    },
    official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash: workspaceHash,
    patches: []
  };
  const beforeHashCount = runtime.getDeliveryTelemetry().workspaceHashComputeCount;
  const workerResult = runtime.createValidatedPassedResult({
    task: view, candidate, validation, attemptCount: 1
  });
  const afterPass = runtime.getDeliveryTelemetry().workspaceHashComputeCount;
  assert.equal(afterPass - beforeHashCount, 1, 'PASS factory may compute Workspace Hash once');

  const created = runtime.createValidatedCandidateDelivery({ workerResult, task: view });
  assert.equal(created.ok, true);
  assert.equal(created.delivery.candidate, workerResult.candidate);
  assert.equal(created.delivery.validation, workerResult.validation);
  assert.equal(created.delivery.deliveryTarget.kind, 'changed_file');
  assert.equal(
    runtime.getDeliveryTelemetry().workspaceHashComputeCount,
    afterPass,
    'Delivery factory must not recompute Workspace Hash'
  );

  const officialFail = runtime.createValidatedCandidateDelivery({
    workerResult: runtime.createWorkerFailureResult({
      task: view, status: 'validated_failed', reason: 'official_failed', attemptCount: 1, validation: {
        ...validation,
        official: { syntax: 'failed', semantic: 'failed', diagnostics: [] },
        completeness: 'complete',
        candidateWorkspaceHash: workspaceHash
      }
    }),
    task: view
  });
  assert.equal(officialFail.ok, false);
  assert.equal(officialFail.reason, 'worker_result_not_validated_passed');

  const revisionConflict = runtime.createValidatedCandidateDelivery({
    workerResult,
    task: { ...view, taskRevision: view.taskRevision + 1 }
  });
  assert.equal(revisionConflict.ok, false);
  assert.equal(revisionConflict.reason, 'task_revision_conflict');

  const unauthorized = runtime.createValidatedCandidateDelivery({
    workerResult,
    task: {
      ...view,
      target: { ...view.target, fileId: 'file-other' }
    }
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, 'unauthorized_file_id');

  const obligation = resources.obligations.freeze({
    outcome, task: running, taskRevision: workerResult.taskRevision
  });
  const binding = runtime.bindWorkerResult(obligation, workerResult, created.delivery);
  assert.equal(binding.validatedCandidateDelivery, created.delivery);

  const hostContext = {
    requestId: 'req-delivery',
    tenant: { tenantId: 'tenant-delivery', userId: 'user-delivery' },
    threadId: 'thread-delivery',
    editor: {
      files: [{
        path: 'model.sysml',
        content: parsed.context.model.files[0].content,
        contentHash: parsed.context.model.files[0].contentHash
      }],
      entryFile: 'model.sysml',
      activeFilePath: 'model.sysml'
    }
  };
  const agentOutcome = {
    ok: true,
    response: {
      answer: '解释文字。```sysml\npackage Wrong {}\n```',
      validatorStatus: 'validated_passed',
      stopReason: 'completed',
      validation: workerResult.validation,
      candidateWorkspaceHash: workspaceHash,
      mainAgentDelegation: { action: 'candidate' },
      answerMode: 'result_bound_v2',
      warnings: []
    },
    ledger: [{
      toolName: 'validate_candidate_workspace',
      status: 'succeeded',
      canonicalArgs: JSON.stringify({ mode: 'replace_entry', fileId: 'file-d', baseHash: 'sha256:deadbeef', content: 'package Wrong {}' }),
      output: workerResult.validation
    }],
    validatedCandidateDelivery: created.delivery
  };
  const mapped = adapter.createAgentContext(hostContext);
  const rendered = adapter.enforceValidatedCodeAnswerForTests(agentOutcome, hostContext, mapped.fileMap);
  assert.equal(rendered.withheld, false);
  assert(rendered.answer.includes(lfContent), 'public answer must equal the Candidate Artifact body');
  assert(!rendered.answer.includes('package Wrong {}'), 'Finalizer code must be discarded');
  assert.equal(runtime.getDeliveryTelemetry().adapterLedgerRebuildCount, 0);
  assert.equal(runtime.getDeliveryTelemetry().adapterWorkspaceHashRecomputeCount, 0);

  const missingDelivery = adapter.enforceValidatedCodeAnswerForTests({
    ...agentOutcome,
    validatedCandidateDelivery: undefined
  }, hostContext, mapped.fileMap);
  assert.equal(missingDelivery.withheld, true);
  assert.equal(missingDelivery.withheldReason, 'validated_delivery_missing');

  const restored = runtime.restoreValidatedCandidateDelivery({
    runId: workerResult.runId,
    taskId: workerResult.taskId,
    taskRevision: workerResult.taskRevision,
    candidate,
    validation,
    files: parsed.context.model.files,
    expectedWorkspaceHash: workspaceHash
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.delivery.deliveryTarget.fileId, 'file-d');

  const tampered = runtime.restoreValidatedCandidateDelivery({
    runId: workerResult.runId,
    taskId: workerResult.taskId,
    taskRevision: workerResult.taskRevision,
    candidate,
    validation,
    files: parsed.context.model.files,
    expectedWorkspaceHash: hash('tampered-workspace')
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'workspace_binding_mismatch');

  console.log('ValidatedCandidateDelivery factory, negative matrix, adapter render, and deletion tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
