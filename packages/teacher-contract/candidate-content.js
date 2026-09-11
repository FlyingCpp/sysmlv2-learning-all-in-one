'use strict';
const crypto = require('crypto');
const { DEFINITIONS } = require('../agent-resource-policy');
// 协议绝对上限派生自策略允许范围；每轮准入仍使用冻结策略。
const MAX_CANDIDATE_ARTIFACT_BYTES = DEFINITIONS.find(d => d.key === 'candidate.maxArtifactBytes').maximum;
function renderSysmlCode(content) {
  const text = canonicalCodeForBinding(content);
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + 'sysml\n' + text + '\n' + fence;
}
function canonicalWorkspaceText(files) {
  return [...files].sort((a,b)=>String(a.path).localeCompare(String(b.path)))
    .map(f=>String(f.path)+'\n'+'sha256:'+crypto.createHash('sha256').update(String(f.content || ''),'utf8').digest('hex')).join('\n');
}
function canonicalCodeForBinding(value) {
  let text = String(value || '').replace(/\r\n|\r/g, '\n');
  if (text.startsWith('\n')) text = text.slice(1);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

function parseMarkdownFences(value) {
  const lines = String(value || '').replace(/\r\n|\r/g, '\n').split('\n');
  const blocks = [];
  const proseLines = [];
  let open;
  for (const line of lines) {
    if (!open) {
      const opening = fenceOpeningCandidate(line);
      const match = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)$/.exec(opening.line);
      if (!match) {
        proseLines.push(line);
        continue;
      }
      const indentation = match[1] || '';
      const markerRun = match[2] || '';
      const info = String(match[3] || '').trim();
      open = {
        marker: markerRun[0],
        length: markerRun.length,
        language: String(info.split(/\s+/)[0] || '').toLowerCase(),
        content: [],
        containerized: opening.containerized || indentation.includes('\t') || indentation.length > 3
      };
      proseLines.push('');
      continue;
    }
    const close = open.containerized ? null : /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    if (close && close[1]?.[0] === open.marker && close[1].length >= open.length) {
      blocks.push({
        language: open.language,
        content: canonicalCodeForBinding(open.content.join('\n')),
        closed: true
      });
      open = undefined;
      proseLines.push('');
      continue;
    }
    open.content.push(line);
    proseLines.push('');
  }
  if (open) {
    blocks.push({
      language: open.language,
      content: canonicalCodeForBinding(open.content.join('\n')),
      closed: false
    });
  }
  return { blocks, proseOutside: proseLines.join('\n') };
}

function fenceOpeningCandidate(value) {
  let line = String(value || '');
  let containerized = false;
  while (true) {
    const quote = /^[ \t]*>[ \t]?/.exec(line);
    const list = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
    const prefix = quote?.[0] || list?.[0];
    if (!prefix) break;
    line = line.slice(prefix.length);
    containerized = true;
  }
  return { line, containerized };
}

function sysmlCodeBlocks(value) { return parseMarkdownFences(value).blocks.filter(b=>b.closed && ['sysml','sysmlv2'].includes(b.language)); }
module.exports = {MAX_CANDIDATE_ARTIFACT_BYTES, renderSysmlCode, canonicalWorkspaceText, canonicalCodeForBinding, parseMarkdownFences, sysmlCodeBlocks};
