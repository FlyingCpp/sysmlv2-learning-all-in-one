import { createRequire } from "node:module";
// 编译产物位于 apps/teacher/dist/agent；共享实现位于现有协议包。
const shared = createRequire(import.meta.url)("../../../../packages/teacher-contract/candidate-content.js");
export const MAX_CANDIDATE_ARTIFACT_BYTES: number = shared.MAX_CANDIDATE_ARTIFACT_BYTES;
export const renderSysmlCode: (content: string) => string = shared.renderSysmlCode;
export const canonicalWorkspaceText: (files: readonly { path: string; content: string }[]) => string = shared.canonicalWorkspaceText;
export const parseMarkdownFences: (text: string) => {blocks: {language: string; content: string; closed: boolean}[]; proseOutside: string} = shared.parseMarkdownFences;

export const canonicalCodeForBinding: (content: string) => string = shared.canonicalCodeForBinding;

export type CandidateContentFailure = "empty" | "truncated" | "ambiguous";
export type CandidateContentExtraction = { success: true; content: string } | { success: false; reason: CandidateContentFailure };

/** 只解开唯一完整的模型围栏；不修补、不重写 SysML 语义。 */
export function extractCandidateContent(result: { text: string; finishReason?: string }): CandidateContentExtraction {
  const rawText = String(result.text || "");
  const text = rawText.trim();
  if (result.finishReason?.toLowerCase() === "length") return { success: false, reason: "truncated" };
  if (!text) return { success: false, reason: "empty" };
  const parsed = parseMarkdownFences(text);
  const modelBlocks = parsed.blocks.filter(block => ["sysml", "sysmlv2"].includes(block.language));
  // 裸 SysML 注释中的无语言反引号保持原文；明确模型围栏允许前后说明。
  if (modelBlocks.length || /^(?:`{3,}|~{3,})/u.test(text)) {
    const blocks = parsed.blocks.filter(block => ["sysml", "sysmlv2", ""].includes(block.language));
    if (blocks.length !== 1 || parsed.blocks.length !== 1) return { success: false, reason: "ambiguous" };
    const block = blocks[0]!;
    if (!block.closed) return { success: false, reason: "truncated" };
    return block.content ? { success: true, content: block.content } : { success: false, reason: "empty" };
  }
  return { success: true, content: rawText };
}
