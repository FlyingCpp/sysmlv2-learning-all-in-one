import {
  TOOL_NAMES,
  type EditorGrounding,
  type TeacherAgentContext,
  type ToolName,
} from "./types.mjs";

function lineColumn(content: string, offset: number): { line: number; column: number; lineText: string } {
  const before = content.slice(0, offset);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEndCandidate = content.indexOf("\n", offset);
  const lineEnd = lineEndCandidate === -1 ? content.length : lineEndCandidate;
  return {
    line,
    column: offset - lineStart + 1,
    lineText: content.slice(lineStart, lineEnd),
  };
}

export function deriveEditorGrounding(context: TeacherAgentContext): EditorGrounding {
  const files = new Map(context.model.files.map((file) => [file.fileId, file]));
  const selection = context.model.selection;
  if (selection) {
    const file = files.get(selection.fileId);
    if (!file) {
      return { kind: "none", reason: "no_focus" };
    }
    const start = lineColumn(file.content, selection.from);
    const end = lineColumn(file.content, selection.to);
    return {
      kind: "selection",
      fileId: file.fileId,
      displayName: file.displayName,
      from: selection.from,
      to: selection.to,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      text: file.content.slice(selection.from, selection.to),
    };
  }

  const cursor = context.model.cursor;
  if (cursor?.zone === "code") {
    const file = files.get(cursor.fileId);
    if (!file) {
      return { kind: "none", reason: "no_focus" };
    }
    const location = lineColumn(file.content, cursor.offset);
    return {
      kind: "code_cursor",
      fileId: file.fileId,
      displayName: file.displayName,
      offset: cursor.offset,
      line: location.line,
      column: location.column,
      lineText: location.lineText,
    };
  }
  if (cursor?.zone === "non_code") {
    return { kind: "non_code_cursor", surface: cursor.surface };
  }

  const activeFile = context.model.activeFileId
    ? files.get(context.model.activeFileId)
    : undefined;
  return activeFile
    ? {
        kind: "none",
        reason: "active_file_only",
        fileId: activeFile.fileId,
        displayName: activeFile.displayName,
      }
    : { kind: "none", reason: "no_focus" };
}

export function normalizeCapabilityGrant(grant: readonly ToolName[]): ReadonlySet<ToolName> {
  return new Set(grant);
}

export function activeToolsForGrant(grant: ReadonlySet<ToolName>): ToolName[] {
  return TOOL_NAMES.filter((toolName) => grant.has(toolName));
}

export function assertToolCapability(
  grant: ReadonlySet<ToolName>,
  toolName: ToolName,
): void {
  if (!grant.has(toolName)) {
    throw new Error(`Tool capability denied: ${toolName}`);
  }
}
