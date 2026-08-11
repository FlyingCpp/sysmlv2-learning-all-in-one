'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifest = require('../packages/teacher-contract/official-validator-runtime-artifacts.json');
const kernelVersion = manifest.kernelVersion;
const releaseTag = manifest.releaseTag;
const archiveName = manifest.upstream.archiveFile;
const expectedArchiveHash = stripHashPrefix(manifest.upstream.archiveHash);
const expectedJarHash = stripHashPrefix(manifest.components.jarHash);
const cacheRoot = path.join(root, '.official-cache');
const archivePath = path.join(cacheRoot, archiveName);
const kernelRoot = path.join(cacheRoot, `kernel-${kernelVersion}`);
const jarPath = path.join(kernelRoot, 'sysml', `jupyter-sysml-kernel-${kernelVersion}-all.jar`);
const libraryPath = path.join(kernelRoot, 'sysml', 'sysml.library');
const downloadUrl = `https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/releases/download/${releaseTag}/${archiveName}`;

async function main() {
  if (isVerifiedRuntime()) {
    console.log(`official validator runtime ready: ${kernelVersion}`);
    return;
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  await ensureArchive();
  if (fs.existsSync(kernelRoot)) {
    throw new Error(`Incomplete official validator cache already exists: ${kernelRoot}`);
  }
  fs.mkdirSync(kernelRoot, { recursive: true });
  const result = spawnSync(process.env.JAR_BIN || 'jar', ['xf', archivePath], {
    cwd: kernelRoot,
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error(`jar extraction failed with status ${String(result.status)}`);
  if (!isVerifiedRuntime()) throw new Error('Extracted official validator runtime failed integrity verification.');
  console.log(`official validator runtime installed: ${kernelVersion}`);
}

async function ensureArchive() {
  if (fs.existsSync(archivePath) && sha256(archivePath) === expectedArchiveHash) return;
  const temporaryPath = `${archivePath}.download`;
  const response = await fetch(downloadUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Official validator download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(temporaryPath, bytes, { flag: 'wx' });
  if (sha256(temporaryPath) !== expectedArchiveHash) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error('Downloaded official validator archive failed SHA-256 verification.');
  }
  fs.renameSync(temporaryPath, archivePath);
}

function isVerifiedRuntime() {
  return fs.existsSync(jarPath)
    && fs.existsSync(libraryPath)
    && sha256(jarPath) === expectedJarHash;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stripHashPrefix(value) {
  return String(value || '').replace(/^sha256:/u, '');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
