'use strict';

const fs = require('fs');
const path = require('path');

function createCourseStore(options = {}) {
  const root = options.coursesRoot || process.env.COURSES_ROOT || path.resolve(process.cwd(), 'courses');
  const packId = options.coursePack || process.env.COURSE_PACK || 'ev-sysml-v2-foundation';
  const packDir = options.packDir || path.join(root, packId);

  function readJson(relativePath) {
    const absolute = safeJoin(packDir, relativePath);
    return JSON.parse(stripUtf8Bom(fs.readFileSync(absolute, 'utf8')));
  }

  function readText(relativePath) {
    return fs.readFileSync(safeJoin(packDir, relativePath), 'utf8');
  }

  function loadPack() {
    if (!fs.existsSync(packDir)) {
      const error = new Error(`课程包不存在：${packDir}`);
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    return readJson('course-pack.json');
  }

  function loadCourses() {
    const pack = loadPack();
    return (pack.courses || []).map((coursePath) => {
      const course = readJson(coursePath);
      return { ...course, _path: coursePath };
    }).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }

  function loadCourse(courseId) {
    const course = loadCourses().find((item) => item.id === courseId);
    if (!course) return null;
    const base = path.dirname(course._path);
    const lessonRefs = (course.lessons || []).map((lessonRef) => normalizeRelative(base, lessonRef));
    return { ...course, lessons: lessonRefs.map((lessonPath) => loadLessonByPath(lessonPath)) };
  }

  function loadLesson(lessonId) {
    const pack = loadPack();
    for (const course of loadCourses()) {
      const base = path.dirname(course._path);
      for (const lessonRef of course.lessons || []) {
        const lessonPath = normalizeRelative(base, lessonRef);
        const lesson = loadLessonByPath(lessonPath);
        if (lesson.id === lessonId) {
          return {
            ...lesson,
            courseId: course.id,
            courseTitle: course.title,
            courseReferences: course.references || [],
            courseConceptExplanations: course.conceptExplanations || [],
            codeGuideExplanations: [
              ...(lesson.codeGuideExplanations || []),
              ...(course.codeGuideExplanations || []),
              ...(pack.codeGuideExplanations || [])
            ]
          };
        }
      }
    }
    return null;
  }

  function loadLessonByPath(lessonPath) {
    const lesson = readJson(lessonPath);
    const base = path.dirname(lessonPath);
    return hydrateWorkspaceAndRules(lesson, base);
  }

  function hydrateWorkspaceAndRules(entity, base) {
    const copy = JSON.parse(JSON.stringify(entity));
    if (copy.workspace?.files) {
      copy.workspace.files = copy.workspace.files.map((file) => {
        if (file.content !== undefined) return file;
        if (!file.source) return { ...file, content: '' };
        try {
          return { ...file, content: readText(normalizeRelative(base, file.source)) };
        } catch {
          return { ...file, content: '' };
        }
      });
    }
    if (copy.validation?.rulesFile) {
      copy.validation.rules = readJson(normalizeRelative(base, copy.validation.rulesFile));
    }
    return copy;
  }

  function loadGlossary() {
    const pack = loadPack();
    if (!pack.glossary) return [];
    return readJson(pack.glossary);
  }

  function loadAsset(relativePath) {
    const cleanPath = String(relativePath || '').replace(/^\/+/, '');
    if (!cleanPath) return null;
    const absolute = safeJoin(packDir, cleanPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
    return {
      content: fs.readFileSync(absolute),
      mimeType: mimeForPath(cleanPath)
    };
  }

  function loadFinalProject() {
    const projectPath = path.join(packDir, 'final-project', 'project.json');
    if (!fs.existsSync(projectPath)) return null;
    const project = readJson('final-project/project.json');
    const hydrated = hydrateWorkspaceAndRules(project, 'final-project');
    if (!hydrated.workspace && fs.existsSync(path.join(packDir, 'final-project', 'starter.sysml'))) {
      hydrated.workspace = { entryFile: 'main.sysml', files: [{ path: 'main.sysml', editable: true, content: readText('final-project/starter.sysml') }] };
    }
    const rulesPath = path.join(packDir, 'final-project', 'rules.json');
    if (!hydrated.validation?.rules && fs.existsSync(rulesPath)) {
      hydrated.validation = { ...(hydrated.validation || {}), rules: readJson('final-project/rules.json') };
    }
    return hydrated;
  }

  return {
    root,
    packId,
    packDir,
    loadPack,
    loadCourses,
    loadCourse,
    loadLesson,
    loadGlossary,
    loadAsset,
    loadFinalProject
  };
}

function normalizeRelative(base, relativePath) {
  if (!base || base === '.') return relativePath;
  if (relativePath.startsWith(base + '/')) return relativePath;
  return path.posix.normalize(path.posix.join(base.replaceAll('\\', '/'), relativePath.replaceAll('\\', '/')));
}

function safeJoin(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(resolvedRoot)) throw new Error(`Unsafe course path: ${relativePath}`);
  return target;
}

function stripUtf8Bom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = { createCourseStore };
