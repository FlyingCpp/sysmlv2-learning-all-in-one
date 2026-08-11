'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SKILL_ROOT = path.join(__dirname, '..', '..', 'sysml-v2-modeling');
const DEFAULT_GOVERNANCE_MANIFEST = path.join(__dirname, 'skill-governance-manifest.json');
const DEFAULT_MAX_HITS = 4;
const DEFAULT_MAX_CONTENT_CHARS = 1800;
const DEFAULT_MAX_FILE_CHARS = 220000;
const OPERATOR_EXPANSION_WEIGHT = 2;

// 操作符是 SysML v2 检索意图的一部分，不能按普通标点丢弃。扩展词只用于
// 召回与排序，不参与学生答案的语义裁决。
const OPERATOR_QUERY_EXPANSIONS = Object.freeze({
  ':': [
    'feature typing', 'defined by', 'typed usage', 'usage definition', 'inherits features',
    '类型化', '用法 定义', '继承 特征'
  ],
  ':>': [
    'specialization', 'subclassification', 'subsetting', 'specializes', 'subsets',
    'definition usage endpoints', '特化', '子分类', '子集化'
  ],
  ':>>': [
    'redefinition', 'redefines', 'redefining feature', 'inherited feature', 'local replacement',
    '重定义', '继承 特征', '本地 替代'
  ],
  '::>': [
    'reference subsetting', 'references', 'referencing feature', 'connection end',
    '引用子集化', '引用 特征', '连接 端点'
  ],
  '=>': [
    'cross subsetting', 'crosses', 'crossing relationship', '交叉子集化', '跨越关系'
  ],
  '=': [
    'feature value', 'fixed bound value', 'binding connector',
    '特征值', '固定 绑定值', '绑定连接'
  ],
  ':=': [
    'feature value', 'initial value', 'starting snapshot', '特征值', '初始值'
  ]
});

// `=` 与 `:=` 在 FeatureValue、AssignAction、BindingConnector 中复用。
// 检索必须先识别语法上下文，再给对应权威条目加权；不能把符号本身当成语义。
const VALUE_SEMANTIC_CONTEXTS = Object.freeze({
  feature_value: {
    expansions: ['feature value', 'fixed bound', 'fixed initial', 'starting snapshot', '特征值', '固定绑定值', '固定初始值', '起始快照'],
    paths: {
      'language-reference/07-expression/01-expression-feature-value.md': 42,
      'language-reference/07-expression/02-default-value.md': 24,
      'chapters/ch06-ports-connections.md': 14
    }
  },
  default_value: {
    expansions: ['default feature value', 'default bound', 'default initial', 'overridable', '默认特征值', '默认绑定值', '默认初始值', '可覆盖'],
    paths: {
      'language-reference/07-expression/02-default-value.md': 42,
      'chapters/ch06-ports-connections.md': 14
    }
  },
  assign_action: {
    expansions: ['assign action', 'runtime update', 'target occurrence', 'referent feature', 'assigned value', '赋值动作', '执行时更新', '目标发生项'],
    paths: {
      'language-reference/03-behavior/08-assign-action.md': 42,
      'chapters/ch09-actions.md': 20
    }
  },
  binding_connector: {
    expansions: ['binding connector', 'same things', 'equal values', 'identity', '绑定连接', '相等', '同一'],
    paths: {
      'language-reference/02-structure/07-binding-connection.md': 42,
      'chapters/ch06-ports-connections.md': 20
    }
  }
});

const DISTINCTIVE_OPERATOR_BONUS = Object.freeze({
  ':>': 8,
  ':>>': 10,
  '::>': 10,
  '=>': 10,
  ':=': 8
});

function createSkillSourceAdapter(options = {}) {
  const enabled = optionEnabled(options.enabled, process.env.AI_TEACHER_SKILL_SOURCE_ENABLED, true);
  const sources = enabled ? loadSkillSources(options) : [];
  return {
    mode: 'skill_source',
    enabled,
    sources,
    search(query, context = {}, searchOptions = {}) {
      if (!enabled || !sources.length) return [];
      return searchSkillSources(sources, query, context, searchOptions);
    },
    status() {
      return {
        mode: 'skill_source',
        enabled,
        ready: enabled ? sources.length > 0 : false,
        sourceCount: sources.length,
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          fileCount: source.entries.length,
          reviewStatus: source.reviewStatus,
          version: source.version,
          contentHash: source.contentHash
        }))
      };
    }
  };
}

