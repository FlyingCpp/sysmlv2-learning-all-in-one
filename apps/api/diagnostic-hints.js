'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCALE = 'zh-CN';
const HINT_DIR = path.join(__dirname, 'diagnostics');

function enhanceOfficialDiagnostics({ diagnostics, files, entryFile, validatorSource, locale = DEFAULT_LOCALE }) {
  const hintPack = loadDiagnosticHints(locale);
  const sourceMap = buildCombinedSourceMap(files || []);
  const normalizedDiagnostics = (diagnostics || []).map((diagnostic) => {
    const normalized = normalizeDiagnosticLocation(diagnostic, sourceMap, files, entryFile);
    return refineDiagnosticLocation(normalized, files || []);
  });
  const fullwidthColonOverride = fullwidthColonPrimaryDiagnostics(normalizedDiagnostics, files || [], hintPack, validatorSource, entryFile);
  const diagnosticsForHints = fullwidthColonOverride || normalizedDiagnostics;
  return diagnosticsForHints.map((diagnostic) => enhanceSingleOfficialDiagnostic(diagnostic, files || [], hintPack, validatorSource));
}

function enhanceSingleOfficialDiagnostic(diagnostic, files, hintPack, validatorSource) {
  if (!isOfficialDiagnostic(diagnostic, hintPack, validatorSource)) return diagnostic;

  const context = sourceContext(diagnostic, files || []);
  const match = matchHint(diagnostic, context, hintPack.rules || []);
  const fallback = hintPack.fallback || {};
  const hint = match ? buildHint(match, context, 0.9, diagnostic) : buildHint({
    id: 'fallback.official',
    ...fallback
  }, context, 0.35, diagnostic);
  return { ...diagnostic, studentHint: hint };
}

function fullwidthColonPrimaryDiagnostics(diagnostics, files = [], hintPack, validatorSource, entryFile) {
  const officialSource = hintPack.source || validatorSource;
  const hasOfficialSyntaxError = diagnostics.some((diagnostic) => diagnostic.source === officialSource && diagnostic.category === 'syntax' && diagnostic.severity !== 'warning');
  if (!hasOfficialSyntaxError) return null;

  const colonLocations = [];
  for (const file of files || []) {
    forEachSysmlCodeChar(file.content, ({ char, line, column }) => {
      if (char === '：') {
        colonLocations.push({
          file: file.path || entryFile || 'main.sysml',
          line,
          column,
          lineText: lineTextAt(file.content, line)
        });
      }
    });
  }
  if (!colonLocations.length) return null;

  const nonOfficial = diagnostics.filter((diagnostic) => diagnostic.source !== officialSource);
  const fullwidthDiagnostics = colonLocations.map((location) => ({
    source: officialSource,
    severity: 'error',
    category: 'syntax',
    file: location.file,
    line: location.line,
    column: location.column,
    message: '检测到中文全角冒号 `：`，SysML v2 类型冒号必须使用 ASCII `:`。',
    originalDiagnosticCount: diagnostics.filter((diagnostic) => diagnostic.source === officialSource).length
  }));
  return [...fullwidthDiagnostics, ...nonOfficial];
}

function firstFullwidthColonInSysmlCode(line) {
  let column = -1;
  forEachSysmlCodeChar(line, ({ char, index }) => {
    if (column < 0 && char === '：') column = index;
  });
  return column;
}

function forEachSysmlCodeChar(value, callback) {
  scanSysmlText(value, ({ mode, char, index, line }) => {
    if (mode === 'code') callback({ char, index, line });
  });
}

function sysmlCodeOnlyText(value) {
  let result = '';
  scanSysmlText(value, ({ mode, char }) => {
    result += mode === 'code' || char === '\n' || char === '\r' ? char : ' ';
  });
  return result;
}

