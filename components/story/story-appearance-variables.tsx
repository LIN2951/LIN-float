import { storyAppearanceStyle, type StoryAppearancePrefs } from "@/lib/story-appearance";

/** Stylesheet variables allow advanced CSS to override slider values without !important. */
export function StoryAppearanceVariables({ prefs, scope }: { prefs: StoryAppearancePrefs; scope: string }) {
  const declarations = Object.entries(storyAppearanceStyle(prefs)).map(([key, value]) => `${key}:${value}`).join(";");
  return declarations ? <style data-story-appearance-vars="">{`${scope}{${declarations}}`}</style> : null;
}
