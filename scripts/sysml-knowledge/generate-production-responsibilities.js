'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createProductionResponsibilityManifest
} = require('./language-knowledgeization-v2');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_INVENTORY_PATH = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'language',
  'baselines',
  'sysml-2.0-pilot-2026-04-inventory.json'
);

function usage() {
  return [
    'Usage: node scripts/sysml-knowledge/generate-production-responsibilities.js [options]',
    '',
    'Options:',
    '  --inventory <path>  Official language inventory JSON.',
    '  --output <path>     Optional output JSON path; stdout is used when omitted.',
    '  --compact           Emit compact JSON.',
    '  --help              Show this help.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    compact: false,
    help: false,
    inventoryPath: DEFAULT_INVENTORY_PATH,
    outputPath: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--compact') {
      options.compact = true;
    } else if (argument === '--inventory' || argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--inventory') options.inventoryPath = path.resolve(value);
      else options.outputPath = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function generateProductionResponsibilityManifest(inventoryPath = DEFAULT_INVENTORY_PATH) {
  const resolved = path.resolve(inventoryPath);
  const inventory = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return createProductionResponsibilityManifest(inventory);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const manifest = generateProductionResponsibilityManifest(options.inventoryPath);
  const serialized = `${JSON.stringify(manifest, null, options.compact ? 0 : 2)}\n`;
  if (options.outputPath) {
    assertSafeOutputPath(options.outputPath);
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, serialized, 'utf8');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputPath: options.outputPath,
      inventoryId: manifest.inventoryId,
      responsibilities: manifest.responsibilities.length,
      responsibilitySetHash: manifest.responsibilitySetHash
    }, null, 2)}\n`);
  } else {
    process.stdout.write(serialized);
  }
  return 0;
}

function assertSafeOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved !== PROJECT_ROOT
    && !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)
    && resolved !== tempRoot
    && !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Output path must stay inside the project or temporary directory: ${filePath}`);
  }
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
  DEFAULT_INVENTORY_PATH,
  generateProductionResponsibilityManifest,
  main,
  parseArgs,
  usage
};
