import type { NativeTimelineEntry } from "./short-term-assembler";

export type ManualMemorySource = "chat" | "moments" | "story" | "vn";
export const MEMORY_PASTE_EXAMPLES = {
  moments: "时间：2026-10-01 18:30\n发布人：昵称\n内容：今天的朋友圈内容\n---\n时间：2026-10-02 09:00\n发布人：昵称\n内容：另一条朋友圈",
  story: "时间：2026-10-01 18:30\n分线：主线\n说话人：昵称\n内容：这一段剧情\n---\n时间：2026-10-02 09:00\n分线：雨夜分线\n说话人：昵称\n内容：另一段剧情",
  vn: "时间：2026-10-01 18:30\n说话人：昵称\n内容：这一段漫卷内容",
} as const;

function timestamp(value: unknown, index: number): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/.test(value.trim())) throw Error(`第 ${index + 1} 条缺少有效时间，请填写年月日及时间`);
  const text = value.trim().replace(/\s+/, "T");
  const parsed = new Date(text.length === 10 ? text + "T00:00:00" : text);
  if (!Number.isFinite(parsed.getTime())) throw Error(`第 ${index + 1} 条时间无效`);
  // Reject silently normalized dates such as February 31.
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || month < 1 || month > 12) throw Error(`第 ${index + 1} 条日期无效`);
  return parsed.toISOString();
}
function stableId(value: string): string { return encodeURIComponent(value); }

export function parseMemoryPaste(text: string, source: Exclude<ManualMemorySource, "chat">, scope: "short" | "shared", characterId: string): NativeTimelineEntry[] {
  if (!text.trim()) throw Error("请先粘贴内容");
  const blocks = text.trim().split(/\n\s*---+\s*\n/);
  if (blocks.length > 5000) throw Error("单次最多补充 5000 条，请拆分后添加");
  const occurrences = new Map<string, number>();
  return blocks.map((block, index) => {
    const data: Record<string, string> = {}; let field = "";
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^(时间|发布人|说话人|内容|分线|编号)[：:]\s*(.*)$/);
      if (match) { field = match[1]; data[field] = match[2]; } else if (field) data[field] += "\n" + line;
    }
    const time = timestamp(data["时间"], index), speaker = (data["发布人"] || data["说话人"] || "").trim(), content = data["内容"]?.trim();
    if (!speaker || !content) throw Error(`第 ${index + 1} 条需填写${source === "moments" ? "发布人" : "说话人"}和内容`);
    const branch = data["分线"]?.trim() || "主线";
    const base = `${source}:${characterId}:${time}:${speaker}:${source === "story" ? branch : ""}`;
    const occurrence = occurrences.get(base) || 0; occurrences.set(base, occurrence + 1);
    return { id: data["编号"]?.trim() || `manual-${stableId(base)}-${occurrence}`, sourceApp: source,
      ...(source === "story" ? { sourceDetail: "story" as const, sessionId: `manual-story:${characterId}:${branch}` } : {}),
      ...(source === "moments" ? { postAuthorType: scope === "shared" ? "user" as const : "character" as const } : {}),
      timestamp: time, content: `${source === "story" ? `【${branch}】` : ""}${speaker}：${content}`, userNickname: speaker, memoryScope: scope, memorySupplement: true };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function parseChatMemoryFile(text: string, scope: "short" | "shared", characterName: string): NativeTimelineEntry[] {
  const value = JSON.parse(text);
  if (value?.type !== "float-chat-records" || value.version !== 1 || !Array.isArray(value.messages)) throw Error("请选择 Float 导出的聊天记录 JSON 文件");
  if (value.messages.length > 100000) throw Error("超过 100000 条，请拆分后导入");
  return value.messages.filter((message: { role: string }) => message?.role === "user" || message?.role === "assistant").map((message: Record<string, unknown>, index: number) => {
    if (typeof message.id !== "string" || typeof message.sessionId !== "string" || typeof message.content !== "string") throw Error(`第 ${index + 1} 条记录格式不完整`);
    const time = timestamp(message.createdAt, index), isGroup = value.session?.isGroup === true;
    const name = typeof message.senderName === "string" && message.senderName.trim() ? message.senderName : message.role === "user" ? "用户" : characterName;
    return { id: message.id, sourceApp: "chat" as const, sourceDetail: isGroup ? "group" as const : "direct" as const,
      ...(isGroup ? { groupSessionId: message.sessionId, groupName: value.session?.name || "群聊" } : { sessionId: message.sessionId }),
      timestamp: time, authorType: message.role === "user" ? "user" as const : "character" as const,
      content: `${name}：${message.content || "[媒体消息]"}`, memoryRawContent: message.content,
      userNickname: name, memoryScope: scope, memorySupplement: true };
  }).sort((a: NativeTimelineEntry, b: NativeTimelineEntry) => a.timestamp.localeCompare(b.timestamp));
}
