'use strict';

const path = require('path');
const {
  OfficialValidatorBackend,
  hashFileSync,
  loadArtifactManifest
} = require('../official-backend');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return path.resolve(process.argv[index + 1]);
}

function main() {
  const manifestPath = valueAfter('--manifest');
  const archivePath = valueAfter('--archive');
  const manifest = loadArtifactManifest(manifestPath);
  const observedArchiveHash = hashFileSync(archivePath);
  if (observedArchiveHash !== manifest.upstream?.archiveHash) {
    throw new Error('Official Validator archive hash does not match the reviewed manifest.');
  }

  const backend = new OfficialValidatorBackend({
    manifestPath,
    jarPath: valueAfter('--jar'),
    libraryPath: valueAfter('--library'),
    classesPath: valueAfter('--wrapper')
  });
  const trust = backend.artifactTrust();
  if (!trust.ok) {
    throw new Error(`Official Validator component verification failed: ${trust.errors.join('; ')}`);
  }
  process.stdout.write(`${JSON.stringify({
    source: trust.attestation.source,
    releaseTag: trust.attestation.releaseTag,
    kernelVersion: trust.attestation.kernelVersion,
    archiveHash: observedArchiveHash,
    artifactHash: trust.attestation.artifactHash
  })}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Official Validator artifact verification failed.');
  process.exitCode = 1;
}
