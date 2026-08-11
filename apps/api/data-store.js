'use strict';

const fs = require('fs');
const path = require('path');

function createDataStore(dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data')) {
  fs.mkdirSync(dataDir, { recursive: true });

  function userDataDir(user) {
    if (!user?.id) return dataDir;
    return path.join(dataDir, 'users', encodeURIComponent(user.id));
  }

  function draftsDir(user) {
    const dir = path.join(userDataDir(user), 'drafts');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function progressPath(user, packId = '') {
    const dir = userDataDir(user);
    fs.mkdirSync(dir, { recursive: true });
    if (!packId) return path.join(dir, 'progress.json');
    const progressDir = path.join(dir, 'progress');
    fs.mkdirSync(progressDir, { recursive: true });
    return path.join(progressDir, encodeURIComponent(packId) + '.json');
  }

  function readProgress(packId, user = null) {
    const file = progressPath(user, packId);
    if (!fs.existsSync(file)) {
      const legacyFile = progressPath(user);
      if (fs.existsSync(legacyFile)) {
        const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        if (!legacy.coursePackId || legacy.coursePackId === packId) return { ...legacy, coursePackId: packId };
      }
      return { coursePackId: packId, completedLessons: [], completedCourses: [], drafts: {} };
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function writeProgress(progress, user = null) {
    const packId = progress.coursePackId || 'default';
    const payload = { ...progress, coursePackId: packId };
    fs.writeFileSync(progressPath(user, packId), JSON.stringify(payload, null, 2));
    return payload;
  }

  function draftPath(id, user = null, packId = '') {
    const dir = packId ? path.join(draftsDir(user), encodeURIComponent(packId)) : draftsDir(user);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, encodeURIComponent(id) + '.json');
  }

  function readDraft(id, user = null, packId = '') {
    const file = draftPath(id, user, packId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function writeDraft(id, draft, user = null, packId = '') {
    const payload = { id, ...draft, updatedAt: new Date().toISOString() };
    fs.writeFileSync(draftPath(id, user, packId), JSON.stringify(payload, null, 2));
    return payload;
  }

  function deleteDraft(id, user = null, packId = '') {
    const file = draftPath(id, user, packId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { id, deleted: true };
  }

  function knowledgeProgressPath(user, packId) {
    const dir = path.join(userDataDir(user), 'knowledge-progress');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, encodeURIComponent(packId) + '.json');
  }

  function readKnowledgeProgress(packId, user = null) {
    const file = knowledgeProgressPath(user, packId);
    if (!fs.existsSync(file)) return { packId, topicProgress: {}, updatedAt: null };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function writeKnowledgeProgress(packId, progress, user = null) {
    const topicProgress = progress?.topicProgress && typeof progress.topicProgress === 'object'
      ? progress.topicProgress
      : {};
    const payload = { packId, topicProgress, updatedAt: new Date().toISOString() };
    fs.writeFileSync(knowledgeProgressPath(user, packId), JSON.stringify(payload, null, 2));
    return payload;
  }

  return { dataDir, readProgress, writeProgress, readDraft, writeDraft, deleteDraft, readKnowledgeProgress, writeKnowledgeProgress };
}

module.exports = { createDataStore };
