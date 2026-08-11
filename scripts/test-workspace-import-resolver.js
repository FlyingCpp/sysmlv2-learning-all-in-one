'use strict';

const assert = require('assert');
const {
  extractDeclaredRootPackages,
  extractDependencyRoots,
  extractImportRoots,
  extractQualifiedReferenceRoots,
  resolveWorkspaceImportClosure
} = require('../apps/api/workspace-import-resolver');

function paths(files) {
  return files.map((file) => file.path);
}

assert.deepStrictEqual(
  paths(resolveWorkspaceImportClosure([
    { path: 'main.sysml', content: 'package Main {}' },
    { path: 'legacy.sysml', content: 'package Legacy {}' }
  ], { entryFile: 'main.sysml' })),
  ['main.sysml', 'legacy.sysml'],
  'Existing course files without on-import policy must remain always loaded.'
);

const genericWorkspace = [
  { path: 'baseline.sysml', content: 'package Baseline {}', loadPolicy: 'always' },
  {
    path: 'main.sysml',
    content: `package Main {
      // private import IgnoredPackage::*;
      doc /* private import AlsoIgnored::*; */
      private import ResourceA::*;
    }`,
    loadPolicy: 'always'
  },
  {
    path: 'resource-a.sysml',
    content: 'package ResourceA { private import ResourceB::*; }',
    loadPolicy: 'on-import'
  },
  { path: 'resource-b.sysml', content: 'package ResourceB {}', loadPolicy: 'on-import' },
  { path: 'ignored.sysml', content: 'package IgnoredPackage {}', loadPolicy: 'on-import' },
  { path: 'also-ignored.sysml', content: 'package AlsoIgnored {}', loadPolicy: 'on-import' }
];

assert.deepStrictEqual(
  paths(resolveWorkspaceImportClosure(genericWorkspace, { entryFile: 'main.sysml' })),
  ['baseline.sysml', 'main.sysml', 'resource-a.sysml', 'resource-b.sysml'],
  'Resolver must include only direct and transitive imports.'
);

assert.deepStrictEqual(extractDeclaredRootPackages("package 'Quoted Package' {}"), ['Quoted Package']);
assert.deepStrictEqual(extractImportRoots("private import 'Quoted Package'::*;"), ['Quoted Package']);
assert.deepStrictEqual(
  extractQualifiedReferenceRoots("dependency d to 'Quoted Package'::Target; // IgnoredPackage::Target\ndoc /* AlsoIgnored::Target */"),
  ['Quoted Package'],
  'Qualified package references must be detected without reading comments.'
);
assert.deepStrictEqual(
  extractDependencyRoots('private import ResourceA::*; dependency d to ResourceB::Target;'),
  ['ResourceA', 'ResourceB']
);

const quotedClosure = resolveWorkspaceImportClosure([
  { path: 'main.sysml', content: "package Main { private import 'Quoted Package'::*; }" },
  { path: 'quoted.sysml', content: "package 'Quoted Package' {}", loadPolicy: 'on-import' }
], { entryFile: 'main.sysml' });
assert.deepStrictEqual(paths(quotedClosure), ['main.sysml', 'quoted.sysml']);

const qualifiedReferenceClosure = resolveWorkspaceImportClosure([
  { path: 'main.sysml', content: 'package Main { private import ResourceA::*; }' },
  { path: 'resource-a.sysml', content: 'package ResourceA { dependency d to ResourceB::Target; }', loadPolicy: 'on-import' },
  { path: 'resource-b.sysml', content: 'package ResourceB { part Target; }', loadPolicy: 'on-import' },
  { path: 'unused.sysml', content: 'package Unused {}', loadPolicy: 'on-import' }
], { entryFile: 'main.sysml' });
assert.deepStrictEqual(
  paths(qualifiedReferenceClosure),
  ['main.sysml', 'resource-a.sysml', 'resource-b.sysml'],
  'Resolver must follow qualified cross-package references in an imported resource.'
);

assert.deepStrictEqual(
  paths(resolveWorkspaceImportClosure(genericWorkspace, {
    entryFile: 'main.sysml',
    includePaths: ['ignored.sysml']
  })),
  ['baseline.sysml', 'main.sysml', 'resource-a.sysml', 'resource-b.sysml', 'ignored.sysml'],
  'Explicitly opened resources may be included without changing import semantics.'
);

console.log('Workspace import resolver tests passed.');
