import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { StoryAppearancePrefs } from "./story-appearance";

const KEY = "ai_phone_story_appearance_presets_v1";
registerKvMigration(KEY);

export type StoryAppearancePreset = {
  id: string; name: string; prefs: StoryAppearancePrefs; css: string; createdAt: string; updatedAt: string;
};

/** Copy only visual settings; never capture voice, API or generation settings. */
export function copyStoryAppearancePrefs(prefs: StoryAppearancePrefs): StoryAppearancePrefs {
  return { theme: typeof prefs.theme === "string" ? prefs.theme : undefined,
    wallpaper: typeof prefs.wallpaper === "string" ? prefs.wallpaper : undefined,
    readingPanel: prefs.readingPanel === "show" || prefs.readingPanel === "hide" ? prefs.readingPanel : "auto",
    appearanceMode: prefs.appearanceMode === "css-only" ? "css-only" : "combined",
    appearance: prefs.appearance && typeof prefs.appearance === "object" && !Array.isArray(prefs.appearance) ? JSON.parse(JSON.stringify(prefs.appearance)) : undefined,
    chrome: prefs.chrome && typeof prefs.chrome === "object" && !Array.isArray(prefs.chrome) ? JSON.parse(JSON.stringify(prefs.chrome)) : undefined };
}

export function getStoryAppearancePresets(): StoryAppearancePreset[] {
  try {
    const saved = JSON.parse(kvGet(KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && item.prefs && typeof item.prefs === "object")
      .map(item => ({ ...item, prefs: copyStoryAppearancePrefs(item.prefs), css: typeof item.css === "string" ? item.css : "" }));
  } catch { return []; }
}

export function saveStoryAppearancePreset(name: string, prefs: StoryAppearancePrefs, css: string, id?: string): StoryAppearancePreset | null {
  const title = name.trim().slice(0, 60);
  if (!title) return null;
  const all = getStoryAppearancePresets(), previous = id ? all.find(item => item.id === id) : undefined;
  if (id && !previous) return null;
  const now = new Date().toISOString();
  const preset = { id: previous?.id || (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`), name: title, prefs: copyStoryAppearancePrefs(prefs), css,
    createdAt: previous?.createdAt || now, updatedAt: now };
  kvSet(KEY, JSON.stringify(previous ? all.map(item => item.id === id ? preset : item) : [...all, preset]));
  return preset;
}

export function renameStoryAppearancePreset(id: string, name: string): boolean {
  const preset = getStoryAppearancePresets().find(item => item.id === id);
  return !!preset && !!saveStoryAppearancePreset(name, preset.prefs, preset.css, id);
}

export function deleteStoryAppearancePreset(id: string): void {
  kvSet(KEY, JSON.stringify(getStoryAppearancePresets().filter(item => item.id !== id)));
}