function loadSkillSources(options = {}) {
  const governance = loadGovernanceManifest(options.governanceManifestPath || DEFAULT_GOVERNANCE_MANIFEST);
  const configured = Array.isArray(options.sources)
    ? options.sources
    : parseSkillSourceDirs(options.skillDirs || options.rootDirs || process.env.AI_TEACHER_SKILL_SOURCE_DIRS);
  const sourceConfigs = configured.length ? configured : governance.sources.map((source) => ({
    id: source.id,
    rootDir: governedRootDir(source)
  }));
  return sourceConfigs
    .map((source, index) => {
      const rootDir = path.resolve(String(source.rootDir || source.dir || source.path || ''));
      const policy = governance.sources.find((item) => item.id === source.id || governedRootDir(item) === rootDir);
      return policy ? loadSkillSource(source, index, options, policy) : null;
    })
    .filter(Boolean);
}

function loadGovernanceManifest(manifestPath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  if (parsed?.schemaVersion !== '1.0.0' || !Array.isArray(parsed.sources)) {
    throw new Error('AI Teacher Skill governance manifest is invalid');
  }
  return parsed;
}

function governedRootDir(policy) {
  return path.resolve(__dirname, '..', '..', String(policy.rootDir || ''));
}

function parseSkillSourceDirs(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return list.map((item) => String(item || '').trim()).filter(Boolean).map((rootDir) => ({ rootDir }));
}

