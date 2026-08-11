export interface TeacherConversationMessage {
  role?: string;
  runId?: string;
  requestId?: string;
  createdAt?: string;
  status?: string;
}

interface IndexedConversationMessage<T> {
  message: T;
  index: number;
  timestamp: number | null;
}

interface ConversationTurn<T> {
  firstIndex: number;
  timestamp: number | null;
  messages: IndexedConversationMessage<T>[];
}

/**
 * 按运行相关性重建对话轮次，避免数据库中同时间戳消息出现“回答在问题前”。
 */
export function orderTeacherConversationMessages<T extends TeacherConversationMessage>(messages: T[]): T[] {
  const turns = new Map<string, ConversationTurn<T>>();
  messages.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const correlationId = String(message.runId || message.requestId || '').trim();
    const turnKey = correlationId ? `turn:${correlationId}` : `message:${index}`;
    const timestamp = conversationTimestamp(message.createdAt);
    const turn = turns.get(turnKey) || { firstIndex: index, timestamp, messages: [] };
    turn.firstIndex = Math.min(turn.firstIndex, index);
    if (timestamp !== null && (turn.timestamp === null || timestamp < turn.timestamp)) turn.timestamp = timestamp;
    turn.messages.push({ message, index, timestamp });
    turns.set(turnKey, turn);
  });

  return Array.from(turns.values())
    .sort((left, right) => compareTimestampThenIndex(left.timestamp, right.timestamp, left.firstIndex, right.firstIndex))
    .flatMap((turn) => turn.messages
      .sort((left, right) => {
        const roleOrder = conversationRoleOrder(left.message.role) - conversationRoleOrder(right.message.role);
        if (roleOrder) return roleOrder;
        return compareTimestampThenIndex(left.timestamp, right.timestamp, left.index, right.index);
      })
      .map((item) => item.message));
}

/**
 * 找到刷新后仍可恢复的后台运行。只有服务端仍标记为received的用户消息才参与恢复。
 */
export function latestRecoverableTeacherRun<T extends TeacherConversationMessage>(messages: T[]): T | undefined {
  return [...orderTeacherConversationMessages(messages)]
    .reverse()
    .find((message) => (
      message.role === 'user'
      && message.status === 'received'
      && Boolean(String(message.runId || '').trim())
    ));
}

function conversationTimestamp(value: unknown): number | null {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareTimestampThenIndex(left: number | null, right: number | null, leftIndex: number, rightIndex: number): number {
  if (left !== null && right !== null && left !== right) return left - right;
  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return leftIndex - rightIndex;
}

function conversationRoleOrder(role: unknown): number {
  return role === 'user' ? 0 : role === 'assistant' ? 1 : 2;
}