function scanSysmlText(value, visitor) {
  const text = String(value || '');
  let mode = 'code';
  let quote = '';
  let escaped = false;
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || '';
    const column = index - lineStart + 1;
    if (mode === 'lineComment') {
      visitor({ mode, char, index, line, column });
      if (char === '\n') {
        mode = 'code';
        line += 1;
        lineStart = index + 1;
      }
      continue;
    }
    if (mode === 'blockComment') {
      visitor({ mode, char, index, line, column });
      if (char === '\n') {
        line += 1;
        lineStart = index + 1;
      }
      if (char === '*' && next === '/') {
        index += 1;
        visitor({ mode, char: '/', index, line, column: index - lineStart + 1 });
        mode = 'code';
      }
      continue;
    }
    if (mode === 'string') {
      visitor({ mode, char, index, line, column });
      if (char === '\n') {
        line += 1;
        lineStart = index + 1;
      }
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
        mode = 'code';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      visitor({ mode: 'code', char, index, line, column });
      quote = char;
      mode = 'string';
      continue;
    }
    if (char === '/' && next === '/') {
      visitor({ mode: 'lineComment', char, index, line, column });
      index += 1;
      visitor({ mode: 'lineComment', char: '/', index, line, column: index - lineStart + 1 });
      mode = 'lineComment';
      continue;
    }
    if (char === '/' && next === '*') {
      visitor({ mode: 'blockComment', char, index, line, column });
      index += 1;
      visitor({ mode: 'blockComment', char: '*', index, line, column: index - lineStart + 1 });
      mode = 'blockComment';
      continue;
    }
    visitor({ mode: 'code', char, index, line, column });
    if (char === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
}

function lineTextAt(content, lineNumber) {
  return String(content || '').split(/\r?\n/)[Math.max(0, Number(lineNumber || 1) - 1)] || '';
}

function loadDiagnosticHints(locale = DEFAULT_LOCALE) {
  const file = path.join(HINT_DIR, `sysml-v2-official-hints.${locale}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isOfficialDiagnostic(diagnostic, hintPack, validatorSource) {
  if (diagnostic.ruleId || diagnostic.source === 'course-rule') return false;
  const officialSource = hintPack.source || validatorSource;
  return Boolean(officialSource && diagnostic.source === officialSource);
}

function buildHint(rule, context, confidence, diagnostic = {}) {
  const templateContext = buildTemplateContext(diagnostic, context);
  const title = renderHintText(rule.studentTitle, templateContext).trim() || defaultHintTitle(rule, templateContext);
  return {
    id: rule.id || 'fallback.official',
    priority: Number(rule.priority || 0),
    title,
    message: renderHintText(rule.studentMessage, templateContext) || '请检查标红行附近的 SysML v2 语法和引用关系。',
    fixSteps: Array.isArray(rule.fixSteps) ? rule.fixSteps.map((step) => renderHintText(step, templateContext)) : [],
    badExample: renderHintText(rule.badExample, templateContext) || null,
    goodExample: renderHintText(rule.goodExample, templateContext) || null,
    relatedConcepts: Array.isArray(rule.relatedConcepts) ? rule.relatedConcepts : [],
    lineText: context.lineText || '',
    confidence
  };
}

function defaultHintTitle(rule, templateContext) {
  if (rule.id === 'semantic.unresolved-type' && templateContext.missingName) {
    return `${templateContext.missingName} 这个类型没有定义`;
  }
  return '官方 validator 返回了诊断';
}

function buildTemplateContext(diagnostic, context) {
  const message = String(diagnostic.message || '');
  const lineText = String(context.lineText || '');
  const missingName = firstNonEmpty([
    quotedAfter(message, /Couldn't resolve reference to [^']+'([^']+)'/i),
    quotedAfter(message, /Couldn't resolve reference to [^"]+"([^"]+)"/i),
    typeNameAfterColon(lineText)
  ]);
  return {
    missingName,
    lineText: lineText.trim()
  };
}

function renderHintText(value, templateContext) {
  if (!value) return '';
  return String(value).replace(/\{\{\s*(missingName|lineText)\s*\}\}/g, (_, key) => templateContext[key] || '');
}

function quotedAfter(text, regex) {
  const match = regex.exec(text);
  return match?.[1] || '';
}

function typeNameAfterColon(lineText) {
  const match = /:\s*([A-Za-z_][\w:]*)(?:\s*[;{=,\[]|$)/.exec(lineText);
  return match?.[1] || '';
}

function firstNonEmpty(values) {
  return values.find((value) => String(value || '').trim()) || '';
}

function matchHint(diagnostic, context, rules) {
  return [...rules]
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
    .find((rule) => matchesRule(diagnostic, context, rule));
}

function matchesRule(diagnostic, context, rule) {
  const match = rule.match || {};
  if (match.source && diagnostic.source !== match.source) return false;
  if (match.category && diagnostic.category !== match.category) return false;
  if (match.severity && diagnostic.severity !== match.severity) return false;
  if (match.code && !arrayOf(match.code).includes(String(diagnostic.code || ''))) return false;
  if (match.codeRegex && !anyRegex(match.codeRegex, String(diagnostic.code || ''))) return false;
  if (match.messageRegex && !anyRegex(match.messageRegex, String(diagnostic.message || ''))) return false;
  if (match.locationAdjustmentReason && diagnostic.locationAdjustmentReason !== match.locationAdjustmentReason) return false;
  if (match.contextRegex && !anyRegexInValues(match.contextRegex, [
    context.codeLine,
    context.prevCodeLine,
    context.nextCodeLine,
    context.codeStatement,
    String(context.codeLine || '').trim(),
    String(context.prevCodeLine || '').trim(),
    String(context.nextCodeLine || '').trim()
  ])) return false;
  return true;
}

function refineDiagnosticLocation(diagnostic, files = []) {
  if (!shouldTryPreviousLineTerminator(diagnostic)) return diagnostic;
  const file = files.find((candidate) => candidate.path === diagnostic.file) || files[0];
  if (!file) return diagnostic;

  const lines = String(file.content || '').split(/\r?\n/);
  const lineIndex = Math.max(0, Number(diagnostic.line || 1) - 1);
  const currentLine = lines[lineIndex] || '';
  if (!startsNewSysmlStatement(currentLine) && !isClosingBraceLine(currentLine)) return diagnostic;

  const previous = previousMeaningfulLine(lines, lineIndex);
  if (!previous || !looksLikeUnterminatedSysmlStatement(previous.text)) return diagnostic;

  return {
    ...diagnostic,
    validatorLine: diagnostic.validatorLine || diagnostic.line,
    validatorColumn: diagnostic.validatorColumn || diagnostic.column,
    line: previous.index + 1,
    column: Math.max(1, previous.text.length),
    locationAdjusted: true,
    locationAdjustmentReason: 'previous-line-missing-terminator'
  };
}

function shouldTryPreviousLineTerminator(diagnostic) {
  if (diagnostic.category && diagnostic.category !== 'syntax') return false;
  const message = String(diagnostic.message || '');
  return /(?:no viable alternative|mismatched input|extraneous input).*input ['"]?}/i.test(message)
    || /(?:no viable alternative|mismatched input|extraneous input).*input ['"]?(?:part|item|port|interface|connection|action|state|requirement|constraint|calc|calculation|analysis|verification|view|expose|flow|end|attribute|satisfy|verify)\b/i.test(message);
}

function isClosingBraceLine(line) {
  return /^\s*}\s*;?\s*(?:\/\/.*)?$/.test(line);
}

function previousMeaningfulLine(lines, fromIndex) {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const text = lines[index] || '';
    const trimmed = stripInlineComment(text).trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//')) continue;
    return { index, text };
  }
  return null;
}

function startsNewSysmlStatement(line) {
  return /^(?:\s*)(?:abstract\s+)?(?:part\s+def|part|item\s+def|item|port\s+def|port|interface\s+def|interface|connection\s+def|connection|action\s+def|action|state\s+def|state|requirement\s+def|requirement|constraint\s+def|constraint|calc\s+def|calc|calculation\s+def|calculation|analysis\s+def|analysis|verification\s+def|verification|view\s+def|view|expose|flow|end|attribute\s+def|attribute|satisfy|verify)\b/.test(line);
}

function looksLikeUnterminatedSysmlStatement(line) {
  const trimmed = stripInlineComment(line).trim();
  if (!trimmed || trimmed.startsWith('//')) return false;
  if (/[;{}]\s*$/.test(trimmed)) return false;
  return startsNewSysmlStatement(trimmed) || /:\s*[A-Za-z_][\w:]*/.test(trimmed);
}

function stripInlineComment(line) {
  return sysmlCodeOnlyText(line);
}

function splitSysmlLineComment(line) {
  const text = String(line || '');
  let quote = '';
  for (let index = 0; index < text.length - 1; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && next === '/') {
      return {
        code: text.slice(0, index),
        comment: text.slice(index)
      };
    }
  }
  return { code: text, comment: '' };
}

function anyRegexInValues(patterns, values) {
  return arrayOf(patterns).some((pattern) => {
    let regex;
    try {
      regex = new RegExp(pattern, 'im');
    } catch {
      return false;
    }
    return arrayOf(values).some((value) => regex.test(String(value || '')));
  });
}

function anyRegex(patterns, value) {
  const text = String(value || '');
  return arrayOf(patterns).some((pattern) => {
    try {
      return new RegExp(pattern, 'im').test(text);
    } catch {
      return false;
    }
  });
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [value];
}

function normalizeDiagnosticLocation(diagnostic, sourceMap, files = [], entryFile) {
  const rawLine = Number(diagnostic.line || 1);
  const rawColumn = Number(diagnostic.column || 1);
  const mapped = sourceMap.get(rawLine);
  if (!mapped || mapped.boundary) {
    return {
      ...diagnostic,
      file: normalizeDiagnosticFile(diagnostic.file, files, entryFile),
      line: Math.max(1, rawLine),
      column: Math.max(1, rawColumn)
    };
  }
  return {
    ...diagnostic,
    rawFile: diagnostic.file,
    rawLine,
    rawColumn,
    file: mapped.file,
    line: mapped.line,
    column: Math.max(1, rawColumn)
  };
}

function normalizeDiagnosticFile(file, files = [], entryFile) {
  const text = String(file || '');
  const byExactName = files.find((candidate) => candidate.path === text);
  if (byExactName) return byExactName.path;
  const bySuffix = files.find((candidate) => text.endsWith(candidate.path));
  if (bySuffix) return bySuffix.path;
  return entryFile || files[0]?.path || text || 'main.sysml';
}

function sourceContext(diagnostic, files) {
  const file = files.find((candidate) => candidate.path === diagnostic.file) || files[0] || { content: '' };
  const lines = String(file.content || '').split(/\r?\n/);
  const lineIndex = Math.max(0, Number(diagnostic.line || 1) - 1);
  const lineText = lines[lineIndex] || '';
  const prevLine = lineIndex > 0 ? lines[lineIndex - 1] || '' : '';
  const nextLine = lines[lineIndex + 1] || '';
  const statement = surroundingStatement(lines, lineIndex);
  return {
    lineText,
    prevLine,
    nextLine,
    statement,
    codeLine: stripInlineComment(lineText),
    prevCodeLine: stripInlineComment(prevLine),
    nextCodeLine: stripInlineComment(nextLine),
    codeStatement: stripSysmlCommentsFromStatement(statement)
  };
}

function surroundingStatement(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(lines.length, lineIndex + 3);
  return lines.slice(start, end).join('\n');
}

function stripSysmlCommentsFromStatement(statement) {
  return sysmlCodeOnlyText(statement);
}

function buildCombinedSourceMap(files) {
  const map = new Map();
  let combinedLine = 1;
  files.forEach((file, fileIndex) => {
    map.set(combinedLine, { file: file.path, line: 0, boundary: true, text: `// file: ${file.path}` });
    combinedLine += 1;
    const lines = String(file.content || '').split(/\r?\n/);
    lines.forEach((line, index) => {
      map.set(combinedLine, { file: file.path, line: index + 1, text: line });
      combinedLine += 1;
    });
    if (fileIndex < files.length - 1) {
      map.set(combinedLine, { file: file.path, line: lines.length, boundary: true, text: '' });
      combinedLine += 1;
    }
  });
  return map;
}

module.exports = {
  enhanceOfficialDiagnostics,
  loadDiagnosticHints,
  buildCombinedSourceMap,
  matchHint
};
