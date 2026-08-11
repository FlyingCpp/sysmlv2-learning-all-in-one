'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OFFICIAL_SOURCE_BASELINE = Object.freeze({
  release: Object.freeze({
    repository: 'Systems-Modeling/SysML-v2-Release',
    tag: '2026-05',
    commit: 'de1070ae8e79c21532b8004fc663d47b35d0e9fa',
    releaseUrl: 'https://github.com/Systems-Modeling/SysML-v2-Release/releases/tag/2026-05',
    licensePath: 'LICENSE',
    trainingRoot: 'sysml/src/training',
    expectedTrainingFileCount: 100,
    standardLibraryRoot: 'sysml.library',
    expectedStandardLibraryFileCount: 94,
    expectedTextualUnionUniqueProductionCount: 558,
    bnfSources: Object.freeze([
      Object.freeze({
        path: 'bnf/KerML-textual-bnf.kebnf',
        blob: '914b7a72953e3310b86dae8fa24668b814ce75ed',
        kind: 'textual',
        expectedOccurrenceCount: 290,
      }),
      Object.freeze({
        path: 'bnf/SysML-textual-bnf.kebnf',
        blob: 'd997e23aaed3c0af45a082dd7df27dccf0ef83a2',
        kind: 'textual',
        expectedOccurrenceCount: 351,
      }),
      Object.freeze({
        path: 'bnf/SysML-graphical-bnf.kgbnf',
        blob: '7d20382b8b5f8b84c85492a1ab1176fc6dbeccda',
        kind: 'graphical',
        expectedOccurrenceCount: 639,
        expectedUniqueProductionCount: 525,
      }),
    ]),
  }),
  pilot: Object.freeze({
    repository: 'Systems-Modeling/SysML-v2-Pilot-Implementation',
    tag: '2026-05',
    commit: 'fa709f28dfd49dfdb7ee83e4e19da2f57e0eb3aa',
    pluginVersion: '0.60.1',
    releaseUrl: 'https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/releases/tag/2026-05',
    files: Object.freeze([
      Object.freeze({
        kind: 'grammar',
        path: 'org.omg.kerml.expressions.xtext/src/org/omg/kerml/expressions/xtext/KerMLExpressions.xtext',
        blob: '2df593c9f88ba87ce657b1b20010d0f462f4cad1',
      }),
      Object.freeze({
        kind: 'grammar',
        path: 'org.omg.kerml.xtext/src/org/omg/kerml/xtext/KerML.xtext',
        blob: 'cf583f04dedffb8e57a91d5f9d5ef688a328d54d',
      }),
      Object.freeze({
        kind: 'grammar',
        path: 'org.omg.sysml.xtext/src/org/omg/sysml/xtext/SysML.xtext',
        blob: '1bf96c1bdcf97eb1c091ceb90578240c7ed59e76',
      }),
      Object.freeze({
        kind: 'metamodel',
        path: 'org.omg.sysml.model/src/main/resources/model/SysML.ecore',
        blob: '88a1e51a28346ced307a1bd2d67bd90e5762d9fc',
      }),
      Object.freeze({
        kind: 'metamodel',
        path: 'org.omg.sysml/model/kerml.ecore',
        blob: '0e967e777926ae23a9b6c73ef4539ccf38f384ea',
      }),
    ]),
  }),
  formalExamTrack: Object.freeze({
    languageVersion: '2.0',
    sysml: Object.freeze({
      url: 'https://www.omg.org/spec/SysML/2.0/About-SysML',
      formalFileId: 'formal/26-03-02',
    }),
    kerml: Object.freeze({
      url: 'https://www.omg.org/spec/KerML/1.0/About-KerML',
      formalFileId: 'formal/26-03-01',
    }),
    modelUserExam: Object.freeze({
      url: 'https://www.omg.org/certification/sysml2/SysMLv2-MU.pdf',
      sha256: 'sha256:76196aa48a89a93bb14b54a7475a50133cb2ef4266bd5e8be50c702d51a436ab',
    }),
    referenceImplementation: Object.freeze({
      release: Object.freeze({
        tag: '2026-04',
        commit: '9baca5908ca28b53da085de69336fde48420ea8f',
      }),
      pilot: Object.freeze({
        tag: '2026-04',
        commit: '20897e3122f2c2f8b29389745f0caaaeb7c6e21a',
        pluginVersion: '0.59.0',
      }),
    }),
  }),
});

