'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_COUNT = 500;
const MAX_EXTRACTED_BYTES = 80 * 1024 * 1024;
const ALLOWED_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf']);
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.md', '.txt', '.sysml', '.kerml', '.json', '.yaml', '.yml']);
const SUPPORTED_BLOCK_TYPES = new Set(['markdown', 'image', 'callout', 'references', 'concept-map', 'code', 'pdf', 'video']);
const MAX_SOURCE_BYTES = 512 * 1024;

function createKnowledgePackRegistry(options = {}) {
  const bundledRoot = options.knowledgePacksRoot || process.env.KNOWLEDGE_PACKS_ROOT || path.resolve(process.cwd(), 'knowledge-packs');
  const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  const uploadRoot = options.knowledgePackUploadRoot || process.env.KNOWLEDGE_PACK_UPLOAD_ROOT || path.join(dataDir, 'knowledge-packs');
  const pendingRoot = options.knowledgePackPendingRoot || process.env.KNOWLEDGE_PACK_PENDING_ROOT || path.join(dataDir, 'knowledge-pack-upload-pending');
  const registryPath = options.knowledgePackRegistryPath || process.env.KNOWLEDGE_PACK_REGISTRY || path.join(dataDir, 'knowledge-pack-registry.json');
  fs.mkdirSync(bundledRoot, { recursive: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  fs.mkdirSync(pendingRoot, { recursive: true });

  function listPacks({ includeDisabled = false } = {}) {
    const registry = readRegistry(registryPath);
    const entries = new Map();
    for (const dir of childDirectories(bundledRoot)) {
      const manifest = readManifestSafe(dir);
      if (!manifest) continue;
      const record = registry.packs[manifest.id] || {};
      if (record.status === 'deleted') continue;
      entries.set(manifest.id, summary(manifest, dir, {
        source: 'bundled',
        enabled: record.enabled !== undefined ? Boolean(record.enabled) : true,
        status: record.status || (record.enabled === false ? 'disabled' : 'active'),
        displayOrder: record.displayOrder ?? manifest.displayOrder ?? manifest.order ?? 100
      }));
    }
    for (const [id, record] of Object.entries(registry.packs)) {
      if (!record.path || record.status === 'deleted') continue;
      const manifest = readManifestSafe(record.path);
      if (!manifest) continue;
      entries.set(id, summary(manifest, record.path, record));
    }
    return [...entries.values()]
      .filter((pack) => includeDisabled || pack.status === 'active')
      .sort((a, b) => a.displayOrder - b.displayOrder || a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }

  function resolvePack(packId, { includeDisabled = false } = {}) {
    const pack = listPacks({ includeDisabled: true }).find((item) => item.id === packId)
      || listPacks({ includeDisabled: true })[0];
    if (!pack || (!includeDisabled && pack.status !== 'active')) throw apiError('知识包不存在或未启用。', 404, 'KNOWLEDGE_PACK_NOT_FOUND');
    return pack;
  }

  function loadPack(packId) {
    const pack = resolvePack(packId);
    const manifest = readManifest(pack.path);
    return {
      ...summary(manifest, pack.path, pack),
      domains: manifest.domains.map((domain) => ({
        id: domain.id,
        title: domain.title,
        description: domain.description || '',
        order: domain.order || 0,
        topics: domain.topics.map((topicPath) => topicSummary(pack.path, topicPath, domain.id))
      })).sort((a, b) => a.order - b.order),
      references: readReferences(pack.path, manifest)
    };
  }

  function loadTopic(packId, topicId) {
    const pack = resolvePack(packId);
    const manifest = readManifest(pack.path);
    for (const domain of manifest.domains) {
      for (const topicPath of domain.topics) {
        const topic = readJsonInside(pack.path, topicPath);
        if (topic.id !== topicId) continue;
        return {
          ...topic,
          domainId: topic.domainId || domain.id,
          blocks: topic.blocks.map((block) => hydrateBlock(pack.path, block)),
          references: readReferences(pack.path, manifest),
          pack: summary(manifest, pack.path, pack)
        };
      }
    }
    throw apiError('知识主题不存在。', 404, 'KNOWLEDGE_TOPIC_NOT_FOUND');
  }

  function resolveAsset(packId, versionId, assetPath) {
    const pack = resolvePack(packId);
    if (versionId !== pack.contentVersionId) throw apiError('知识资源版本已变化，请刷新页面。', 404, 'KNOWLEDGE_ASSET_VERSION_NOT_FOUND');
    const file = safeJoin(pack.path, assetPath);
    const extension = path.extname(file).toLowerCase();
    if (!ALLOWED_ASSET_EXTENSIONS.has(extension) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw apiError('知识资源不存在。', 404, 'KNOWLEDGE_ASSET_NOT_FOUND');
    }
    return file;
  }

  function previewUploadedArchive({ filename, buffer }) {
    if (!buffer?.length) throw apiError('上传文件为空。', 400, 'KNOWLEDGE_PACK_EMPTY');
    if (buffer.length > MAX_ARCHIVE_BYTES) throw apiError('知识包不能超过 25 MB。', 413, 'KNOWLEDGE_PACK_TOO_LARGE');
    if (path.extname(filename || '').toLowerCase() !== '.zip') throw apiError('首版仅支持 ZIP 知识包。', 400, 'KNOWLEDGE_PACK_FORMAT_UNSUPPORTED');
    const pendingUploadId = crypto.randomUUID();
    const pendingDir = path.join(pendingRoot, pendingUploadId);
    const archivePath = path.join(pendingDir, 'upload.zip');
    const extractDir = path.join(pendingDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(archivePath, buffer);
    validateZipEntries(archivePath);
    extractZip(archivePath, extractDir);
    validateExtractedTree(extractDir);
    const packDir = findPackDir(extractDir);
    const manifest = readManifest(packDir);
    validatePackTree(packDir, manifest);
    const contentHash = hashTree(packDir);
    const existing = listPacks({ includeDisabled: true }).find((item) => item.id === manifest.id);
    const pending = {
      pendingUploadId,
      originalName: path.basename(filename),
      createdAt: new Date().toISOString(),
      extractedPackDir: packDir,
      contentHash,
      decision: existing ? (existing.contentHash === contentHash ? 'duplicate' : 'new_version') : 'new_pack',
      availableActions: existing?.contentHash === contentHash ? ['abandon'] : ['confirm', 'abandon'],
      pack: summary(manifest, packDir, { source: 'pending', enabled: false, status: 'pending', contentHash })
    };
    fs.writeFileSync(path.join(pendingDir, 'pending.json'), JSON.stringify(pending, null, 2));
    return publicPending(pending);
  }

  function listPendingUploads() {
    return childDirectories(pendingRoot).map((dir) => readJsonSafe(path.join(dir, 'pending.json'))).filter(Boolean).map(publicPending);
  }

  function confirmPendingUpload(pendingUploadId) {
    const pendingDir = safeJoin(pendingRoot, pendingUploadId);
    const pending = readJsonSafe(path.join(pendingDir, 'pending.json'));
    if (!pending) throw apiError('待确认知识包不存在。', 404, 'KNOWLEDGE_PACK_PENDING_NOT_FOUND');
    if (!pending.availableActions.includes('confirm')) throw apiError('该上传不能重复确认。', 409, 'KNOWLEDGE_PACK_DUPLICATE');
    const manifest = readManifest(pending.extractedPackDir);
    const versionDirName = `${sanitizeSegment(manifest.version)}-${pending.contentHash.slice(0, 10)}`;
    const targetDir = path.join(uploadRoot, sanitizeSegment(manifest.id), versionDirName);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(pending.extractedPackDir, targetDir, { recursive: true, force: false });
    const registry = readRegistry(registryPath);
    const previous = registry.packs[manifest.id] || {};
    registry.packs[manifest.id] = {
      ...previous,
      id: manifest.id,
      path: targetDir,
      enabled: false,
      status: 'disabled',
      source: 'uploaded',
      contentHash: pending.contentHash,
      displayOrder: previous.displayOrder ?? manifest.displayOrder ?? manifest.order ?? 100,
      updatedAt: new Date().toISOString()
    };
    writeRegistry(registryPath, registry);
    fs.rmSync(pendingDir, { recursive: true, force: true });
    return resolvePack(manifest.id, { includeDisabled: true });
  }

  function abandonPendingUpload(pendingUploadId) {
    const pendingDir = safeJoin(pendingRoot, pendingUploadId);
    fs.rmSync(pendingDir, { recursive: true, force: true });
    return { ok: true, pendingUploadId, abandoned: true };
  }

  function mutate(packId, operation) {
    const current = resolvePack(packId, { includeDisabled: true });
    const registry = readRegistry(registryPath);
    const record = { ...(registry.packs[packId] || {}), id: packId, path: current.source === 'uploaded' ? current.path : undefined };
    if (operation === 'enable') Object.assign(record, { enabled: true, status: 'active' });
    if (operation === 'disable') Object.assign(record, { enabled: false, status: 'disabled' });
    if (operation === 'archive') Object.assign(record, { enabled: false, status: 'archived', archivedAt: new Date().toISOString() });
    if (operation === 'restore') Object.assign(record, { enabled: false, status: 'disabled', archivedAt: null });
    if (operation === 'delete') {
      if (current.status !== 'archived') throw apiError('知识包必须先归档，才能删除。', 409, 'KNOWLEDGE_PACK_DELETE_REQUIRES_ARCHIVED');
      Object.assign(record, { enabled: false, status: 'deleted', deletedAt: new Date().toISOString() });
    }
    record.updatedAt = new Date().toISOString();
    registry.packs[packId] = record;
    writeRegistry(registryPath, registry);
    return operation === 'delete' ? { ok: true, packId, status: 'deleted' } : resolvePack(packId, { includeDisabled: true });
  }

  function setEnabled(packId, enabled) { return mutate(packId, enabled ? 'enable' : 'disable'); }
  function archivePack(packId) { return mutate(packId, 'archive'); }
  function restoreArchivedPack(packId) { return mutate(packId, 'restore'); }
  function deleteArchivedPack(packId) { return mutate(packId, 'delete'); }

  return { listPacks, resolvePack, loadPack, loadTopic, resolveAsset, previewUploadedArchive, listPendingUploads, confirmPendingUpload, abandonPendingUpload, setEnabled, archivePack, restoreArchivedPack, deleteArchivedPack };
}

function readManifest(packDir) {
  const manifest = readJsonSafe(path.join(packDir, 'knowledge-pack.json'));
  if (!manifest) throw apiError('知识包缺少 knowledge-pack.json。', 400, 'KNOWLEDGE_PACK_MANIFEST_MISSING');
  validateManifest(manifest);
  return manifest;
}

function readManifestSafe(packDir) { try { return readManifest(packDir); } catch { return null; } }
function validateManifest(manifest) {
  if (manifest.schemaVersion !== '1.0') throw apiError('知识包 schemaVersion 必须为 1.0。', 400, 'KNOWLEDGE_PACK_SCHEMA_UNSUPPORTED');
  for (const key of ['id', 'title', 'version']) if (typeof manifest[key] !== 'string' || !manifest[key].trim()) throw apiError(`知识包缺少 ${key}。`, 400, 'KNOWLEDGE_PACK_INVALID');
  if (!Array.isArray(manifest.domains) || manifest.domains.length === 0) throw apiError('知识包至少需要一个知识域。', 400, 'KNOWLEDGE_PACK_INVALID');
  for (const domain of manifest.domains) {
    if (!domain?.id || !domain?.title || !Array.isArray(domain.topics) || domain.topics.length === 0) throw apiError('知识域必须包含 id、title 和 topics。', 400, 'KNOWLEDGE_PACK_INVALID');
  }
}

function validatePackTree(packDir, manifest) {
  const ids = new Set();
  for (const domain of manifest.domains) for (const topicPath of domain.topics) {
    const topic = readJsonInside(packDir, topicPath);
    if (!topic.id || !topic.title || !Array.isArray(topic.blocks)) throw apiError(`主题文件无效：${topicPath}`, 400, 'KNOWLEDGE_TOPIC_INVALID');
    if (ids.has(topic.id)) throw apiError(`主题 ID 重复：${topic.id}`, 400, 'KNOWLEDGE_TOPIC_DUPLICATE');
    ids.add(topic.id);
    for (const block of topic.blocks) {
      validateBlock(packDir, block);
    }
  }
}

function topicSummary(packDir, topicPath, domainId) {
  const topic = readJsonInside(packDir, topicPath);
  return { id: topic.id, domainId: topic.domainId || domainId, title: topic.title, summary: topic.summary || '', order: topic.order || 0, estimatedMinutes: topic.estimatedMinutes || 0 };
}
function hydrateBlock(packDir, block) {
  validateBlock(packDir, block);
  if ((block.type === 'markdown' || block.type === 'code') && block.source) return { ...block, content: fs.readFileSync(safeJoin(packDir, block.source), 'utf8') };
  return { ...block };
}
function validateBlock(packDir, block) {
  if (!block?.id || !SUPPORTED_BLOCK_TYPES.has(block.type)) throw apiError(`不支持的内容块：${block?.type || 'unknown'}`, 400, 'KNOWLEDGE_BLOCK_INVALID');
  if (block.source) {
    if (!['markdown', 'code'].includes(block.type)) throw apiError(`内容块不允许 source：${block.id}`, 400, 'KNOWLEDGE_BLOCK_SOURCE_INVALID');
    const source = safeJoin(packDir, block.source);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw apiError(`内容源不存在：${block.source}`, 400, 'KNOWLEDGE_BLOCK_SOURCE_MISSING');
    if (!ALLOWED_SOURCE_EXTENSIONS.has(path.extname(source).toLowerCase()) || fs.statSync(source).size > MAX_SOURCE_BYTES) throw apiError(`内容源格式或大小无效：${block.source}`, 400, 'KNOWLEDGE_BLOCK_SOURCE_INVALID');
  }
  if (block.type === 'code' && !block.source && typeof block.content !== 'string') throw apiError(`代码块缺少 source 或 content：${block.id}`, 400, 'KNOWLEDGE_BLOCK_INVALID');
  if (block.asset) {
    if (!['image', 'pdf'].includes(block.type)) throw apiError(`内容块不允许 asset：${block.id}`, 400, 'KNOWLEDGE_BLOCK_ASSET_INVALID');
    const asset = safeJoin(packDir, block.asset);
    const extension = path.extname(asset).toLowerCase();
    if (!fs.existsSync(asset) || !fs.statSync(asset).isFile() || !ALLOWED_ASSET_EXTENSIONS.has(extension)) throw apiError(`知识资源无效：${block.asset}`, 400, 'KNOWLEDGE_BLOCK_ASSET_INVALID');
    if (block.type === 'image' && extension === '.pdf') throw apiError(`图片块不能使用 PDF：${block.asset}`, 400, 'KNOWLEDGE_BLOCK_ASSET_INVALID');
    if (block.type === 'pdf' && extension !== '.pdf') throw apiError(`PDF 块必须使用 PDF 文件：${block.asset}`, 400, 'KNOWLEDGE_BLOCK_ASSET_INVALID');
  }
  if (block.type === 'pdf' && !block.asset) throw apiError(`PDF 块缺少 asset：${block.id}`, 400, 'KNOWLEDGE_BLOCK_INVALID');
  if (block.type === 'video') validateVideoBlock(block);
}
function validateVideoBlock(block) {
  if (!['youtube', 'bilibili'].includes(block.provider)) throw apiError(`视频 Provider 不受支持：${block.provider || 'unknown'}`, 400, 'KNOWLEDGE_VIDEO_PROVIDER_INVALID');
  if (block.url || block.embedUrl || block.src || block.asset) throw apiError('视频块不能提供任意 URL 或本地视频资源。', 400, 'KNOWLEDGE_VIDEO_SOURCE_INVALID');
  if (block.provider === 'youtube') {
    const videoValid = typeof block.videoId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(block.videoId);
    const playlistValid = typeof block.playlistId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(block.playlistId);
    if (videoValid === playlistValid) throw apiError('YouTube 视频块必须且只能提供 videoId 或 playlistId。', 400, 'KNOWLEDGE_VIDEO_ID_INVALID');
  }
  if (block.provider === 'bilibili' && (typeof block.videoId !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(block.videoId) || block.playlistId)) throw apiError('哔哩哔哩视频块必须提供合法 BV 号。', 400, 'KNOWLEDGE_VIDEO_ID_INVALID');
}
function readReferences(packDir, manifest) { return manifest.references ? (readJsonInside(packDir, manifest.references).references || []) : []; }
function summary(manifest, packDir, record = {}) {
  const contentHash = record.contentHash || hashTree(packDir);
  return { id: manifest.id, title: manifest.title, description: manifest.description || '', version: manifest.version, language: manifest.language || 'zh-CN', entryTopicId: manifest.entryTopicId || '', displayOrder: Number(record.displayOrder ?? manifest.displayOrder ?? 100), enabled: record.enabled !== false, status: record.status || 'active', source: record.source || 'bundled', contentHash, contentVersionId: `${sanitizeSegment(manifest.version)}-${contentHash.slice(0, 10)}`, path: packDir };
}
function publicPending(pending) { const { extractedPackDir, ...safe } = pending; return safe; }
function readRegistry(file) { const value = readJsonSafe(file); return { packs: {}, ...(value || {}) }; }
function writeRegistry(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readJsonInside(root, relativePath) { const value = readJsonSafe(safeJoin(root, relativePath)); if (!value) throw apiError(`无法读取知识包文件：${relativePath}`, 400, 'KNOWLEDGE_PACK_FILE_INVALID'); return value; }
function childDirectories(root) { if (!fs.existsSync(root)) return []; return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)); }
function safeJoin(root, relativePath) { const target = path.resolve(root, String(relativePath || '').replace(/\\/g, '/')); const base = path.resolve(root) + path.sep; if (target !== path.resolve(root) && !target.startsWith(base)) throw apiError('知识包路径越界。', 400, 'KNOWLEDGE_PACK_PATH_INVALID'); return target; }
function sanitizeSegment(value) { const result = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''); if (!result) throw apiError('知识包标识无效。', 400, 'KNOWLEDGE_PACK_ID_INVALID'); return result; }
function hashTree(root) { const hash = crypto.createHash('sha256'); const files = []; walk(root, (file) => files.push(file)); for (const file of files.sort()) { hash.update(path.relative(root, file).replace(/\\/g, '/')); hash.update(fs.readFileSync(file)); } return hash.digest('hex'); }
function walk(root, visit) { for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const target = path.join(root, entry.name); if (entry.isDirectory()) walk(target, visit); else if (entry.isFile()) visit(target); } }
function findPackDir(root) { if (fs.existsSync(path.join(root, 'knowledge-pack.json'))) return root; const matches = []; for (const dir of childDirectories(root)) if (fs.existsSync(path.join(dir, 'knowledge-pack.json'))) matches.push(dir); if (matches.length !== 1) throw apiError('ZIP 根目录必须包含且只能包含一个 Knowledge Pack。', 400, 'KNOWLEDGE_PACK_ROOT_INVALID'); return matches[0]; }
function validateZipEntries(archivePath) {
  let entries;
  if (process.platform === 'win32') {
    const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${archivePath.replace(/'/g, "''")}').Entries | ForEach-Object { $_.FullName }`;
    entries = execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } else entries = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_ENTRY_COUNT) throw apiError('知识包文件数量超过 500。', 400, 'KNOWLEDGE_PACK_TOO_MANY_FILES');
  for (const entry of entries) if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw apiError('ZIP 包含越界路径。', 400, 'KNOWLEDGE_PACK_PATH_INVALID');
}
function extractZip(archivePath, extractDir) {
  if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`]);
  else execFileSync('unzip', ['-q', archivePath, '-d', extractDir]);
}
function validateExtractedTree(root) { let count = 0; let bytes = 0; walk(root, (file) => { count += 1; bytes += fs.statSync(file).size; }); if (count > MAX_ENTRY_COUNT || bytes > MAX_EXTRACTED_BYTES) throw apiError('知识包解压后超出安全限制。', 400, 'KNOWLEDGE_PACK_EXTRACT_LIMIT'); }
function apiError(message, status, code) { const error = new Error(message); error.status = status; error.code = code; return error; }

module.exports = { createKnowledgePackRegistry };
