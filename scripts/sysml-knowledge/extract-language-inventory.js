'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_INVENTORY_ID,
  buildLanguageInventory,
  canonicalStringify,
} = require('./language-inventory');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SOURCE_DIRECTORY = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'sources',
  'grammar',
  'pilot-2026-04',
);
const DEFAULT_OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'language',
  'baselines',
  'sysml-2.0-pilot-2026-04-inventory.json',
);

const SOURCE_FILES = Object.freeze({
  ecores: Object.freeze([
    Object.freeze({
      id: 'SysML.ecore',
      path: 'model/SysML.ecore',
      precedence: 200,
    }),
    Object.freeze({
      id: 'kerml.ecore',
      path: 'model/kerml.ecore',
      precedence: 100,
    }),
  ]),
  grammars: Object.freeze([
    Object.freeze({
      id: 'SysML',
      path: 'org/omg/sysml/xtext/SysML.xtext',
      precedence: 300,
    }),
    Object.freeze({
      id: 'KerML',
      path: 'org/omg/kerml/xtext/KerML.xtext',
      precedence: 200,
    }),
    Object.freeze({
      id: 'KerMLExpressions',
      path: 'org/omg/kerml/expressions/xtext/KerMLExpressions.xtext',
      precedence: 100,
    }),
  ]),
});

function usage() {
  return [
    'Usage: node scripts/sysml-knowledge/extract-language-inventory.js [options]',
    '',
    'Options:',
    '  --source-dir <path>   Pilot grammar/Ecore root directory.',
    '  --output <path>       Inventory JSON output path.',
    '  --inventory-id <id>   Stable inventory identifier.',
    '  --target-grammar <id>  Root grammar source ID (default: highest precedence).',
    '  --compact             Write canonical JSON without indentation.',
    '  --strict              Fail after writing if diagnostics are unresolved.',
    '  --help                Show this help.',
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
  const options = {
    compact: false,
    inventoryId: DEFAULT_INVENTORY_ID,
    outputPath: DEFAULT_OUTPUT_PATH,
    sourceDirectory: DEFAULT_SOURCE_DIRECTORY,
    strict: false,
    targetGrammarId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      options.help = true;
    } else if (argument === '--compact') {
      options.compact = true;
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '--source-dir') {
      options.sourceDirectory = path.resolve(requireOptionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--output') {
      options.outputPath = path.resolve(requireOptionValue(argv, index, argument));
      index += 1;
    } else if (argument === '--inventory-id') {
      options.inventoryId = requireOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--target-grammar') {
      options.targetGrammarId = requireOptionValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function readSources(sourceDirectory, definitions) {
  return definitions.map((definition) => {
    const absolutePath = path.resolve(sourceDirectory, definition.filePath || definition.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Required language source is missing: ${absolutePath}`);
    }
    const { filePath: _filePath, ...logicalDefinition } = definition;
    return {
      ...logicalDefinition,
      content: fs.readFileSync(absolutePath, 'utf8'),
    };
  });
}

function createInventoryFromFiles(options = {}) {
  const sourceDirectory = path.resolve(options.sourceDirectory || DEFAULT_SOURCE_DIRECTORY);
  return buildLanguageInventory({
    ecoreSources: readSources(sourceDirectory, options.ecoreFiles || SOURCE_FILES.ecores),
    grammarSources: readSources(sourceDirectory, options.grammarFiles || SOURCE_FILES.grammars),
    inventoryId: options.inventoryId || DEFAULT_INVENTORY_ID,
    targetGrammarId: options.targetGrammarId || undefined,
  });
}

function diagnosticCount(inventory) {
  return (
    inventory.diagnostics.ecore.length +
    inventory.diagnostics.grammar.length +
    inventory.diagnostics.unresolvedReturnTypes.length +
    inventory.diagnostics.unresolvedRuleReferences.length +
    inventory.diagnostics.unresolvedSuperTypes.length
  );
}

function reportFor(inventory, outputPath) {
  return {
    contentHash: inventory.contentHash,
    inventoryId: inventory.inventoryId,
    output: outputPath,
    summary: inventory.summary,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const inventory = createInventoryFromFiles(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  const serialized = `${canonicalStringify(inventory, options.compact ? 0 : 2)}\n`;
  fs.writeFileSync(options.outputPath, serialized, 'utf8');
  process.stdout.write(`${JSON.stringify(reportFor(inventory, options.outputPath), null, 2)}\n`);

  if (options.strict && diagnosticCount(inventory) > 0) {
    process.stderr.write(
      `Language inventory contains ${diagnosticCount(inventory)} unresolved or parse diagnostic item(s).\n`,
    );
    return 2;
  }
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
  DEFAULT_OUTPUT_PATH,
  DEFAULT_SOURCE_DIRECTORY,
  SOURCE_FILES,
  createInventoryFromFiles,
  diagnosticCount,
  main,
  parseArgs,
  reportFor,
  usage,
};