function usage() {
  return [
    'Usage: node scripts/sysml-knowledge/import-official-source-baseline.js [options]',
    '',
    'Required:',
    '  --release-root <path>      Git checkout at SysML-v2-Release tag 2026-05.',
    '  --pilot-root <path>        Git checkout at Pilot-Implementation tag 2026-05.',
    '  --output-root <path>       New, non-existing generated baseline directory.',
    '',
    'Optional:',
    '  --model-user-pdf <path>   Local official OMG Model User PDF; hash only, never copied.',
    '  --help                    Show this help.',
  ].join('\n');
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--release-root' || argument === '--release-2026-05-root') {
      options.releaseRoot = path.resolve(requireOptionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--pilot-root' || argument === '--pilot-2026-05-root') {
      options.pilotRoot = path.resolve(requireOptionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--model-user-pdf') {
      options.modelUserPdf = path.resolve(requireOptionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--output-root') {
      options.outputRoot = path.resolve(requireOptionValue(argv, index, argument));
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!options.help) {
    for (const [property, option] of [
      ['releaseRoot', '--release-root'],
      ['pilotRoot', '--pilot-root'],
      ['outputRoot', '--output-root'],
    ]) {
      if (!options[property]) {
        throw new Error(`${option} is required.`);
      }
    }
  }
  return options;
}

function sha256(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function gitBlobSha1(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(bytes).digest('hex');
}

function normalizeRepositoryPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function runGit(root, args, options = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: options.binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Unable to run git for ${root}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr || '').trim();
    throw new Error(`Git command failed for ${root}: ${message || args.join(' ')}`);
  }
  return result.stdout;
}

function createGitSourceAccess() {
  return {
    resolveIdentity(root, expected) {
      const head = String(runGit(root, ['rev-parse', 'HEAD'])).trim().toLowerCase();
      const taggedCommit = String(runGit(
        root,
        ['rev-parse', '--verify', `refs/tags/${expected.tag}^{commit}`],
      )).trim().toLowerCase();
      return { commit: head, tag: taggedCommit === head ? expected.tag : null };
    },
    listFiles(root, commit, repositoryPath) {
      const output = runGit(
        root,
        ['ls-tree', '-r', '-z', '--name-only', commit, '--', normalizeRepositoryPath(repositoryPath)],
        { binary: true },
      );
      return output
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(normalizeRepositoryPath);
    },
    readFile(root, commit, repositoryPath) {
      return runGit(
        root,
        ['show', `${commit}:${normalizeRepositoryPath(repositoryPath)}`],
        { binary: true },
      );
    },
  };
}

function assertSourceIdentity(identity, expected, label) {
  const commit = String(identity?.commit || '').toLowerCase();
  if (identity?.tag !== expected.tag) {
    throw new Error(`${label} must be checked out at tag ${expected.tag}; observed ${identity?.tag || 'none'}.`);
  }
  if (commit !== expected.commit) {
    throw new Error(`${label} commit mismatch: expected ${expected.commit}, observed ${commit || 'none'}.`);
  }
}

function assertKnownBlob(content, expectedBlob, repositoryPath) {
  const observed = gitBlobSha1(content);
  if (observed !== expectedBlob) {
    throw new Error(
      `Official source blob mismatch for ${repositoryPath}: expected ${expectedBlob}, observed ${observed}.`,
    );
  }
}

function extractBnfProductions(content, kind) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const lines = text.split(/\r\n|\n|\r/u);
  const pattern = kind === 'graphical'
    ? /^([a-z][a-z0-9-]*)[ \t]*=/u
    : /^([A-Z][A-Za-z0-9_]*)[ \t]*(?::[^=\r\n]+)?[ \t]*=/u;
  const productions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (match) {
      productions.push({ name: match[1], line: index + 1 });
    }
  }
  return productions;
}

function statisticsFor(productions) {
  const uniqueNames = new Set(productions.map((production) => production.name));
  return {
    occurrenceCount: productions.length,
    uniqueProductionCount: uniqueNames.size,
    duplicateOccurrenceCount: productions.length - uniqueNames.size,
  };
}

function githubBlobUrl(repository, tag, repositoryPath) {
  return `https://github.com/${repository}/blob/${tag}/${normalizeRepositoryPath(repositoryPath)}`;
}

