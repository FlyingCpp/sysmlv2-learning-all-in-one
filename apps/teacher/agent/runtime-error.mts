/** 阶段只补充上下文；SDK/DOM/Provider 超时在此统一识别。外部取消由调用者优先处理。 */
export function isTimeoutError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { name?: string; code?: string; message?: string; cause?: unknown };
    if (["TimeoutError", "StepTimeoutError", "RepairStepTimeoutError"].includes(value.name ?? "")
      || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(value.code ?? "")
      || /(?:\btimed?\s*out\b|\btimeout\b|repair_step_timeout)/iu.test(value.message ?? "")) return true;
    current = value.cause;
  }
  return false;
}
