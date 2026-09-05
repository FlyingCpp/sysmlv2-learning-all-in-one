export interface ExampleCatalogRow {
  readonly exampleId?: string;
  readonly title: string;
  readonly topicPath: string;
  readonly constructTags?: readonly string[];
  readonly exampleAuthority: "official-example" | "community-example" | string;
}
/** 按条目呈现，不让一个大主题遮掉后续主题；正文由同一个知识工具读取。 */
export function buildExampleTopicCatalog(examples: readonly ExampleCatalogRow[], charBudget = Number.POSITIVE_INFINITY): string {
  const lines: string[] = [];
  let used = 0;
  let deferred = 0;
  for (const row of examples) {
    const line = "- " + (row.exampleId ?? row.topicPath) + ": " + row.title + " (" + row.topicPath + ")";
    if (used + line.length > charBudget) { deferred += 1; continue; }
    lines.push(line); used += line.length + 1;
  }
  if (deferred) lines.push("另有" + deferred + "个条目未载入索引；可按query继续检索完整结果。");
  return lines.length ? "相关范例索引（按exampleIds读取完整正文）：\n" + lines.join("\n") : "";
}