function createBnfCatalog(releaseRoot, definition, sourceAccess) {
  const sources = definition.bnfSources.map((source) => {
    const content = sourceAccess.readFile(releaseRoot, definition.commit, source.path);
    assertKnownBlob(content, source.blob, source.path);
    const productions = extractBnfProductions(content, source.kind);
    const statistics = statisticsFor(productions);
    if (statistics.occurrenceCount !== source.expectedOccurrenceCount) {
      throw new Error(
        `BNF production count mismatch for ${source.path}: expected ${source.expectedOccurrenceCount}, ` +
        `observed ${statistics.occurrenceCount}.`,
      );
    }
    if (
      source.expectedUniqueProductionCount != null &&
      statistics.uniqueProductionCount !== source.expectedUniqueProductionCount
    ) {
      throw new Error(
        `BNF unique production count mismatch for ${source.path}: expected ` +
        `${source.expectedUniqueProductionCount}, observed ${statistics.uniqueProductionCount}.`,
      );
    }
    return {
      url: githubBlobUrl(definition.repository, definition.tag, source.path),
      blob: source.blob,
      hash: { sha256: sha256(content) },
      licenseReviewRequired: true,
      statistics,
      productions,
    };
  });

  const textualNames = new Set();
  for (let index = 0; index < definition.bnfSources.length; index += 1) {
    if (definition.bnfSources[index].kind === 'textual') {
      for (const production of sources[index].productions) {
        textualNames.add(production.name);
      }
    }
  }
  if (textualNames.size !== definition.expectedTextualUnionUniqueProductionCount) {
    throw new Error(
      'Textual BNF union count mismatch: expected ' +
      `${definition.expectedTextualUnionUniqueProductionCount}, observed ${textualNames.size}.`,
    );
  }

  return {
    schemaVersion: 'derived-bnf-production-catalog/v1',
    derivedOnly: true,
    licenseReviewRequired: true,
    statistics: {
      sourceCount: sources.length,
      productionOccurrenceCount: sources.reduce(
        (total, source) => total + source.statistics.occurrenceCount,
        0,
      ),
      textualUniqueProductionCount: textualNames.size,
    },
    sources,
  };
}

function assertEplLicense(content) {
  const text = content.toString('utf8');
  if (!text.includes('Eclipse Public License - v 2.0')) {
    throw new Error('Release LICENSE does not contain the expected Eclipse Public License v2.0 marker.');
  }
}

function readModelUserPdf(modelUserPdf, expectedSha256) {
  if (!modelUserPdf) {
    return null;
  }
  const content = fs.readFileSync(modelUserPdf);
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`Model User artifact is not a PDF: ${modelUserPdf}`);
  }
  const observedSha256 = sha256(content);
  if (observedSha256 !== expectedSha256) {
    throw new Error(
      `Model User PDF hash mismatch: expected ${expectedSha256}, observed ${observedSha256}.`,
    );
  }
  return { sha256: observedSha256 };
}

function importedFileRecord(repository, sourcePath, outputPath, kind, content, extra = {}) {
  return {
    repository,
    sourcePath: normalizeRepositoryPath(sourcePath),
    outputPath: normalizeRepositoryPath(outputPath),
    kind,
    hash: {
      sha256: sha256(content),
      gitBlobSha1: gitBlobSha1(content),
    },
    ...extra,
  };
}

