'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  OfficialValidatorBackend,
  hashFileSync,
  hashPathSync
} = require('../apps/validator/official-backend');
const {
  TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION,
  hashContent,
  validateOfficialValidatorAttestation
} = require('../packages/teacher-contract');
const reviewedManifest = require('../packages/teacher-contract/official-validator-runtime-artifacts.json');

function aggregateOf(value) {
  return {
    source: value.source,
    releaseTag: value.releaseTag,
    kernelVersion: value.kernelVersion,
    jarHash: value.jarHash,
    libraryHash: value.libraryHash,
    wrapperHash: value.wrapperHash
  };
}

function flipOneBit(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert(bytes.length > 0);
  bytes[0] ^= 0x01;
  fs.writeFileSync(filePath, bytes);
}

function createFixture(root) {
  const archivePath = path.join(root, 'kernel.zip');
  const jarPath = path.join(root, 'kernel.jar');
  const libraryPath = path.join(root, 'library');
  const wrapperPath = path.join(root, 'wrapper');
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.mkdirSync(wrapperPath, { recursive: true });
  fs.writeFileSync(archivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  fs.writeFileSync(jarPath, Buffer.from('reviewed-jar'));
  fs.writeFileSync(path.join(libraryPath, 'Systems.sysml'), 'package Systems;\n');
  fs.writeFileSync(path.join(wrapperPath, 'OfficialValidatorCli.class'), Buffer.from('reviewed-wrapper'));
  const aggregate = {
    source: 'official-sysml-v2-pilot-2026-04',
    releaseTag: '2026-04',
    kernelVersion: '0.59.0',
    jarHash: hashFileSync(jarPath),
    libraryHash: hashPathSync(libraryPath),
    wrapperHash: hashPathSync(wrapperPath)
  };
  const manifest = {
    schemaVersion: 'official-validator-artifact-manifest/v1',
    source: aggregate.source,
    releaseTag: aggregate.releaseTag,
    kernelVersion: aggregate.kernelVersion,
    upstream: { archiveHash: hashFileSync(archivePath) },
    components: {
      jarHash: aggregate.jarHash,
      libraryHash: aggregate.libraryHash,
      wrapperHash: aggregate.wrapperHash
    },
    artifactHash: hashContent(JSON.stringify(aggregate))
  };
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { archivePath, jarPath, libraryPath, wrapperPath, manifestPath };
}

function main() {
  const validatorDockerfile = fs.readFileSync(path.join(__dirname, '..', 'apps', 'validator', 'Dockerfile'), 'utf8');
  assert.match(
    validatorDockerfile,
    /COPY packages\/teacher-contract\/official-validator-runtime-artifacts\.json/u,
    'Validator image must package the runtime artifact manifest used by the backend'
  );
  assert.match(
    validatorDockerfile,
    /--manifest \/app\/packages\/teacher-contract\/official-validator-runtime-artifacts\.json/u,
    'Validator image build must verify the current wrapper against the runtime artifact manifest'
  );
  assert.deepEqual(
    TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION,
    { ...aggregateOf(TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION), artifactHash: reviewedManifest.artifactHash }
  );
  assert.equal(
    hashContent(JSON.stringify(aggregateOf(TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION))),
    reviewedManifest.artifactHash,
    'reviewed aggregate must bind the exact reviewed component hashes'
  );
  assert.equal(validateOfficialValidatorAttestation(TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION).ok, true);
  const forged = {
    ...TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION,
    jarHash: hashContent('attacker-controlled-jar')
  };
  forged.artifactHash = hashContent(JSON.stringify(aggregateOf(forged)));
  const forgedResult = validateOfficialValidatorAttestation(forged);
  assert.equal(forgedResult.ok, false, 'a forged but self-consistent aggregate must be rejected');
  assert(forgedResult.errors.some((message) => message.includes('reviewed official artifact manifest')));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-artifact-trust-'));
  try {
    const fixture = createFixture(tempRoot);
    const trusted = new OfficialValidatorBackend({
      manifestPath: fixture.manifestPath,
      jarPath: fixture.jarPath,
      libraryPath: fixture.libraryPath,
      classesPath: fixture.wrapperPath
    });
    assert.equal(trusted.artifactTrust().ok, true);

    const verifier = path.join(__dirname, '..', 'apps', 'validator', 'official', 'verify-artifact-manifest.js');
    const args = [
      verifier,
      '--manifest', fixture.manifestPath,
      '--archive', fixture.archivePath,
      '--jar', fixture.jarPath,
      '--library', fixture.libraryPath,
      '--wrapper', fixture.wrapperPath
    ];
    const verifiedBuild = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(verifiedBuild.status, 0, verifiedBuild.stderr);

    flipOneBit(fixture.jarPath);
    const tampered = new OfficialValidatorBackend({
      manifestPath: fixture.manifestPath,
      jarPath: fixture.jarPath,
      libraryPath: fixture.libraryPath,
      classesPath: fixture.wrapperPath
    });
    assert.equal(tampered.artifactTrust().ok, false, 'a one-bit component change must break trust');
    assert(tampered.artifactTrust().errors.includes('observed_jarHash_mismatch'));
    const rejectedComponentBuild = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(rejectedComponentBuild.status, 0, 'build verifier must reject a modified component');

    flipOneBit(fixture.jarPath);
    flipOneBit(fixture.archivePath);
    const rejectedArchiveBuild = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(rejectedArchiveBuild.status, 0, 'build verifier must reject a modified upstream archive');
    assert.match(rejectedArchiveBuild.stderr, /archive hash does not match/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('official Validator artifact trust tests passed');
}

main();
