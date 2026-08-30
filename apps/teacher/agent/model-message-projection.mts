import type { Instructions, ModelMessage } from "ai";

export type PublicConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type AuthorizedTaskSourceText = Readonly<{
  relation: string;
  text: string;
}>;

/**
 * 只把客户可见对话和授权任务原文投影给 Provider。业务 ID、Hash、权限和运行状态
 * 继续留在服务端对象中；Main 内部 Tool/Reasoning 消息也不会跨 Worker 复用。
 */
export function projectConversationModelMessages(
  conversation: readonly PublicConversationMessage[],
  taskSources: readonly AuthorizedTaskSourceText[] = [],
  fallbackUserText = "",
): ModelMessage[] {
  const projected: ModelMessage[] = [];
  const userTexts = new Set<string>();
  for (const message of conversation) {
    const content = String(message.content ?? "").trim();
    if (!content) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    projected.push({ role, content });
    if (role === "user") userTexts.add(content);
  }
  for (let sourceIndex = 0; sourceIndex < taskSources.length; sourceIndex += 1) {
    const source = taskSources[sourceIndex];
    if (!source) continue;
    const text = String(source.text ?? "").trim();
    if (!text || userTexts.has(text)) continue;
    const laterSourceTexts = new Set(taskSources.slice(sourceIndex + 1)
      .map((entry) => String(entry.text ?? "").trim())
      .filter(Boolean));
    const insertBefore = projected.findIndex((message) => (
      message.role === "user"
      && typeof message.content === "string"
      && laterSourceTexts.has(message.content.trim())
    ));
    const sourceMessage: ModelMessage = { role: "user", content: text };
    if (insertBefore >= 0) projected.splice(insertBefore, 0, sourceMessage);
    else projected.push(sourceMessage);
    userTexts.add(text);
  }
  const fallback = String(fallbackUserText ?? "").trim();
  if (fallback && !userTexts.has(fallback)) projected.push({ role: "user", content: fallback });
  return projected;
}

/** Final Answer 只接收本任务的授权原文；历史 Assistant 叙述不作为终末事实复用。 */
export function projectFinalAnswerModelMessages(
  taskSources: readonly AuthorizedTaskSourceText[] = [],
  currentUserText = "",
): ModelMessage[] {
  return projectConversationModelMessages([], taskSources, currentUserText);
}

/** 服务端可信执行投影走 AI SDK 原生 System Instructions，不伪装成学生消息。 */
export function systemInstructions(
  base: string,
  label: string,
  projection: unknown,
): Instructions {
  return [
    { role: "system", content: base },
    { role: "system", content: `[${label}]\n${JSON.stringify(projection)}` },
  ];
}
