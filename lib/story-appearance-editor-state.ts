import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import type { StoryAppearance } from "./story-appearance";

const PREFIX = "ai_phone_story_appearance_editor_v1_";
const LAST_ROLE_KEY = `${PREFIX}last_role`;
registerDynamicPrefix(PREFIX);

export type StoryAppearanceEditorRole = "user" | "assistant" | "both";
export type StoryAppearanceEditorState = {
  role: StoryAppearanceEditorRole;
  barsOpen: boolean;
  cssOpen: boolean;
  scrollTop: number;
  selectedPresetId?: string;
  draft?: { appearance?: StoryAppearance; baseAppearance?: StoryAppearance };
};

const roleOrDefault = (value: unknown): StoryAppearanceEditorRole => value === "assistant" || value === "both" ? value : "user";
const scrollOrDefault = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(10_000_000, value)) : 0;
const validAppearance = (value: unknown): boolean => value === undefined || (!!value && typeof value === "object" && !Array.isArray(value));

export function loadStoryAppearanceEditorState(sessionId: string, appliedAppearance?: StoryAppearance): StoryAppearanceEditorState {
  const fallback: StoryAppearanceEditorState = { role: roleOrDefault(kvGet(LAST_ROLE_KEY)), barsOpen: false, cssOpen: false, scrollTop: 0 };
  try {
    const raw = kvGet(`${PREFIX}${sessionId}`);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return fallback;
    const draft = saved.draft;
    return {
      role: roleOrDefault(saved.role), barsOpen: saved.barsOpen === true, cssOpen: saved.cssOpen === true,
      scrollTop: scrollOrDefault(saved.scrollTop),
      selectedPresetId: typeof saved.selectedPresetId === "string" ? saved.selectedPresetId : undefined,
      // A saved draft must not overwrite styles imported or changed elsewhere since it was started.
      draft: draft && typeof draft === "object" && !Array.isArray(draft) && validAppearance(draft.appearance) && validAppearance(draft.baseAppearance)
        && JSON.stringify(draft.baseAppearance) === JSON.stringify(appliedAppearance) ? draft : undefined,
    };
  } catch {
    return fallback;
  }
}

export function saveStoryAppearanceEditorState(sessionId: string, state: StoryAppearanceEditorState): void {
  const role = roleOrDefault(state.role);
  const raw = JSON.stringify({ ...state, role, scrollTop: scrollOrDefault(state.scrollTop) });
  const key = `${PREFIX}${sessionId}`;
  if (kvGet(key) !== raw) kvSet(key, raw);
  if (kvGet(LAST_ROLE_KEY) !== role) kvSet(LAST_ROLE_KEY, role);
}