function createImportPlan(options, sourceDefinition, sourceAccess) {
  const release = sourceDefinition.release;
  const pilot = sourceDefinition.pilot;
  const releaseIdentity = sourceAccess.resolveIdentity(options.releaseRoot, release);
  const pilotIdentity = sourceAccess.resolveIdentity(options.pilotRoot, pilot);
  assertSourceIdentity(releaseIdentity, release, 'SysML-v2-Release');
  assertSourceIdentity(pilotIdentity, pilot, 'SysML-v2-Pilot-Implementation');

  const files = [];
  const licenseContent = sourceAccess.readFile(options.releaseRoot, release.commit, release.licensePath);
  assertEplLicense(licenseContent);
  const releaseLicenseOutput = `sources/release-${release.tag}/${release.licensePath}`;
  files.push({
    content: licenseContent,
    outputPath: releaseLicenseOutput,
    record: importedFileRecord(
      release.repository,
      release.licensePath,
      releaseLicenseOutput,
      'license',
      licenseContent,
      { spdxLicense: 'EPL-2.0' },
    ),
  });

  const trainingFiles = sourceAccess
    .listFiles(options.releaseRoot, release.commit, release.trainingRoot)
    .filter((sourcePath) =>
      sourcePath.startsWith(`${release.trainingRoot}/`) && sourcePath.endsWith('.sysml'),
    )
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (trainingFiles.length !== release.expectedTrainingFileCount) {
    throw new Error(
      `Training model count mismatch: expected ${release.expectedTrainingFileCount}, ` +
      `observed ${trainingFiles.length}.`,
    );
  }
  for (const sourcePath of trainingFiles) {
    const content = sourceAccess.readFile(options.releaseRoot, release.commit, sourcePath);
    const outputPath = `sources/release-${release.tag}/${normalizeRepositoryPath(sourcePath)}`;
    files.push({
      content,
      outputPath,
      record: importedFileRecord(
        release.repository,
        sourcePath,
        outputPath,
        'training-model',
        content,
        { spdxLicense: 'EPL-2.0' },
      ),
    });
  }

  const standardLibraryFiles = sourceAccess
    .listFiles(options.releaseRoot, release.commit, release.standardLibraryRoot)
    .filter((sourcePath) =>
      sourcePath.startsWith(`${release.standardLibraryRoot}/`) &&
      /\.(?:sysml|kerml)$/u.test(sourcePath),
    )
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (standardLibraryFiles.length !== release.expectedStandardLibraryFileCount) {
    throw new Error(
      `Standard library text file count mismatch: expected ${release.expectedStandardLibraryFileCount}, ` +
      `observed ${standardLibraryFiles.length}.`,
    );
  }
  for (const sourcePath of standardLibraryFiles) {
    const content = sourceAccess.readFile(options.releaseRoot, release.commit, sourcePath);
    const outputPath = `sources/release-${release.tag}/${normalizeRepositoryPath(sourcePath)}`;
    files.push({
      content,
      outputPath,
      record: importedFileRecord(
        release.repository,
        sourcePath,
        outputPath,
        'standard-library-model',
        content,
        { spdxLicense: 'EPL-2.0' },
      ),
    });
  }

  for (const source of pilot.files) {
    const content = sourceAccess.readFile(options.pilotRoot, pilot.commit, source.path);
    assertKnownBlob(content, source.blob, source.path);
    const outputPath = `sources/pilot-${pilot.tag}/${normalizeRepositoryPath(source.path)}`;
    files.push({
      content,
      outputPath,
      record: importedFileRecord(
        pilot.repository,
        source.path,
        outputPath,
        source.kind,
        content,
        { upstreamBlob: source.blob, spdxLicense: 'EPL-2.0' },
      ),
    });
  }

  return {
    bnfCatalog: createBnfCatalog(options.releaseRoot, release, sourceAccess),
    files: files.sort((left, right) => left.outputPath.localeCompare(right.outputPath, 'en')),
    modelUserPdf: readModelUserPdf(
      options.modelUserPdf,
      sourceDefinition.formalExamTrack.modelUserExam.sha256,
    ),
  };
}