function loadSkillSource(source, index, options = {}, policy = {}) {
  const rootDir = path.resolve(String(source.rootDir || source.dir || source.path || ''));
  if (!rootDir || !fs.existsSync(rootDir)) return null;
  const skillPath = path.join(rootDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  const skillText = readLimited(skillPath, DEFAULT_MAX_FILE_CHARS);
  const meta = parseSkillFrontmatter(skillText);
  const name = String(source.name || meta.name || path.basename(rootDir)).trim();
  const id = String(source.id || name || `skill-${index}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (policy.reviewStatus !== 'reviewed' || id !== policy.id || rootDir !== governedRootDir(policy)) return null;
  const topicIndex = parseTopicIndex(skillText);
  const files = listSkillFiles(rootDir, options, policy);
  const contentHash = aggregateSkillHash(rootDir, files);
  if (contentHash !== policy.contentHash) return null;
  const entries = files.map((filePath) => buildSkillEntry(rootDir, filePath, topicIndex, id, name))
    .filter(Boolean);
  return {
    id,
    name,
    description: String(source.description || meta.description || '').trim(),
    rootDir,
    reviewStatus: policy.reviewStatus,
    version: String(policy.sourceVersion || 'unversioned'),
    contentHash,
    entries
  };
}

function listSkillFiles(rootDir, options = {}, policy = {}) {
  const maxFiles = Number(options.maxFiles || 160);
  const allowedFiles = (policy.allowedFiles || []).map(normalizePath);
  const allowedDirectories = (policy.allowedDirectories || []).map(normalizePath);
  if (allowedFiles.length > maxFiles) return [];
  const files = [];
  for (const relative of allowedFiles) {
    if (!/\.(md|txt)$/i.test(relative) || relative.startsWith('reference/') || relative.includes('..')) return [];
    const filePath = path.resolve(rootDir, relative);
    if (!filePath.startsWith(`${rootDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return [];
    files.push(filePath);
  }
  for (const relative of allowedDirectories) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) return [];
    const directoryPath = path.resolve(rootDir, relative);
    if (!directoryPath.startsWith(`${rootDir}${path.sep}`)
      || !fs.existsSync(directoryPath)
      || !fs.statSync(directoryPath).isDirectory()) return [];
    const pending = [directoryPath];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) return [];
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
          files.push(entryPath);
        }
      }
    }
  }
  if (files.length > maxFiles || new Set(files).size !== files.length) return [];
  return files.sort((left, right) => {
    const leftPath = normalizePath(path.relative(rootDir, left));
    const rightPath = normalizePath(path.relative(rootDir, right));
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

function aggregateSkillHash(rootDir, files) {
  const canonical = files.map((filePath) => {
    const relative = normalizePath(path.relative(rootDir, filePath));
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return `${relative}\0sha256:${fileHash}`;
  }).join('\n');
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function buildSkillEntry(rootDir, filePath, topicIndex, sourceId, skillName) {
  const relative = normalizePath(path.relative(rootDir, filePath));
  const content = readLimited(filePath, DEFAULT_MAX_FILE_CHARS);
  if (!content.trim()) return null;
  const title = firstMarkdownTitle(content) || relative.replace(/\.(md|txt)$/i, '');
  const linkedTopics = topicIndex
    .filter((topic) => topic.files.includes(relative))
    .flatMap((topic) => [topic.topic, ...topic.aliases]);
  return {
    id: `${sourceId}:${relative}`,
    sourceId,
    skillName,
    filePath: relative,
    absolutePath: filePath,
    title,
    content,
    topics: uniqueText(linkedTopics),
    keywords: uniqueText([title, relative, ...linkedTopics].join(' ').split(/[^a-zA-Z0-9_\u4e00-\u9fff:-]+/))
  };
}

function searchSkillSources(sources, query, context = {}, options = {}) {
  const limit = positiveInt(options.limit, DEFAULT_MAX_HITS);
  const contentLimit = positiveInt(options.contentLimit, DEFAULT_MAX_CONTENT_CHARS);
  const terms = queryTerms(query, context);
  if (!terms.tokens.length && !terms.operators.length) return [];
  return sources
    .flatMap((source) => source.entries.map((entry) => {
      const score = scoreEntry(entry, terms);
      return {
        id: entry.id,
        sourceId: source.id,
        skillName: source.name,
        title: entry.title,
        filePath: entry.filePath,
        sourceTitle: `${source.name}: ${entry.title}`,
        authorityLevel: entry.filePath.startsWith('language-reference/')
          ? 'C'
          : source.name === 'sysml-v2-modeling' ? 'B' : 'D',
        sourceType: 'skill_source',
        reviewStatus: source.reviewStatus,
        version: source.version,
        sourceContentHash: source.contentHash,
        matchedTerms: matchedTerms(entry, terms.tokens),
        matchedOperators: matchedOperators(entry, terms.operators),
        content: excerpt(entry.content, terms.excerptTerms, contentLimit),
        score
      };
    }))
    .filter((hit) => hit.score > 0 && hit.content)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function queryTerms(query, context) {
  const diagnostics = [
    ...(context?.diagnostics?.officialValidator || []),
    ...(context?.diagnostics?.courseRules || [])
  ];
  const editorParts = trustedEditorQueryParts(context);
  const parts = [
    query,
    context?.question?.text,
    constructDecisionQueryTerms(query, context?.question?.text),
    context?.course?.lessonTitle,
    ...(context?.course?.learningGoals || []),
    ...(context?.courseContext?.focusTerms || []).flatMap((item) => [item.text, item.label]),
    ...(context?.courseContext?.todoItems || []).map((item) => item.text),
    ...diagnostics.map((item) => item.message),
    ...editorParts
  ];
  const text = parts.join(' ');
  const operators = extractOperatorTokens(text);
  const semanticContexts = inferValueSemanticContexts(text, operators);
  const baseTokens = lexicalTokens(text);
  const expansionPhrases = uniqueText(
    [
      ...operators.flatMap((operator) => OPERATOR_QUERY_EXPANSIONS[operator] || []),
      ...semanticContexts.flatMap((contextName) => VALUE_SEMANTIC_CONTEXTS[contextName]?.expansions || [])
    ]
  );
  const expansionTokens = lexicalTokens(expansionPhrases.join(' '));
  return {
    operators,
    semanticContexts,
    baseTokens,
    expansionTokens: expansionTokens.filter((token) => !baseTokens.includes(token)),
    tokens: uniqueText([...baseTokens, ...expansionTokens]),
    // 先以完整规范短语定位摘录，避免宽泛的模型标识符把窗口锚定到无关段落。
    excerptTerms: uniqueText([...expansionPhrases, ...expansionTokens, ...baseTokens])
  };
}

function inferValueSemanticContexts(text, operators) {
  const value = String(text || '');
  const contexts = [];
  if (/\bassign(?:ment)?\b|赋值动作|执行时更新/iu.test(value)) contexts.push('assign_action');
  if (/\bdefault\b|默认(?:值|特征值|绑定值|初始值)?/iu.test(value)) contexts.push('default_value');
  if (/\bbind(?:ing)?\b|绑定连接|恒等|同一(?:事物|对象)?|相等关系/iu.test(value)) contexts.push('binding_connector');
  if (!contexts.length && operators.some((operator) => operator === '=' || operator === ':=')) {
    contexts.push('feature_value');
  }
  return uniqueText(contexts);
}

function lexicalTokens(value) {
  return uniqueText(String(value || '').toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff:.-]+/i))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^:+$/u.test(token) && !STOPWORDS.has(token));
}

function extractOperatorTokens(value) {
  const text = String(value || '');
  const found = [];
  const distinctive = ['::>', ':>>', ':=', ':>', '=>'];
  for (let index = 0; index < text.length;) {
    const operator = distinctive.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      found.push(operator);
      index += operator.length;
      continue;
    }
    const current = text[index];
    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (current === ':' && previous !== ':' && next !== ':' && next !== '/' && next !== '\\') {
      found.push(':');
    } else if (
      current === '='
      && !['<', '>', '!', '=', ':'].includes(previous)
      && !['=', '>'].includes(next)
    ) {
      found.push('=');
    }
    index += 1;
  }
  return uniqueText(found);
}

