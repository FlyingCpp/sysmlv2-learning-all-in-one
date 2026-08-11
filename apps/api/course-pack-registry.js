'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function createCoursePackRegistry(options = {}) {
  const bundledRoot = options.coursesRoot || process.env.COURSES_ROOT || path.resolve(process.cwd(), 'courses');
  const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  const uploadRoot = options.coursePackUploadRoot || process.env.COURSE_PACK_UPLOAD_ROOT || path.join(dataDir, 'course-packs');
  const pendingRoot = options.coursePackPendingRoot || process.env.COURSE_PACK_PENDING_ROOT || path.join(dataDir, 'course-pack-upload-pending');
  const registryPath = options.coursePackRegistryPath || process.env.COURSE_PACK_REGISTRY || path.join(dataDir, 'course-pack-registry.json');
  const defaultPackId = options.coursePack || process.env.COURSE_PACK || 'ev-sysml-v2-foundation-c2';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  fs.mkdirSync(pendingRoot, { recursive: true });

  function listPacks({ includeDisabled = false } = {}) {
    const registry = readRegistry();
    const discovered = discoverBundledPacks();
    const entries = new Map();

    for (const pack of discovered) {
      const record = registry.packs[pack.id] || {};
      if (packStatus(record) === 'deleted') continue;
      entries.set(pack.id, normalizePackSummary({
        ...pack,
        enabled: record.enabled !== undefined ? Boolean(record.enabled) : true,
        status: packStatus(record, record.enabled !== false ? 'active' : 'disabled'),
        displayOrder: record.displayOrder ?? pack.displayOrder ?? pack.order,
        lineageId: record.lineageId || '',
        dataNamespaceId: record.dataNamespaceId || record.lineageId || pack.id,
        source: 'bundled',
        versions: record.versions || []
      }));
    }

    for (const [id, record] of Object.entries(registry.packs || {})) {
      if (packStatus(record) === 'deleted') continue;
      const latest = latestVersion(record);
      if (!latest && entries.has(id)) continue;
      const packDir = latest?.path || entries.get(id)?.path;
      const packJson = packDir ? readPackJsonSafe(packDir) : null;
      entries.set(id, normalizePackSummary({
        id,
        ...(packJson || {}),
        enabled: record.enabled !== undefined ? Boolean(record.enabled) : true,
        status: packStatus(record),
        displayOrder: record.displayOrder ?? packJson?.displayOrder ?? packJson?.order,
        lineageId: record.lineageId || packJson?.identity?.lineageId || '',
        dataNamespaceId: record.dataNamespaceId || record.lineageId || id,
        source: latest ? 'uploaded' : entries.get(id)?.source || 'registry',
        path: packDir,
        uploadedAt: latest?.uploadedAt || record.updatedAt || '',
        originalName: latest?.originalName || '',
        versions: record.versions || []
      }));
    }

    return [...entries.values()]
      .filter((pack) => includeDisabled || pack.status === 'active')
      .sort((a, b) => displayOrderValue(a) - displayOrderValue(b) || String(a.title || a.id).localeCompare(String(b.title || b.id), 'zh-Hans-CN'));
  }

  function resolvePack(packId = '', { includeDisabled = false } = {}) {
    const packs = listPacks({ includeDisabled: true });
    const requested = String(packId || '').trim();
    const selected = packs.find((pack) => pack.id === requested)
      || packs.find((pack) => pack.id === defaultPackId && pack.status === 'active')
      || packs.find((pack) => pack.status === 'active')
      || packs.find((pack) => pack.id === defaultPackId)
      || packs[0];
    if (!selected) {
      const error = new Error('没有可用课程包。');
      error.status = 503;
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    if (!includeDisabled && selected.status !== 'active') {
      const error = new Error(`课程包未启用：${selected.id}`);
      error.status = 404;
      error.code = 'COURSE_PACK_DISABLED';
      throw error;
    }
    return selected;
  }

  function setEnabled(packId, enabled) {
    const packs = listPacks({ includeDisabled: true });
    const current = packs.find((pack) => pack.id === packId);
    if (!current) {
      const error = new Error(`课程包不存在：${packId}`);
      error.status = 404;
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    if (current.status === 'archived' || current.status === 'deleted') {
      const error = new Error(`课程包当前状态不能直接启用或停用：${current.status}`);
      error.status = 409;
      error.code = 'COURSE_PACK_STATUS_LOCKED';
      throw error;
    }
    const registry = readRegistry();
    registry.packs[packId] = {
      ...(registry.packs[packId] || {}),
      id: packId,
      enabled: Boolean(enabled),
      status: enabled ? 'active' : 'disabled',
      updatedAt: new Date().toISOString()
    };
    writeRegistry(registry);
    return resolvePack(packId, { includeDisabled: true });
  }

  function movePack(packId, direction) {
    if (direction !== 'up' && direction !== 'down') {
      const error = new Error('课程排序方向必须是 up 或 down。');
      error.status = 400;
      error.code = 'COURSE_PACK_ORDER_DIRECTION_INVALID';
      throw error;
    }
    const packs = listPacks({ includeDisabled: true });
    const currentIndex = packs.findIndex((pack) => pack.id === packId);
    if (currentIndex < 0) {
      const error = new Error(`课程包不存在：${packId}`);
      error.status = 404;
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= packs.length) {
      const error = new Error('课程包已经位于当前方向的边界。');
      error.status = 409;
      error.code = 'COURSE_PACK_ORDER_BOUNDARY';
      throw error;
    }
    [packs[currentIndex], packs[targetIndex]] = [packs[targetIndex], packs[currentIndex]];
    const registry = readRegistry();
    packs.forEach((pack, index) => {
      registry.packs[pack.id] = {
        ...(registry.packs[pack.id] || {}),
        id: pack.id,
        displayOrder: index + 1
      };
    });
    writeRegistry(registry);
    return listPacks({ includeDisabled: true });
  }

  function archivePack(packId) {
    const current = listPacks({ includeDisabled: true }).find((pack) => pack.id === packId);
    if (!current) {
      const error = new Error(`课程包不存在：${packId}`);
      error.status = 404;
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    if (current.status !== 'disabled') {
      const error = new Error('课程包必须先停用，才能归档。');
      error.status = 409;
      error.code = 'COURSE_PACK_ARCHIVE_REQUIRES_DISABLED';
      throw error;
    }
    const registry = readRegistry();
    registry.packs[packId] = {
      ...(registry.packs[packId] || {}),
      id: packId,
      enabled: false,
      status: 'archived',
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      studentDataPolicy: 'preserve-data-namespace'
    };
    writeRegistry(registry);
    return resolvePack(packId, { includeDisabled: true });
  }

  function restoreArchivedPack(packId) {
    const current = listPacks({ includeDisabled: true }).find((pack) => pack.id === packId);
    if (!current) {
      const error = new Error(`课程包不存在：${packId}`);
      error.status = 404;
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    if (current.status !== 'archived') {
      const error = new Error('只有已归档课程包可以恢复。');
      error.status = 409;
      error.code = 'COURSE_PACK_RESTORE_REQUIRES_ARCHIVED';
      throw error;
    }
    const registry = readRegistry();
    const record = {
      ...(registry.packs[packId] || {}),
      id: packId,
      enabled: false,
      status: 'disabled',
      archivedAt: null,
      restoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    registry.packs[packId] = record;
    writeRegistry(registry);
    return resolvePack(packId, { includeDisabled: true });
  }

  function deleteArchivedPack(packId) {
    const current = listPacks({ includeDisabled: true }).find((pack) => pack.id === packId);
    if (!current) {
      const error = new Error(`课程包不存在：${packId}`);
      error.status = 404;
      error.code = 'COURSE_PACK_NOT_FOUND';
      throw error;
    }
    if (current.status !== 'archived') {
      const error = new Error('课程包必须先归档，才能删除。');
      error.status = 409;
      error.code = 'COURSE_PACK_DELETE_REQUIRES_ARCHIVED';
      throw error;
    }
    const registry = readRegistry();
    const existing = registry.packs[packId] || {};
    const deletedAt = new Date().toISOString();
    const deletedRecord = {
      ...existing,
      id: packId,
      title: current.title || existing.title || packId,
      version: current.version || existing.version || '',
      enabled: false,
      status: 'deleted',
      archivedAt: existing.archivedAt || current.archivedAt || null,
      deletedAt,
      updatedAt: deletedAt,
      lineageId: existing.lineageId || current.lineageId || '',
      dataNamespaceId: existing.dataNamespaceId || current.dataNamespaceId || existing.lineageId || packId,
      versions: Array.isArray(existing.versions) ? existing.versions : (Array.isArray(current.versions) ? current.versions : [])
    };
    registry.packs[packId] = deletedRecord;
    registry.deletedLineages = Array.isArray(registry.deletedLineages) ? registry.deletedLineages : [];
    registry.deletedLineages = [
      {
        id: packId,
        coursePackId: packId,
        title: deletedRecord.title,
        version: deletedRecord.version,
        lineageId: deletedRecord.lineageId,
        dataNamespaceId: deletedRecord.dataNamespaceId,
        versions: deletedRecord.versions,
        contentHash: deletedRecord.versions[0]?.contentHash || deletedRecord.contentHash || '',
        deletedAt
      },
      ...registry.deletedLineages.filter((record) => (record.id || record.coursePackId) !== packId || record.lineageId !== deletedRecord.lineageId)
    ];
    writeRegistry(registry);
    return { ok: true, packId, status: 'deleted', lineageId: deletedRecord.lineageId, dataNamespaceId: deletedRecord.dataNamespaceId };
  }

  function previewUploadedArchive({ filename, buffer }) {
    const originalName = path.basename(filename || 'course-pack.zip');
    const ext = path.extname(originalName).toLowerCase();
    if (!['.zip', '.rar'].includes(ext)) {
      const error = new Error('仅支持 .zip 或 .rar 课程包。');
      error.status = 400;
      error.code = 'UNSUPPORTED_ARCHIVE';
      throw error;
    }
    const pendingUploadId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const pendingDir = path.join(pendingRoot, pendingUploadId);
    const archivePath = path.join(pendingDir, originalName);
    const extractDir = path.join(pendingDir, 'extract');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(archivePath, buffer);

    extractArchive(archivePath, extractDir, ext);
    const extractedPackDir = findExtractedPackDir(extractDir);
    const packJson = readPackJson(extractedPackDir);
    const packId = sanitizePackId(packJson.id || path.basename(extractedPackDir));
    if (!packId) {
      const error = new Error('课程包 course-pack.json 缺少有效 id。');
      error.status = 400;
      error.code = 'INVALID_COURSE_PACK';
      throw error;
    }
    const identity = readIdentity(extractedPackDir, packJson);
    const contentHash = hashDirectory(extractedPackDir);
    const registry = readRegistry();
    const decision = decideUpload({ registry, packId, packJson, identity, contentHash });
    const pending = {
      pendingUploadId,
      uploadedAt: new Date().toISOString(),
      originalName,
      tempArchivePath: archivePath,
      extractedPackDir,
      packSummary: normalizePackSummary({
        ...packJson,
        id: packId,
        source: 'pending',
        originalName,
        uploadedAt: new Date().toISOString(),
        versions: [{ version: packJson.version || '', uploadedAt: new Date().toISOString(), originalName }]
      }),
      identity,
      contentHash,
      decision,
      availableActions: availableActionsForDecision(decision)
    };
    writePending(pending);
    return publicPending(pending);
  }

  function confirmPendingUpload(pendingUploadId, action = 'confirm') {
    const pending = readPending(pendingUploadId);
    if (!pending) {
      const error = new Error('待确认上传不存在或已被清理。');
      error.status = 404;
      error.code = 'PENDING_UPLOAD_NOT_FOUND';
      throw error;
    }
    if (!pending.availableActions.includes(action)) {
      const error = new Error('当前判定不允许执行该上传动作。');
      error.status = 409;
      error.code = 'PENDING_UPLOAD_ACTION_NOT_ALLOWED';
      throw error;
    }
    if (pending.decision.type === 'identity_conflict') {
      const error = new Error('课程身份冲突，不能确认加载。请放弃上传并重新提交正确课程包。');
      error.status = 409;
      error.code = 'COURSE_PACK_IDENTITY_CONFLICT';
      throw error;
    }

    const packJson = readPackJson(pending.extractedPackDir);
    const packId = sanitizePackId(packJson.id || pending.packSummary.id);
    const registry = readRegistry();
    const contentVersionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const targetDir = path.join(uploadRoot, packId, contentVersionId);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    moveDirectory(pending.extractedPackDir, targetDir);

    const identityChoice = identityForAction({ registry, pending, packId, action });
    const currentPacks = listPacks({ includeDisabled: true });
    currentPacks.forEach((pack, index) => {
      registry.packs[pack.id] = {
        ...(registry.packs[pack.id] || {}),
        id: pack.id,
        displayOrder: registry.packs[pack.id]?.displayOrder ?? index + 1
      };
    });
    const existingOrder = currentPacks.findIndex((pack) => pack.id === packId);
    const record = {
      ...(registry.packs[packId] || {}),
      id: packId,
      versions: Array.isArray(registry.packs[packId]?.versions) ? registry.packs[packId].versions : []
    };
    record.id = packId;
    record.enabled = false;
    record.status = 'disabled';
    record.lineageId = identityChoice.lineageId;
    record.dataNamespaceId = identityChoice.dataNamespaceId;
    record.identitySource = identityChoice.source;
    record.deletedAt = null;
    record.displayOrder = record.displayOrder ?? (existingOrder >= 0 ? existingOrder + 1 : currentPacks.length + 1);
    record.versions = [
      {
        version: String(packJson.version || ''),
        uploadedAt: new Date().toISOString(),
        path: targetDir,
        originalName: pending.originalName,
        contentVersionId,
        contentHash: pending.contentHash,
        lineageId: record.lineageId
      },
      ...(record.versions || [])
    ];
    record.updatedAt = new Date().toISOString();
    registry.packs[packId] = record;
    writeRegistry(registry);
    cleanupPending(pendingUploadId);
    return resolvePack(packId, { includeDisabled: true });
  }

  function abandonPendingUpload(pendingUploadId) {
    const pending = readPending(pendingUploadId);
    cleanupPending(pendingUploadId);
    return { ok: true, pendingUploadId, abandoned: Boolean(pending) };
  }

  function listPendingUploads() {
    if (!fs.existsSync(pendingRoot)) return [];
    return fs.readdirSync(pendingRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readPending(entry.name))
      .filter(Boolean)
      .map(publicPending)
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }

  function installUploadedArchive(upload) {
    const pending = previewUploadedArchive(upload);
    return confirmPendingUpload(pending.pendingUploadId, pending.availableActions.includes('confirm') ? 'confirm' : 'as_new');
  }

  return {
    bundledRoot,
    uploadRoot,
    pendingRoot,
    registryPath,
    defaultPackId,
    listPacks,
    resolvePack,
    setEnabled,
    movePack,
    archivePack,
    restoreArchivedPack,
    deleteArchivedPack,
    installUploadedArchive,
    previewUploadedArchive,
    confirmPendingUpload,
    abandonPendingUpload,
    listPendingUploads
  };

  function discoverBundledPacks() {
    if (!fs.existsSync(bundledRoot)) return [];
    return fs.readdirSync(bundledRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const packDir = path.join(bundledRoot, entry.name);
        const packJson = readPackJsonSafe(packDir);
        return packJson ? { ...packJson, id: packJson.id || entry.name, path: packDir } : null;
      })
      .filter(Boolean);
  }

  function readRegistry() {
    if (!fs.existsSync(registryPath)) return { packs: {} };
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      return { packs: {}, ...registry };
    } catch {
      return { packs: {} };
    }
  }

  function writeRegistry(registry) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ packs: registry.packs || {}, deletedLineages: registry.deletedLineages || [] }, null, 2));
  }

  function pendingPath(pendingUploadId) {
    return path.join(pendingRoot, sanitizePendingId(pendingUploadId), 'pending.json');
  }

  function writePending(pending) {
    fs.writeFileSync(pendingPath(pending.pendingUploadId), JSON.stringify(pending, null, 2));
  }

  function readPending(pendingUploadId) {
    const file = pendingPath(pendingUploadId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function cleanupPending(pendingUploadId) {
    const target = path.join(pendingRoot, sanitizePendingId(pendingUploadId));
    const resolvedRoot = path.resolve(pendingRoot);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget.startsWith(resolvedRoot) && fs.existsSync(resolvedTarget)) {
      fs.rmSync(resolvedTarget, { recursive: true, force: true });
    }
  }
}

