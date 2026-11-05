import type { NativeTimelineEntry } from "./short-term-assembler";

export function getNativeTimelineEntryKey(entry: NativeTimelineEntry): string {
  return [entry.sourceApp, entry.sourceDetail ?? "", entry.sessionId ?? "", entry.groupSessionId ?? "", entry.customAppId ?? "", entry.id].join(":");
}