function constructDecisionQueryTerms(query, question) {
  const text = `${String(query || '')} ${String(question || '')}`;
  const constructs = new Set(
    [...text.matchAll(/\b(item|part|attribute)\b/giu)].map((match) => match[1].toLowerCase())
  );
  const asksForChoice = /(?:分类|合理|区别|区分|选择|建模为|应该用|采用|还是|\b(?:versus|vs\.?|or|choose|classif(?:y|ication))\b)/iu.test(text);
  if (constructs.size < 2 && !(constructs.size >= 1 && asksForChoice)) return '';
  return 'item part attribute occurrence data value physical quantity scalar measurement rating unit';
}

function trustedEditorQueryParts(context) {
  const editor = context?.editor || {};
  const state = editor.contextState || {};
  const stale = ['stale_document', 'default_context'].includes(String(state.degradedReason || ''));
  const codeIsCurrent = state.cursorOrigin === 'current'
    && state.focus === 'focused'
    && state.interactionTarget === 'code';
  const selectionExplicitlyFrozen = state.selectionOrigin === 'frozen-explicit'
    && state.cursorOrigin === 'frozen-explicit'
    && state.interactionTarget === 'ai-panel';
  const cursorExplicitlyFrozen = state.cursorOrigin === 'frozen-explicit'
    && state.interactionTarget === 'ai-panel';
  const selectionIsCurrent = codeIsCurrent && state.selectionOrigin !== 'last-known';
  const selectionText = !stale && (selectionIsCurrent || selectionExplicitlyFrozen)
    ? editor.selection?.text
    : '';
  const lineText = !stale && (codeIsCurrent || cursorExplicitlyFrozen)
    ? currentLineText(context)
    : '';
  return [selectionText, lineText];
}

function currentLineText(context) {
  const activePath = context?.editor?.activeFilePath || context?.editor?.entryFile;
  const file = (context?.editor?.files || []).find((item) => item.path === activePath)
    || context?.editor?.files?.[0];
  if (!file) return '';
  const line = Number(context?.editor?.cursor?.line || 0);
  if (!line) return '';
  return String(file.content || '').split(/\r\n|\r|\n/)[line - 1] || '';
}