function displayOrderValue(pack = {}) {
  const value = Number(pack.displayOrder ?? pack.order);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function normalizePackSummary(pack) {
  const versions = Array.isArray(pack.versions) ? pack.versions : [];
  const status = pack.status || (pack.enabled === false ? 'disabled' : 'active');
  return {
    id: String(pack.id || ''),
    title: pack.title || pack.id || '',
    description: pack.description || '',
    version: pack.version || versions[0]?.version || '',
    language: pack.language || '',
    domain: pack.domain || '',
    sysmlVersion: pack.sysmlVersion || '',
    entryCourseId: pack.entryCourseId || '',
    finalProjectId: pack.finalProjectId || '',
    homeVisual: pack.homeVisual || null,
    displayOrder: Number.isFinite(Number(pack.displayOrder ?? pack.order)) ? Number(pack.displayOrder ?? pack.order) : null,
    enabled: status === 'active',
    status,
    lineageId: pack.lineageId || pack.identity?.lineageId || '',
    dataNamespaceId: pack.dataNamespaceId || pack.lineageId || pack.id || '',
    source: pack.source || 'bundled',
    path: pack.path || '',
    uploadedAt: pack.uploadedAt || versions[0]?.uploadedAt || '',
    originalName: pack.originalName || versions[0]?.originalName || '',
    versionCount: versions.length || 1,
    versions: versions.map((item) => ({
      version: item.version || '',
      uploadedAt: item.uploadedAt || '',
      originalName: item.originalName || '',
      contentVersionId: item.contentVersionId || '',
      contentHash: item.contentHash || '',
      lineageId: item.lineageId || ''
    }))
  };
}

function decideUpload({ registry, packId, packJson, identity, contentHash }) {
  const current = registry.packs?.[packId] || null;
  const currentStatus = current ? packStatus(current) : '';
  const identityLineageId = identity?.lineageId || packJson.identity?.lineageId || '';
  const deletedMatches = findDeletedMatches({ registry, packId, identityLineageId, contentHash });

  if (identityLineageId) {
    const activeConflict = Object.values(registry.packs || {}).find((record) => {
      return record.id !== packId && packStatus(record) !== 'deleted' && record.lineageId === identityLineageId;
    });
    if (activeConflict) {
      return {
        type: 'identity_conflict',
        reason: `身份 ${identityLineageId} 已属于课程包 ${activeConflict.id}。`,
        identityStatus: 'conflict',
        willAssociateStudentData: false,
        targetStatus: 'blocked',
        lineageId: identityLineageId,
        dataNamespaceId: '',
        matchedBy: 'identity-conflict'
      };
    }
  }

  if (current && currentStatus !== 'deleted') {
    return {
      type: 'same_active_lineage',
      reason: 'registry 中存在同 ID 未删除课程包，本次上传将作为该课程的新版本。',
      identityStatus: identityLineageId ? 'valid' : 'not-required',
      willAssociateStudentData: true,
      targetStatus: 'disabled',
      lineageId: current.lineageId || identityLineageId || stableGeneratedLineage(packId),
      dataNamespaceId: current.dataNamespaceId || current.lineageId || packId,
      matchedBy: 'same-id-active'
    };
  }

  if (identityLineageId && deletedMatches.byIdentity) {
    return {
      type: 'restore_deleted_by_identity',
      reason: '上传包身份命中已删除旧课程，将恢复旧课程身份和学生数据关联。',
      identityStatus: 'valid',
      willAssociateStudentData: true,
      targetStatus: 'disabled',
      lineageId: deletedMatches.byIdentity.lineageId,
      dataNamespaceId: deletedMatches.byIdentity.dataNamespaceId || deletedMatches.byIdentity.lineageId || packId,
      matchedBy: 'deleted-identity'
    };
  }

  if (deletedMatches.byHash) {
    return {
      type: 'restore_deleted_by_hash',
      reason: '上传内容指纹命中已删除旧课程版本，将恢复旧课程身份和学生数据关联。',
      identityStatus: identityLineageId ? 'valid' : 'missing',
      willAssociateStudentData: true,
      targetStatus: 'disabled',
      lineageId: deletedMatches.byHash.lineageId || stableGeneratedLineage(packId),
      dataNamespaceId: deletedMatches.byHash.dataNamespaceId || deletedMatches.byHash.lineageId || packId,
      matchedBy: 'deleted-content-hash'
    };
  }

  if (current && currentStatus === 'deleted') {
    const generated = stableGeneratedLineage(`${packId}:${crypto.randomUUID()}`);
    return {
      type: 'same_id_but_identity_missing',
      reason: 'registry 中存在已删除同 ID 课程，但上传包未提供可验证身份，默认作为新课程处理。',
      identityStatus: identityLineageId ? 'unmatched' : 'missing',
      willAssociateStudentData: false,
      targetStatus: 'disabled',
      lineageId: generated,
      dataNamespaceId: generated,
      matchedBy: 'same-id-deleted-no-identity'
    };
  }

  const generated = identityLineageId || stableGeneratedLineage(`${packId}:${crypto.randomUUID()}`);
  return {
    type: 'new_lineage',
    reason: '未发现现有或已删除课程身份匹配，将创建新课程身份。',
    identityStatus: identityLineageId ? 'provided' : 'generated',
    willAssociateStudentData: false,
    targetStatus: 'disabled',
    lineageId: generated,
    dataNamespaceId: generated,
    matchedBy: identityLineageId ? 'provided-identity' : 'new-upload'
  };
}

function availableActionsForDecision(decision) {
  if (decision.type === 'identity_conflict') return ['abandon'];
  if (decision.type === 'restore_deleted_by_identity' || decision.type === 'restore_deleted_by_hash') return ['confirm', 'restore', 'as_new', 'abandon'];
  return ['confirm', 'as_new', 'abandon'];
}

function identityForAction({ registry, pending, packId, action }) {
  if (action === 'as_new') {
    const lineageId = stableGeneratedLineage(`${packId}:${pending.pendingUploadId}:${crypto.randomUUID()}`);
    return { lineageId, dataNamespaceId: lineageId, source: 'forced-new' };
  }
  if (action === 'restore' || action === 'confirm') {
    return {
      lineageId: pending.decision.lineageId || stableGeneratedLineage(packId),
      dataNamespaceId: pending.decision.dataNamespaceId || pending.decision.lineageId || packId,
      source: pending.decision.matchedBy || 'decision'
    };
  }
  const record = registry.packs?.[packId] || {};
  return {
    lineageId: record.lineageId || stableGeneratedLineage(packId),
    dataNamespaceId: record.dataNamespaceId || record.lineageId || packId,
    source: 'existing'
  };
}

function findDeletedMatches({ registry, packId, identityLineageId, contentHash }) {
  const deletedRecords = [
    ...Object.values(registry.packs || {}).filter((record) => record.id === packId && packStatus(record) === 'deleted'),
    ...(Array.isArray(registry.deletedLineages) ? registry.deletedLineages.filter((record) => record.id === packId || record.coursePackId === packId) : [])
  ];
  const byIdentity = identityLineageId
    ? deletedRecords.find((record) => record.lineageId === identityLineageId)
    : null;
  const byHash = contentHash
    ? deletedRecords.find((record) => (record.versions || []).some((version) => version.contentHash === contentHash) || record.contentHash === contentHash)
    : null;
  return { byIdentity, byHash };
}

function readIdentity(packDir, packJson) {
  const jsonIdentity = packJson.identity && typeof packJson.identity === 'object' ? packJson.identity : null;
  const file = path.join(packDir, 'course-pack.identity.json');
  let fileIdentity = null;
  if (fs.existsSync(file)) {
    try {
      fileIdentity = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      fileIdentity = { invalid: true };
    }
  }
  const identity = { ...(jsonIdentity || {}), ...(fileIdentity || {}) };
  if (!Object.keys(identity).length) return null;
  return {
    schemaVersion: identity.schemaVersion || '1.0',
    coursePackId: identity.coursePackId || packJson.id || '',
    lineageId: identity.lineageId || '',
    issuedAt: identity.issuedAt || '',
    issuedBy: identity.issuedBy || '',
    token: identity.token || '',
    invalid: Boolean(identity.invalid)
  };
}

function hashDirectory(dir) {
  const hash = crypto.createHash('sha256');
  for (const file of listFiles(dir).sort()) {
    const relative = path.relative(dir, file).replaceAll('\\', '/');
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function listFiles(dir) {
  const files = [];
  walk(dir, (child) => {
    for (const entry of fs.readdirSync(child, { withFileTypes: true })) {
      const target = path.join(child, entry.name);
      if (entry.isFile()) files.push(target);
    }
  });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isFile()) files.push(target);
  }
  return files;
}

function publicPending(pending) {
  return {
    pendingUploadId: pending.pendingUploadId,
    uploadedAt: pending.uploadedAt,
    originalName: pending.originalName,
    packSummary: pending.packSummary,
    identity: pending.identity ? {
      schemaVersion: pending.identity.schemaVersion,
      coursePackId: pending.identity.coursePackId,
      lineageId: pending.identity.lineageId,
      issuedAt: pending.identity.issuedAt,
      issuedBy: pending.identity.issuedBy,
      hasToken: Boolean(pending.identity.token),
      invalid: Boolean(pending.identity.invalid)
    } : null,
    contentHash: pending.contentHash,
    contentHashShort: String(pending.contentHash || '').slice(0, 12),
    decision: pending.decision,
    availableActions: pending.availableActions || []
  };
}

function latestVersion(record = {}) {
  const versions = Array.isArray(record.versions) ? record.versions : [];
  return versions[0] || null;
}

function packStatus(record = {}, fallback = '') {
  if (record.status) return record.status;
  if (record.deletedAt) return 'deleted';
  if (record.enabled === false) return 'disabled';
  return fallback || 'active';
}

function stableGeneratedLineage(seed) {
  return crypto.createHash('sha256').update(String(seed || crypto.randomUUID())).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
}

function readPackJsonSafe(packDir) {
  try {
    return readPackJson(packDir);
  } catch {
    return null;
  }
}

function readPackJson(packDir) {
  return JSON.parse(fs.readFileSync(path.join(packDir, 'course-pack.json'), 'utf8'));
}

function extractArchive(archivePath, extractDir, ext) {
  try {
    if (ext === '.zip') {
      if (process.platform === 'win32') {
        execFileSync('tar.exe', ['-x', '-f', archivePath, '-C', extractDir], { stdio: 'pipe' });
      } else {
        try {
          execFileSync('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'pipe' });
        } catch {
          execFileSync('7z', ['x', '-y', `-o${extractDir}`, archivePath], { stdio: 'pipe' });
        }
      }
      return;
    }
    try {
      execFileSync('7z', ['x', '-y', `-o${extractDir}`, archivePath], { stdio: 'pipe' });
    } catch {
      execFileSync('unrar', ['x', '-o+', archivePath, `${extractDir}${path.sep}`], { stdio: 'pipe' });
    }
  } catch (error) {
    const wrapped = new Error(`课程包解压失败：${error.message}`);
    wrapped.status = 400;
    wrapped.code = 'ARCHIVE_EXTRACT_FAILED';
    throw wrapped;
  }
}

function findExtractedPackDir(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'course-pack.json'))) return extractDir;
  const candidates = [];
  walk(extractDir, (dir) => {
    if (fs.existsSync(path.join(dir, 'course-pack.json'))) candidates.push(dir);
  });
  if (candidates.length === 1) return candidates[0];
  const error = new Error(candidates.length ? '压缩包内包含多个 course-pack.json，请只提交一个课程包。' : '压缩包内未找到 course-pack.json。');
  error.status = 400;
  error.code = 'INVALID_COURSE_PACK_ARCHIVE';
  throw error;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    visit(child);
    walk(child, visit);
  }
}

function sanitizePackId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
}

function sanitizePendingId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
}

function moveDirectory(source, target) {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

module.exports = { createCoursePackRegistry };
