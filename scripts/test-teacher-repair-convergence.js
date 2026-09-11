'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function hash(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function diagnostic(message, overrides = {}) {
  return { severity: 'error', message, ...overrides };
}

function validation({
  syntax = 'passed',
  semantic = 'passed',
  officialDiagnostics = [],
  courseRules,
  evidence = 'test'
} = {}) {
  return {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: '2026-04/0.59.0/test',
      evidenceHash: hash(evidence)
    },
    official: { syntax, semantic, diagnostics: officialDiagnostics },
    ...(courseRules ? { courseRules, courseRuleApplicability: 'applicable' } : { courseRuleApplicability: 'not_applicable' }),
    completeness: 'complete',
    patches: []
  };
}

async function main() {
  const {
    computeDiagnosticDelta,
    createRepairIssueSet,
    summarizeCandidateChanges
  } = await import('../apps/teacher/dist/agent/repair-convergence.mjs');

  const syntaxSet = createRepairIssueSet(validation({
    syntax: 'failed',
    semantic: 'not_run',
    officialDiagnostics: [diagnostic('Missing closing brace.', { code: 'SYNTAX_BRACE', fileId: 'file_main', line: 2 })],
    evidence: 'syntax'
  }), hash('syntax-candidate'));
  assert.equal(syntaxSet.activeCluster.category, 'syntax');
  assert.equal(syntaxSet.activeCluster.priority, 1);

  const semanticSet = createRepairIssueSet(validation({
    semantic: 'failed',
    officialDiagnostics: [diagnostic('Unknown type MissingType.', { code: 'UNKNOWN_TYPE', fileId: 'file_main', line: 4 })],
    evidence: 'semantic'
  }), hash('semantic-candidate'));
  assert.equal(semanticSet.activeCluster.category, 'semantic');
  assert.equal(semanticSet.activeCluster.priority, 2);

  const courseSet = createRepairIssueSet(validation({
    courseRules: {
      status: 'failed',
      diagnostics: [diagnostic('Course rule requires a named usage.', { code: 'COURSE_NAMED_USAGE', line: 6 })]
    },
    evidence: 'course'
  }), hash('course-candidate'));
  assert.deepEqual(courseSet.clusters, [],
    '课程规则诊断只属于工程Review，不得进入Official Validator Repair收敛循环');
  assert.equal(courseSet.activeCluster, undefined);

  const previous = createRepairIssueSet(validation({
    semantic: 'failed',
    officialDiagnostics: [
      diagnostic('Unknown type A.', { code: 'UNKNOWN_A', fileId: 'file_main', line: 2 }),
      diagnostic('Unknown type B.', { code: 'UNKNOWN_B', fileId: 'file_main', line: 3 })
    ],
    evidence: 'previous'
  }), hash('previous'));
  const next = createRepairIssueSet(validation({
    semantic: 'failed',
    officialDiagnostics: [
      diagnostic('Unknown type B.', { code: 'UNKNOWN_B', fileId: 'file_main', line: 8 }),
      diagnostic('Unknown type C.', { code: 'UNKNOWN_C', fileId: 'file_main', line: 9 })
    ],
    evidence: 'next'
  }), hash('next'));
  const delta = computeDiagnosticDelta(previous, next);
  assert.deepEqual(delta.counts, { resolved: 1, unchanged: 1, introduced: 1, regressed: 0 });
  assert.equal(delta.unchanged[0].code, 'UNKNOWN_B', 'line movement must not turn the same diagnostic into a new issue');

  const restored = createRepairIssueSet(validation({
    semantic: 'failed',
    officialDiagnostics: [
      diagnostic('Unknown type A.', { code: 'UNKNOWN_A', fileId: 'file_main', line: 12 }),
      diagnostic('Unknown type B.', { code: 'UNKNOWN_B', fileId: 'file_main', line: 13 })
    ],
    evidence: 'restored'
  }), hash('restored'));
  const regression = computeDiagnosticDelta(
    next,
    restored,
    new Set(delta.resolved.map((issue) => issue.issueId))
  );
  assert.deepEqual(regression.counts, { resolved: 1, unchanged: 1, introduced: 0, regressed: 1 });
  assert.equal(regression.regressed[0].code, 'UNKNOWN_A');

  const previousContent = [
    'package Demo {',
    '  part def Broken;',
    '  part def Stable;',
    '}'
  ].join('\n');
  const localContent = [
    'package Demo {',
    '  part def Fixed;',
    '  part def Stable;',
    '}'
  ].join('\n');
  const localChange = summarizeCandidateChanges({
    previousContent,
    nextContent: localContent,
    activeCluster: semanticSet.activeCluster,
    previousStructure: {
      source: 'local_structure_analyzer', authority: 'advisory', status: 'partial',
      nodes: [{ kind: 'part def', name: 'Broken', fileId: 'file_main', line: 2 }], diagnostics: [], truncated: false
    },
    nextStructure: {
      source: 'local_structure_analyzer', authority: 'advisory', status: 'partial',
      nodes: [{ kind: 'part def', name: 'Fixed', fileId: 'file_main', line: 2 }], diagnostics: [], truncated: false
    }
  });
  assert.equal(localChange.text.changedLineCount, 1);
  assert.equal(localChange.structure.changedNodeCount, 2);
  assert.equal(localChange.outOfClusterChange, false);

  const broadContent = [
    'package Demo {',
    '  part def Fixed;',
    '  part def Stable;',
    '  part def Unrelated1;',
    '  part def Unrelated2;',
    '  part def Unrelated3;',
    '  part def Unrelated4;',
    '  part def Unrelated5;',
    '  part def Unrelated6;',
    '  part def Unrelated7;',
    '  part def Unrelated8;',
    '  part def Unrelated9;',
    '  part def Unrelated10;',
    '}'
  ].join('\n');
  const broadChange = summarizeCandidateChanges({
    previousContent,
    nextContent: broadContent,
    activeCluster: semanticSet.activeCluster
  });
  assert.equal(broadChange.outOfClusterChange, true);
  assert(broadChange.outOfClusterReasons.includes('text_change_outside_active_cluster_line_window'));

  console.log('Teacher Repair Convergence tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
