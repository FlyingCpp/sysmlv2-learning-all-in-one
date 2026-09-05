export type KnowledgeContentRow = Record<string, unknown>;
export type KnowledgeContent = {
  claims: KnowledgeContentRow[];
  evidenceBlocks: KnowledgeContentRow[];
  examples: KnowledgeContentRow[];
  deferredContent: { kind: "claim" | "evidence" | "example"; id: string }[];
};

export function knowledgeTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

/** 原子条目选择：正文从不切片。最新查询优先；未进入窗口的内容仍由同一Tool完整读取。 */
export function selectKnowledgeContent(entries: readonly unknown[], tokenBudget: number): KnowledgeContent {
  const rows = { claims: new Map<string, KnowledgeContentRow>(), evidenceBlocks: new Map<string, KnowledgeContentRow>(), examples: new Map<string, KnowledgeContentRow>() };
  for (const entry of [...entries].reverse()) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    for (const [key, alternate, id] of [["claims", "newClaims", "claimId"], ["evidenceBlocks", "newEvidenceBlocks", "evidenceId"], ["examples", "examples", "exampleId"]] as const) {
      const list = source[key] ?? source[alternate];
      if (!Array.isArray(list)) continue;
      for (const value of list) {
        if (!value || typeof value !== "object" || !value[id]) continue;
        if (!rows[key].has(String(value[id]))) rows[key].set(String(value[id]), value);
      }
    }
  }
  const result: KnowledgeContent = { claims: [], evidenceBlocks: [], examples: [], deferredContent: [] };
  let remaining = Math.max(0, tokenBudget);
  const admittedEvidence = new Set<string>();
  for (const claim of rows.claims.values()) {
    const dependencies = (Array.isArray(claim.evidenceIds) ? claim.evidenceIds : []).map(id => rows.evidenceBlocks.get(String(id))).filter((row): row is KnowledgeContentRow => Boolean(row) && !admittedEvidence.has(String(row!.evidenceId)));
    const cost = knowledgeTokens({claim, dependencies});
    if (cost > remaining) { result.deferredContent.push({kind:"claim", id:String(claim.claimId)}); continue; }
    result.claims.push(claim); remaining -= cost;
    for (const row of dependencies) { result.evidenceBlocks.push(row); admittedEvidence.add(String(row.evidenceId)); }
  }
  for (const [key, kind, id] of [["examples", "example", "exampleId"], ["evidenceBlocks", "evidence", "evidenceId"]] as const) {
    for (const row of rows[key].values()) {
      if (key === "evidenceBlocks" && admittedEvidence.has(String(row[id]))) continue;
      const cost = knowledgeTokens(row);
      if (cost > remaining) { result.deferredContent.push({kind, id:String(row[id])}); continue; }
      result[key].push(row); remaining -= cost;
    }
  }
  return result;
}
