export const EXAMPLE_QUERY_FEW_SHOTS = `知识查询示例：
- 状态切换：state transition；连接端口：port connect。
- 保留有区分度的意图词，例如 mass rollup；不要仅因出现“汇总”就改为calc def。
- 范例是结构参考；结合当前任务、完整正文及依赖判断适用性，不能只看constructTags或coverage。`;
export function candidateReviewedKnowledgeGuidance(_coveredConstructTags: readonly string[] = []): string {
  return `已有完整可用模式时直接生成。存在具体语法、关系或依赖缺口时，查询构造词并保留有助区分的意图词。
完整条目按相关性排序；hasMore/nextOffset表示还有结果，可用同一query与offset继续读取，或用exampleIds定向读取正文。一次无结果只说明该查询没有新证据，不影响其他缺口。
查询不可用时利用已有上下文继续；总Run、工具预算和真实上下文窗口由服务端控制。不要为用完额度检索，也不要把标签覆盖当作已满足学生目标。`;
}

/** 仅整理召回查询，不修改任务或判定覆盖；排除项仍完整保留在 Candidate 的原始任务中。 */
export function candidateKnowledgeQuery(instruction: string): string {
  const positive = instruction.split(/[。；;，,\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !/(?:不要|不得|无需|不需要|不引入|不修改|不引用|不包含|排除|\b(?:do not|don't|without|exclude|must not)\b)/iu.test(clause));
  return positive.join("；").slice(0, 500);
}