function createSourceRegistry(sourceDefinition, plan) {
  const release = sourceDefinition.release;
  const pilot = sourceDefinition.pilot;
  const formal = sourceDefinition.formalExamTrack;
  const importedFiles = plan.files.map((file) => file.record);
  const standardLibraryFiles = importedFiles.filter(
    (file) => file.kind === 'standard-library-model',
  );
  const quantitiesAndUnitsPrefix = `${release.standardLibraryRoot}/Domain Libraries/Quantities and Units/`;
  const quantitiesAndUnitsFiles = standardLibraryFiles.filter(
    (file) => file.sourcePath.startsWith(quantitiesAndUnitsPrefix),
  );
  const quantityFiles = quantitiesAndUnitsFiles.filter((file) => {
    const name = path.posix.basename(file.sourcePath);
    return name === 'Quantities.sysml' || name.startsWith('ISQ') || name === 'Time.sysml';
  });
  const unitFiles = quantitiesAndUnitsFiles.filter((file) => {
    const name = path.posix.basename(file.sourcePath);
    return name === 'Quantities.sysml' || name === 'SI.sysml' ||
      name === 'SIPrefixes.sysml' || name === 'USCustomaryUnits.sysml';
  });
  if (quantitiesAndUnitsFiles.length === 0 || quantityFiles.length === 0 || unitFiles.length === 0) {
    throw new Error('P4 Quantity/Unit capability bindings could not be resolved from the official text library.');
  }
  return {
    schemaVersion: 'official-source-registry/v1',
    registryId: 'sysml-official-source-baseline-2026-05',
    authorityPolicy: {
      primaryTrack: 'formalExam20',
      forwardCompatibilityTrack: 'forwardCompatibility21Beta',
      conflictResolution: 'OMG SysML 2.0 formal specifications and official exam scope take precedence.',
    },
    tracks: {
      formalExam20: {
        role: 'primary',
        languageVersion: formal.languageVersion,
        authority: 'OMG formal specification and certification program',
        sysmlSpecification: {
          ...formal.sysml,
          copyPolicy: 'metadata-only',
          copied: false,
        },
        kermlSpecification: {
          ...formal.kerml,
          copyPolicy: 'metadata-only',
          copied: false,
        },
        modelUserExam: {
          ...formal.modelUserExam,
          copyPolicy: 'hash-only',
          copied: false,
          localArtifactHash: plan.modelUserPdf,
        },
        referenceImplementationBaseline: formal.referenceImplementation,
      },
      forwardCompatibility21Beta: {
        role: 'forward-compatibility-only',
        languageVersion: '2.1-beta1',
        normative: false,
        usageConstraint: 'Must not override SysML 2.0 formal semantics or the official Model User exam scope.',
        release: {
          repository: release.repository,
          tag: release.tag,
          commit: release.commit,
          url: release.releaseUrl,
        },
        pilot: {
          repository: pilot.repository,
          tag: pilot.tag,
          commit: pilot.commit,
          pluginVersion: pilot.pluginVersion,
          url: pilot.releaseUrl,
        },
      },
    },
    imported: {
      fileCount: importedFiles.length,
      trainingModelCount: importedFiles.filter((file) => file.kind === 'training-model').length,
      standardLibraryModelCount: standardLibraryFiles.length,
      pilotGrammarAndMetamodelCount: importedFiles.filter(
        (file) => file.repository === pilot.repository,
      ).length,
      files: importedFiles,
    },
    capabilityBindings: {
      P4: {
        sourceTrack: 'forwardCompatibility21Beta',
        standardLibrary: {
          officialTextLibrary: true,
          importedFilePaths: standardLibraryFiles.map((file) => file.outputPath),
        },
        quantity: {
          officialTextLibrary: true,
          importedFilePaths: quantityFiles.map((file) => file.outputPath),
        },
        unit: {
          officialTextLibrary: true,
          importedFilePaths: unitFiles.map((file) => file.outputPath),
        },
      },
    },
    derivedCatalogs: [{
      path: 'derived/bnf-production-catalog.json',
      licenseReviewRequired: true,
      rawSourcesCopied: false,
    }],
    excludedArtifacts: [
      { kind: 'formal-specification-pdf', copied: false, reason: 'metadata-only copyrighted source' },
      { kind: 'model-user-exam-pdf', copied: false, reason: 'hash-only copyrighted source' },
      { kind: 'raw-bnf', copied: false, reason: 'derived catalog only; license review required' },
      { kind: 'standard-library-kpar', copied: false, reason: 'textual source representation only' },
      { kind: 'standard-library-xmi', copied: false, reason: 'textual source representation only' },
    ],
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeBaseline(outputRoot, plan, registry) {
  if (fs.existsSync(outputRoot)) {
    throw new Error(`Output root already exists; refusing to overwrite it: ${outputRoot}`);
  }
  const parent = path.dirname(outputRoot);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(outputRoot)}-staging-`));
  try {
    for (const file of plan.files) {
      const destination = path.join(stage, ...normalizeRepositoryPath(file.outputPath).split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content);
    }
    writeJson(path.join(stage, 'derived', 'bnf-production-catalog.json'), plan.bnfCatalog);
    writeJson(path.join(stage, 'source-registry.json'), registry);
    fs.renameSync(stage, outputRoot);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function importOfficialSourceBaseline(options, dependencies = {}) {
  const normalizedOptions = {
    releaseRoot: path.resolve(options.releaseRoot),
    pilotRoot: path.resolve(options.pilotRoot),
    outputRoot: path.resolve(options.outputRoot),
    modelUserPdf: options.modelUserPdf ? path.resolve(options.modelUserPdf) : null,
  };
  const sourceDefinition = dependencies.sourceDefinition || OFFICIAL_SOURCE_BASELINE;
  const sourceAccess = dependencies.sourceAccess || createGitSourceAccess();
  const plan = createImportPlan(normalizedOptions, sourceDefinition, sourceAccess);
  const registry = createSourceRegistry(sourceDefinition, plan);
  writeBaseline(normalizedOptions.outputRoot, plan, registry);
  return {
    outputRoot: normalizedOptions.outputRoot,
    importedFileCount: registry.imported.fileCount,
    trainingModelCount: registry.imported.trainingModelCount,
    standardLibraryModelCount: registry.imported.standardLibraryModelCount,
    bnfProductionOccurrenceCount: plan.bnfCatalog.statistics.productionOccurrenceCount,
    modelUserPdfRegistered: Boolean(plan.modelUserPdf),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const report = importOfficialSourceBaseline(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  OFFICIAL_SOURCE_BASELINE,
  assertSourceIdentity,
  createBnfCatalog,
  createGitSourceAccess,
  createSourceRegistry,
  extractBnfProductions,
  gitBlobSha1,
  importOfficialSourceBaseline,
  main,
  parseArgs,
  sha256,
  statisticsFor,
  usage,
};
