import { loadNativeTimelineAsync, type NativeTimelineEntry } from "./short-term-assembler";
import { getNativeTimelineEntryKey } from "./native-timeline-key";
import { hiddenMemoryKeys, isMemoryEntryDeleted, isSharedMemoryEntry } from "./short-term-memory-records";
import { loadStoryProjectionEntries } from "./story-storage";

export const MEMORY_SCAN_SOURCES = [
  ["chat", "私聊"], ["group", "群聊"], ["moments", "朋友圈"], ["story", "剧情（主线与分线）"], ["vn", "漫卷"],
  ["checkphone", "查手机"], ["xiaohongshu", "小红书"], ["game", "小游戏"], ["map", "地图冒险"],
  ["interview_magazine", "在场访谈"], ["cocreate", "共创"], ["custom_app", "自定义 APP"],
] as const;
export type MemoryScanSource = typeof MEMORY_SCAN_SOURCES[number][0];
export type MemoryCandidate = { entry: NativeTimelineEntry; status: "deleted" | "missing" | "new" | "overwrite" };
export function memorySource(entry: NativeTimelineEntry): string {
  return entry.sourceApp === "chat" ? entry.sourceDetail === "group" || entry.groupSessionId ? "group" : "chat" : entry.sourceApp;
}
export function entriesForMemoryTab(entries: NativeTimelineEntry[], scope: "short" | "shared"): NativeTimelineEntry[] {
  return entries.filter(entry => scope === "shared" ? isSharedMemoryEntry(entry) : entry.memoryScope ? entry.memoryScope === "short"
    : !(entry.sourceApp === "moments" && entry.postAuthorType === "user") && entry.sourceDetail !== "interview_shared_issue");
}
export async function scanShortMemory(characterId: string, scope: "short" | "shared", sources: string[], current: NativeTimelineEntry[], signal: AbortSignal) {
  const raw = await loadNativeTimelineAsync(characterId, { includeDeleted: true, signal });
  if (scope === "short" && sources.includes("story")) {
    // Native memory normally omits unmemorized branches or replies without summaries.
    // Scan saved text too; only explicitly selected candidates become supplemental memory.
    for (const entry of loadStoryProjectionEntries(characterId, { includeUnmemorized: true })) raw.push({ ...entry, sourceApp: "story", sourceDetail: "story" });
  }
  if (signal.aborted) throw new DOMException("扫描已停止", "AbortError");
  const selected = new Set(sources), existing = new Set(current.map(getNativeTimelineEntryKey)), hidden = hiddenMemoryKeys(characterId);
  const unique = new Map<string, NativeTimelineEntry>();
  for (const entry of entriesForMemoryTab(raw, scope)) if (selected.has(memorySource(entry))) unique.set(getNativeTimelineEntryKey(entry), entry);
  const candidates: MemoryCandidate[] = [];
  let skipped = 0;
  unique.forEach((entry, key) => {
    if (isMemoryEntryDeleted(entry, hidden)) candidates.push({ entry, status: "deleted" });
    else if (!existing.has(key)) candidates.push({ entry, status: "missing" });
    else skipped++;
  });
  return { candidates, scanned: unique.size, skipped };
}
