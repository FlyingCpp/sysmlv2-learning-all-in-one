'use strict';

const { CONTRACT_VERSION } = require('../../packages/teacher-contract');

function buildDiagnosticExplanation(context, options = {}) {
  const diagnosticContext = selectDiagnostic(context);
  const diagnostic = diagnosticContext.diagnostic;
  const hasDiagnostic = Boolean(diagnostic);
  const evidence = hasDiagnostic ? [diagnosticEvidence(diagnostic, diagnosticContext.source)] : [];
  const hint = diagnostic?.studentHint || {};
  const validation = context.diagnostics?.lastValidation || null;
  const status = validationStatus(validation, hasDiagnostic);
  const sourceLabel = diagnosticContext.source === 'course_rule' ? '课程规则' : '官方 validator';
  const message = hasDiagnostic ? String(diagnostic.message || '诊断没有提供 message 字段。') : '当前上下文没有可解释的诊断。';
  const directAnswer = hasDiagnostic
    ? `${sourceLabel}报告：${message}`
    : '请先运行校验，再让 AI 教师解释当前诊断。';
  const sections = [];

  if (hasDiagnostic) {
    sections.push({
      kind: 'diagnostic_source',
      title: '诊断来源',
      content: diagnosticContext.source === 'course_rule'
        ? '这是课程规则诊断。它应在官方语法/语义校验通过后，用来说明课程目标还缺什么。'
        : '这是官方 SysML v2 validator 诊断。处理顺序高于课程规则诊断。'
    });
    sections.push({
      kind: 'diagnostic_message',
      title: '当前诊断',
      content: diagnosticLocation(diagnostic) ? `${diagnosticLocation(diagnostic)}：${message}` : message
    });
    if (hint.title || hint.message) {
      sections.push({
        kind: 'student_hint',
        title: hint.title || '平台学习提示',
        content: hint.message || '请检查标红行附近的 SysML v2 语法、引用关系和课程 TODO。'
      });
    }
    if (Array.isArray(hint.fixSteps) && hint.fixSteps.length) {
      sections.push({
        kind: 'fix_steps',
        title: '排查顺序',
        content: hint.fixSteps.join(' ')
      });
    } else {
      sections.push({
        kind: 'fix_steps',
        title: '排查顺序',
        content: diagnosticContext.source === 'course_rule'
          ? '先确认官方语法/语义校验已经通过，再对照课程任务、TODO 和当前诊断中点名的模型元素逐项补齐。'
          : '先修正官方 validator 指出的语法或语义问题，再重新校验；只有严格校验通过后，课程规则解释才可靠。'
      });
    }
  } else {
    sections.push({
      kind: 'validation_state',
      title: '诊断上下文',
      content: '请求中没有 officialValidator 或 courseRules 诊断。'
    });
  }

  const retrievalHits = Array.isArray(options.retrievalHits) ? options.retrievalHits : [];
  retrievalHits.slice(0, 3).forEach((hit) => {
    evidence.push(knowledgeEvidence(hit.card, hit.score));
  });

  return {
    contractVersion: CONTRACT_VERSION,
    responseId: responseId('resp_diag', context.requestId),
    requestId: context.requestId,
    answerType: 'diagnostic_explanation',
    title: hasDiagnostic ? '诊断解释' : '暂无诊断',
    confidence: hasDiagnostic ? confidenceForDiagnostic(diagnostic, diagnosticContext.source) : 'low',
    directAnswer,
    sections,
    patches: [],
    evidence,
    validatorStatus: status,
    warnings: diagnosticWarnings(context, diagnosticContext),
    learningEvents: []
  };
}

function selectDiagnostic(context) {
  const diagnostics = context.diagnostics || {};
  const official = Array.isArray(diagnostics.officialValidator) ? diagnostics.officialValidator : [];
  const courseRules = Array.isArray(diagnostics.courseRules) ? diagnostics.courseRules : [];
  const officialError = official.find((item) => item.severity !== 'warning') || official[0] || null;
  if (officialError) return { diagnostic: officialError, source: 'official_validator' };
  const courseRule = courseRules.find((item) => item.severity !== 'warning') || courseRules[0] || null;
  if (courseRule) return { diagnostic: courseRule, source: 'course_rule' };
  return { diagnostic: null, source: 'none' };
}

function diagnosticEvidence(diagnostic, source) {
  const message = String(diagnostic.message || '');
  const hint = diagnostic.studentHint || {};
  return {
    evidenceId: source === 'course_rule'
      ? evidenceId('ev_course_rule', diagnostic.ruleId || message)
      : evidenceId('ev_official_validator', diagnostic.code || hint.id || message),
    authorityLevel: source === 'course_rule' ? 'C' : 'A',
    sourceType: source,
    sourceTitle: source === 'course_rule'
      ? 'Course-rule diagnostic supplied by the learning platform'
      : 'Official SysML v2 validator diagnostic supplied by the host',
    sourceUrl: '',
    sourceVersion: diagnostic.source || '',
    quote: '',
    summary: diagnosticLocation(diagnostic) ? `${diagnosticLocation(diagnostic)}: ${message}` : message,
    confidence: source === 'course_rule' ? 'medium' : 'high'
  };
}

function knowledgeEvidence(card, score) {
  return {
    evidenceId: evidenceId('ev_knowledge', card?.id || card?.title || ''),
    authorityLevel: card?.authorityLevel || 'D',
    sourceType: card?.sourceType || 'knowledge_card',
    sourceTitle: card?.title || card?.id || 'Knowledge card',
    sourceUrl: card?.sourceUrl || '',
    sourceVersion: card?.sourceVersion || '',
    quote: '',
    summary: card?.summary || card?.content || `Retrieved local knowledge card with score ${score}.`,
    confidence: card?.reviewStatus === 'reviewed' ? 'medium' : 'low'
  };
}

function diagnosticLocation(diagnostic) {
  const file = diagnostic.file || '';
  const line = diagnostic.line || '';
  const column = diagnostic.column || '';
  if (!file && !line) return '';
  return `${file || 'main.sysml'}:${line || 1}${column ? `:${column}` : ''}`;
}

function confidenceForDiagnostic(diagnostic, source) {
  if (source === 'official_validator') return diagnostic.studentHint?.confidence >= 0.8 ? 'high' : 'medium';
  if (source === 'course_rule') return 'medium';
  return 'low';
}

function validationStatus(lastValidation, hasDiagnostic) {
  if (!lastValidation) return hasDiagnostic ? 'not_validated' : 'not_applicable';
  if (lastValidation.syntaxValid && lastValidation.semanticValid && lastValidation.coursePassed) return 'validated_passed';
  return 'validated_failed';
}

function diagnosticWarnings(context, diagnosticContext) {
  const warnings = [];
  const validation = context.diagnostics?.lastValidation || null;
  if (!validation) warnings.push('validation_snapshot_missing');
  if (diagnosticContext.source === 'course_rule' && validation && (!validation.syntaxValid || !validation.semanticValid)) {
    warnings.push('course_rule_explanation_requires_strict_validation_context');
  }
  if (!diagnosticContext.diagnostic) warnings.push('no_diagnostic_available');
  return warnings;
}

function responseId(prefix, requestId) {
  const safeRequestId = String(requestId || 'local').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${prefix}_${safeRequestId}`;
}

function evidenceId(prefix, seed) {
  const clean = String(seed || 'local').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 72);
  return `${prefix}_${clean || 'local'}`;
}

module.exports = {
  buildDiagnosticExplanation,
  selectDiagnostic,
  diagnosticEvidence,
  knowledgeEvidence
};
