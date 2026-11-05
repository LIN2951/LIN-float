import { kvGet, kvSet, kvSetAsync, registerDynamicPrefix } from "./kv-db";
import { getNativeTimelineEntryKey } from "./native-timeline-key";
import type { NativeTimelineEntry } from "./short-term-assembler";
import type { ChatMessage } from "./chat-storage";

const HIDDEN = "ai_phone_hidden_short_term_memory:";
const MANUAL = "ai_phone_manual_short_term_memory:";
registerDynamicPrefix(HIDDEN); registerDynamicPrefix(MANUAL);
export const SHORT_MEMORY_CHANGED = "short-term-memory-changed";
const cache = new Map<string, { raw: string | null; values: unknown[] }>();
function read(key: string): unknown[] {
  const raw = kvGet(key) ?? null, saved = cache.get(key);
  if (saved?.raw === raw) return saved.values;
  let values: unknown[] = [];
  try { const parsed = JSON.parse(raw || "[]"); if (Array.isArray(parsed)) values = parsed; } catch { /* Ignore corrupt imported configuration. */ }
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  cache.set(key, { raw, values }); return values;
}
export const hiddenMemoryKeys = (characterId: string) => new Set(read(HIDDEN + characterId).filter((value): value is string => typeof value === "string"));
const legacyKey = (entry: NativeTimelineEntry) => entry.sourceDetail === "direct" ? getNativeTimelineEntryKey({ ...entry, sessionId: undefined }) : "";
export const isMemoryEntryDeleted = (entry: NativeTimelineEntry, keys: Set<string>) => keys.has(getNativeTimelineEntryKey(entry)) || keys.has(legacyKey(entry));
function changed(characterId: string) { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SHORT_MEMORY_CHANGED, { detail: { characterId } })); }

export function hideNativeTimelineEntries(characterId: string, entries: NativeTimelineEntry[]): number {
  if (!characterId || !entries.length) return 0;
  const keys = hiddenMemoryKeys(characterId), before = keys.size;
  entries.forEach(entry => keys.add(getNativeTimelineEntryKey(entry)));
  // Never expire old deletions when newer entries are removed.
  kvSet(HIDDEN + characterId, JSON.stringify([...keys])); changed(characterId);
  return keys.size - before;
}

export function restoreNativeTimelineEntries(characterId: string, entries: NativeTimelineEntry[]): void {
  const keys = hiddenMemoryKeys(characterId);
  entries.forEach(entry => { keys.delete(getNativeTimelineEntryKey(entry)); keys.delete(legacyKey(entry)); });
  kvSet(HIDDEN + characterId, JSON.stringify([...keys])); changed(characterId);
}

export function loadManualShortMemories(characterId: string): NativeTimelineEntry[] {
  return read(MANUAL + characterId).filter((value): value is NativeTimelineEntry => !!value && typeof value === "object"
    && typeof (value as NativeTimelineEntry).id === "string" && typeof (value as NativeTimelineEntry).content === "string"
    && Number.isFinite(Date.parse((value as NativeTimelineEntry).timestamp)))
    .map(entry => ({ ...entry, memorySupplement: true }));
}

export function importShortMemories(characterId: string, entries: NativeTimelineEntry[]): { added: number; overwritten: number } {
  const map = new Map(loadManualShortMemories(characterId).map(entry => [getNativeTimelineEntryKey(entry), entry]));
  let added = 0, overwritten = 0;
  for (const entry of entries) {
    const key = getNativeTimelineEntryKey(entry);
    if (map.has(key)) overwritten++; else added++;
    map.set(key, { ...entry, memorySupplement: true });
  }
  kvSet(MANUAL + characterId, JSON.stringify([...map.values()]));
  restoreNativeTimelineEntries(characterId, entries);
  return { added, overwritten };
}

/** Imports can exceed localStorage fallback capacity: report success only after IndexedDB commits. */
export async function persistShortMemoryChanges(characterId: string): Promise<void> {
  for (const prefix of [MANUAL, HIDDEN]) {
    const key = prefix + characterId, value = kvGet(key);
    if (value != null) await kvSetAsync(key, value);
  }
}

export function mergeShortMemoryEntries(characterId: string, native: NativeTimelineEntry[], includeDeleted = false, after?: string): NativeTimelineEntry[] {
  const map = new Map(native.map(entry => [getNativeTimelineEntryKey(entry), entry]));
  loadManualShortMemories(characterId).forEach(entry => { if (!after || entry.timestamp > after) map.set(getNativeTimelineEntryKey(entry), entry); });
  const hidden = hiddenMemoryKeys(characterId);
  return [...map.values()].filter(entry => includeDeleted || !isMemoryEntryDeleted(entry, hidden)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Exclude deleted current-chat turns too; the original visible chat remains intact. */
export function applyShortMemoryToChatHistory(characterId: string, history: ChatMessage[], appId: string): ChatMessage[] {
  if (appId !== "chat" && appId !== "group_chat") return history;
  const hidden = hiddenMemoryKeys(characterId);
  const manual = new Map(loadManualShortMemories(characterId).filter(entry => entry.sourceApp === "chat")
    .map(entry => [`${entry.groupSessionId || entry.sessionId}\u0000${entry.id}`, entry]));
  return history.filter(message => {
    const entry: NativeTimelineEntry = { id: message.id, sourceApp: "chat", sourceDetail: appId === "group_chat" ? "group" : "direct",
      ...(appId === "group_chat" ? { groupSessionId: message.sessionId } : { sessionId: message.sessionId }), timestamp: message.createdAt, content: message.content };
    return !isMemoryEntryDeleted(entry, hidden);
  }).map(message => {
    const replacement = manual.get(`${message.sessionId}\u0000${message.id}`);
    return replacement ? { ...message, content: replacement.memoryRawContent ?? replacement.content, createdAt: replacement.timestamp } : message;
  });
}

export function isSharedMemoryEntry(entry: NativeTimelineEntry): boolean {
  return entry.memoryScope ? entry.memoryScope === "shared" : (entry.sourceApp === "moments" && entry.postAuthorType === "user")
    || (entry.sourceApp === "chat" && entry.sourceDetail === "group") || entry.sourceDetail === "interview_shared_issue";
}
