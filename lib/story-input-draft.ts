import { kvGet, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";

const PREFIX = "ai_phone_story_input_draft_v1_";
registerDynamicPrefix(PREFIX);

export function loadStoryInputDraft(sessionId: string): string {
  return sessionId ? kvGet(PREFIX + sessionId) || "" : "";
}

export function saveStoryInputDraft(sessionId: string, text: string): void {
  if (!sessionId) return;
  const key = PREFIX + sessionId;
  if (!text) { if (kvGet(key) !== null) kvRemove(key); }
  else if (kvGet(key) !== text) kvSet(key, text);
}
