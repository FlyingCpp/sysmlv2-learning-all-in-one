'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileOfficialValidator, resolveOfficialPaths } = require('./compile-official-validator');
const { createCourseStore } = require('../apps/api/course-store');
const { resolveWorkspaceImportClosure } = require('../apps/api/workspace-import-resolver');

async function main() {
  const paths = resolveOfficialPaths();
  assert(fs.existsSync(paths.jarPath), `Official SysML kernel jar not found: ${paths.jarPath}`);
  assert(fs.existsSync(paths.libraryPath), `Official SysML library not found: ${paths.libraryPath}`);
  compileOfficialValidator();

  process.env.SYSML_OFFICIAL_JAR = paths.jarPath;
  process.env.SYSML_LIBRARY_PATH = paths.libraryPath;
  process.env.SYSML_WRAPPER_CLASSES = paths.classesPath;
  process.env.OFFICIAL_VALIDATOR_ENABLED = 'true';
  process.env.OFFICIAL_VALIDATOR_FALLBACK = 'false';
  process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS = process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS || '300000';

  const {
    validateWorkspace,
    backend,
    outlineBackend,
    plantUmlBackend
  } = require('../apps/validator/validator');

  try {
    const coursePack = process.env.COURSE_PACK || 'ev-sysml-v2-foundation';
    const store = createCourseStore({
      coursesRoot: path.resolve(__dirname, '..', 'courses'),
      coursePack
    });
    const failures = [];
    let count = 0;

    if (coursePack === 'apollo-11-cosma-walkthrough') {
      const firstCourseSummary = store.loadCourses()[0];
      const firstLesson = store.loadCourse(firstCourseSummary.id).lessons[0];
      const upstreamFiles = (firstLesson.workspace?.files || [])
        .filter((file) => String(file.path || '').startsWith('upstream/'));
      count += 1;
      const upstreamResult = await validateWorkspace({
        files: upstreamFiles.map((file) => ({ path: file.path, content: file.content })),
        entryFile: 'upstream/Apollo11Model.sysml'
      });
      if (!upstreamResult.syntaxValid || !upstreamResult.semanticValid) {
        failures.push({ id: 'airbus-upstream-closure', diagnostics: upstreamResult.diagnostics.slice(0, 8) });
      }
    }

    for (const summary of store.loadCourses()) {
      const course = store.loadCourse(summary.id);
      for (const lesson of course.lessons) {
        count += 1;
        const result = await validateEntity(validateWorkspace, lesson.workspace);
        if (!result.syntaxValid || !result.semanticValid) {
          failures.push({ id: lesson.id, title: lesson.title, diagnostics: result.diagnostics.slice(0, 8) });
        }
      }
    }

    count += 1;
    const project = store.loadFinalProject();
    const projectResult = await validateEntity(validateWorkspace, project.workspace);
    if (!projectResult.syntaxValid || !projectResult.semanticValid) {
      failures.push({ id: 'final-project', title: project.title, diagnostics: projectResult.diagnostics.slice(0, 8) });
    }

    const completedPath = path.join(store.packDir, 'final-project', 'completed.sysml');
    if (fs.existsSync(completedPath)) {
      count += 1;
      const completedResult = await validateWorkspace({
        files: [{ path: 'main.sysml', content: fs.readFileSync(completedPath, 'utf8') }],
        entryFile: 'main.sysml'
      });
      if (!completedResult.syntaxValid || !completedResult.semanticValid) {
        failures.push({ id: 'final-project-completed', title: `${project.title}参考模型`, diagnostics: completedResult.diagnostics.slice(0, 8) });
      }
    }

    assert.strictEqual(failures.length, 0, JSON.stringify(failures, null, 2));
    console.log(`official course validation passed (${count} workspaces)`);
  } finally {
    await Promise.allSettled([
      backend.stop(),
      outlineBackend.stop(),
      plantUmlBackend.stop()
    ]);
  }
}

function validateEntity(validateWorkspace, workspace) {
  const files = resolveWorkspaceImportClosure(workspace.files, { entryFile: workspace.entryFile });
  return validateWorkspace({
    files: files.map((file) => ({ path: file.path, content: file.content })),
    entryFile: workspace.entryFile
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
