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
 * 只把客户可见对话和授权任务原文投影给Provider。业务ID、Hash、权限和运行状态
 * 继续留在服务端对象中；Main内部Tool/Reasoning消息也不会跨Worker复用。
 */
export function projectConversationModelMessages(
  conversation: readonly PublicConversationMessage[],
  taskSources: readonly AuthorizedTaskSourceText[] = [],
  fallbackUserText = "",
): ModelMessage[] {
  const projected: ModelMessage[] = [];
  const userTexts = new Set<string>();
  const fallback = String(fallbackUserText ?? "").trim();
  for (const message of conversation) {
    const content = String(message.content ?? "").trim();
    if (!content) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    // 当前请求由调用方单独传入，并且必须是最终一条user消息。若先保留历史中的
    // 同文消息，后补的旧TaskSource可能排到其后，Provider会把旧目标误判为当前任务。
    if (role === "user" && fallback && content === fallback) continue;
    projected.push({ role, content });
    if (role === "user") userTexts.add(content);
  }
  for (let sourceIndex = 0; sourceIndex < taskSources.length; sourceIndex += 1) {
    const source = taskSources[sourceIndex];
    if (!source) continue;
    const text = String(source.text ?? "").trim();
    if (!text || text === fallback || userTexts.has(text)) continue;
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
  if (fallback) projected.push({ role: "user", content: fallback });
  return projected;
}

/**
 * Final Answer只解释当前任务和当前Run终末事实。历史Transcript已由Main用于理解追问，
 * 不再把旧Assistant叙述传给Finalizer；终末事实由独立System Instructions承载。
 */
export function projectFinalAnswerModelMessages(
  taskSources: readonly AuthorizedTaskSourceText[] = [],
  currentUserText = "",
): ModelMessage[] {
  return projectConversationModelMessages([], taskSources, currentUserText);
}

/** 服务端可信执行投影走AI SDK原生System Instructions，不伪装成学生消息。 */
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

export function appendUserModelMessage(
  messages: readonly ModelMessage[],
  content: string,
): ModelMessage[] {
  return [...messages, { role: "user", content }];
}
