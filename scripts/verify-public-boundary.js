'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const errors = [];
const ignoredDirectories = new Set([
  '.cache',
  '.docker-test-config',
  '.git',
  '.npm-cache',
  '.official-cache',
  '.tmp',
  'dist',
  'node_modules'
]);
const forbiddenTopLevel = new Set([
  'artifacts',
  'benchmarks',
  'data',
  'deploy',
  'docs',
  'outputs',
  'resources'
]);
const forbiddenPaths = [
  'apps/web/src/features/author'
];
const forbiddenExtensions = new Set(['.env', '.key', '.p12', '.pem', '.pfx']);
const textExtensions = new Set([
  '', '.css', '.dockerfile', '.html', '.java', '.js', '.json', '.md', '.mts',
  '.ps1', '.sysml', '.ts', '.tsx', '.txt', '.yaml', '.yml'
]);
const forbiddenContent = [
  { label: 'cloud vendor deployment reference', pattern: /aliyun|aliyuncs\.com/iu },
  { label: 'ECS deployment reference', pattern: /\bECS\b/u },
  { label: 'private repository reference', pattern: /FlyingCpp\/sysmlv2-learning-platform/iu },
  { label: 'private workspace path', pattern: /SysMLv2教学项目|G:\\SynFeld_opensource/iu },
  { label: 'private key material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { label: 'GitHub token material', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u },
  { label: 'provider token material', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { label: 'known private network address', pattern: /(?:39\.105\.0\.90|172\.16\.63\.58)/u }
];
const forbiddenAuthorUi = /AuthorPage|features\/author|["'`]\/author(?:["'`/?#])|data-author|data-primary-nav=["']author["']|josh-portrait|navigation\.author/u;

for (const name of forbiddenTopLevel) {
  if (fs.existsSync(path.join(root, name))) errors.push(`Forbidden top-level path: ${name}`);
}
for (const relative of forbiddenPaths) {
  if (fs.existsSync(path.join(root, relative))) errors.push(`Forbidden public path: ${relative}`);
}

for (const file of walk(root)) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const lower = relative.toLowerCase();
  const base = path.basename(lower);
  const extension = path.extname(lower);
  if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') {
    errors.push(`Environment file is not allowed: ${relative}`);
  }
  if (forbiddenExtensions.has(extension)) errors.push(`Sensitive file type is not allowed: ${relative}`);
  if (/(^|\/)(aliyun|ecs)(\/|$)/u.test(lower)) errors.push(`Cloud deployment path is not allowed: ${relative}`);
  if (relative === 'scripts/verify-public-boundary.js' || relative === 'public-export-whitelist.json') continue;
  if (!textExtensions.has(extension) && !['dockerfile', 'license', 'notice'].includes(base)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (forbiddenAuthorUi.test(text)) errors.push(`Author profile UI is not allowed: ${relative}`);
  for (const check of forbiddenContent) {
    if (check.pattern.test(text)) errors.push(`${check.label}: ${relative}`);
  }
}

const courseRoots = childDirectories(path.join(root, 'courses'));
const knowledgeRoots = childDirectories(path.join(root, 'knowledge-packs'));
assertEqual(courseRoots, ['ev-sysml-v2-foundation'], 'course pack roots');
assertEqual(knowledgeRoots, ['system-modeling-foundations'], 'knowledge pack roots');

const course = readJson('courses/ev-sysml-v2-foundation/course-pack.json');
assertValue(course.title, 'SysML v2 电动汽车建模基础', 'course title');
assertValue(course.version, '2.2.0', 'course version');
assertValue(course.license, 'EPL-2.0', 'course license');

const knowledge = readJson('knowledge-packs/system-modeling-foundations/knowledge-pack.json');
assertValue(knowledge.title, 'SysML v2 工程扫盲与导读', 'knowledge title');
assertValue(knowledge.version, '1.1.0', 'knowledge version');
assertValue(knowledge.license, 'EPL-2.0', 'knowledge license');

if (errors.length > 0) {
  console.error(JSON.stringify({ status: 'BLOCK', errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: 'PASS',
  course: `${course.title} ${course.version}`,
  knowledgePack: `${knowledge.title} ${knowledge.version}`
}, null, 2));

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function childDirectories(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function assertValue(actual, expected, label) {
  if (actual !== expected) errors.push(`${label}: expected ${expected}, received ${String(actual)}`);
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