function scoreEntry(entry, terms) {
  const haystack = `${entry.title} ${entry.filePath} ${entry.topics.join(' ')} ${entry.content}`.toLowerCase();
  let score = 0;
  for (const token of terms.baseTokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += 1;
    if (entry.keywords.some((keyword) => keyword.toLowerCase() === token)) score += 3;
    if (entry.topics.some((topic) => normalizeToken(topic) === token)) score += 4;
    if (entry.filePath.toLowerCase().includes(token)) score += 2;
  }
  for (const token of terms.expansionTokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += OPERATOR_EXPANSION_WEIGHT;
    if (entry.keywords.some((keyword) => keyword.toLowerCase() === token)) {
      score += 3 * OPERATOR_EXPANSION_WEIGHT;
    }
    if (entry.topics.some((topic) => normalizeToken(topic) === token)) {
      score += 4 * OPERATOR_EXPANSION_WEIGHT;
    }
    if (entry.filePath.toLowerCase().includes(token)) score += 2 * OPERATOR_EXPANSION_WEIGHT;
  }
  const entryOperators = new Set(extractOperatorTokens(entry.content));
  for (const operator of terms.operators) {
    if (entryOperators.has(operator)) score += DISTINCTIVE_OPERATOR_BONUS[operator] || 0;
  }
  for (const contextName of terms.semanticContexts || []) {
    score += VALUE_SEMANTIC_CONTEXTS[contextName]?.paths?.[entry.filePath] || 0;
  }
  if (/verbatim\.md$/i.test(entry.filePath)) score += 1.5;
  if (/cheatsheet\.md$/i.test(entry.filePath)) score += 1;
  if (/^chapters\//i.test(entry.filePath)) score += 0.5;
  return score;
}

function matchedOperators(entry, operators) {
  const entryOperators = new Set(extractOperatorTokens(entry.content));
  return operators.filter((operator) => entryOperators.has(operator));
}

function matchedTerms(entry, tokens) {
  const haystack = `${entry.title} ${entry.filePath} ${entry.topics.join(' ')} ${entry.content}`.toLowerCase();
  return tokens.filter((token) => haystack.includes(token)).slice(0, 12);
}

function excerpt(content, tokens, maxChars) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  if (text.length <= maxChars) return text.trim();
  const lower = text.toLowerCase();
  let index = -1;
  for (const token of tokens) {
    index = lower.indexOf(token.toLowerCase());
    if (index >= 0) break;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - Math.floor(maxChars * 0.25));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '...<skill-context-before>\n' : '';
  const suffix = end < text.length ? '\n...<skill-context-after>' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function parseSkillFrontmatter(text) {
  const match = String(text || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    meta[item[1]] = item[2].replace(/^["']|["']$/g, '').trim();
  }
  return meta;
}

function parseTopicIndex(skillText) {
  const topics = [];
  const lines = String(skillText || '').split(/\r?\n/);
  for (const line of lines) {
    const topic = line.match(/^\s*-\s+\*\*(.+?)\*\*\s*→\s*(.+)$/);
    if (!topic) continue;
    const files = [];
    for (const link of topic[2].matchAll(/\(([^)]+\.md)\)/g)) {
      files.push(normalizePath(link[1]));
    }
    for (const chapter of topic[2].matchAll(/\bch(\d{2})\b/gi)) {
      files.push(`chapters/${chapterFileName(chapter[1])}`);
    }
    topics.push({
      topic: topic[1].trim(),
      aliases: topic[2].split(/[,\s]+/).filter((item) => item.length > 2),
      files: uniqueText(files)
    });
  }
  return topics;
}

function chapterFileName(number) {
  const map = {
    '01': 'ch01-language-foundations.md',
    '02': 'ch02-definition-and-usage.md',
    '03': 'ch03-attributes-enumerations.md',
    '04': 'ch04-occurrences-time-individuals.md',
    '05': 'ch05-items-parts.md',
    '06': 'ch06-ports-connections.md',
    '07': 'ch07-interfaces-allocations.md',
    '08': 'ch08-flows-messages.md',
    '09': 'ch09-actions.md',
    '10': 'ch10-states.md',
    '11': 'ch11-calculations-constraints.md',
    '12': 'ch12-requirements.md',
    '13': 'ch13-cases.md',
    '14': 'ch14-views-viewpoints-metadata.md',
    '15': 'ch15-syntax-metamodel-libraries.md'
  };
  return map[String(number).padStart(2, '0')] || `ch${String(number).padStart(2, '0')}.md`;
}

function firstMarkdownTitle(content) {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function readLimited(filePath, maxChars) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().trim();
}

function uniqueText(items) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function optionEnabled(optionValue, envValue, fallback) {
  const value = optionValue !== undefined ? optionValue : envValue;
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'disabled', 'off', 'none'].includes(String(value).toLowerCase());
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'into', 'from', '当前', '一个', '需要', '模型', '课程',
  '解释', '说明', '为什么', '如何', '里面', '是否', '可以'
]);

module.exports = {
  DEFAULT_SKILL_ROOT,
  DEFAULT_GOVERNANCE_MANIFEST,
  OPERATOR_QUERY_EXPANSIONS,
  VALUE_SEMANTIC_CONTEXTS,
  aggregateSkillHash,
  createSkillSourceAdapter,
  extractOperatorTokens,
  queryTerms,
  searchSkillSources
};
