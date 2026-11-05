import type { CSSProperties } from "react";

export type StoryReadingPanelMode = "auto" | "show" | "hide";
export type StoryAppearanceMode = "combined" | "css-only";
export type StoryBubbleAppearance = {
  backgroundColor?: string;
  backgroundOpacity?: number;
  padding?: number;
  radius?: number;
  maxWidth?: number;
  bubblePosition?: "left" | "center" | "right";
  fontSize?: number;
  textColor?: string;
  dialogueColor?: string;
  boldColor?: string;
  italicColor?: string;
  lineHeight?: number;
  paragraphGap?: number;
  paragraphMode?: "default" | "indent" | "center" | "indent-center";
  showTimestamp?: boolean;
  avatarGap?: number;
  avatarSize?: number;
  avatarLayout?: "default" | "center" | "reverse";
  avatarShape?: "square" | "rounded" | "circle";
};
export type StoryAppearance = { user?: StoryBubbleAppearance; assistant?: StoryBubbleAppearance; messageGap?: number };
export type StoryChromeAppearance = {
  /** 两栏共用的背景不透明度，0–100；未配置时沿用原主题。 */
  barOpacity?: number;
  /** 仅按钮背景不透明度，不影响文字和图标。 */
  buttonOpacity?: number;
  controlsColor?: string;
  hideHeaderAvatar?: boolean;
};
export type StoryAppearancePrefs = { appearanceMode?: StoryAppearanceMode; chrome?: StoryChromeAppearance; theme?: string; wallpaper?: string; readingPanel?: StoryReadingPanelMode; appearance?: StoryAppearance };

export const isStoryBasicAppearanceEnabled = (prefs: StoryAppearancePrefs) => prefs.appearanceMode !== "css-only";

export function storyStageAppearanceClass(prefs: StoryAppearancePrefs) {
  return isStoryReadingPanelVisible(prefs) ? "" : isStoryBasicAppearanceEnabled(prefs) ? " story-free-layout" : " story-css-only-layout";
}

export const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

const numberInRange = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value)) * 100) / 100 : fallback;
const color = (value: unknown) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : undefined;

export function normalizeStoryBubbleAppearance(input?: StoryBubbleAppearance) {
  const value = input && typeof input === "object" ? input : {};
  return {
    backgroundColor: color(value.backgroundColor), backgroundOpacity: numberInRange(value.backgroundOpacity, 0, 0, 100),
    padding: numberInRange(value.padding, 12, 0, 32), radius: numberInRange(value.radius, 12, 0, 40), maxWidth: numberInRange(value.maxWidth, 100, 55, 100),
    bubblePosition: value.bubblePosition === "left" || value.bubblePosition === "right" ? value.bubblePosition : "center",
    fontSize: numberInRange(value.fontSize, 14, 10, 28), textColor: color(value.textColor), dialogueColor: color(value.dialogueColor), boldColor: color(value.boldColor), italicColor: color(value.italicColor),
    lineHeight: numberInRange(value.lineHeight, 1.78, 1.2, 2.6), paragraphGap: numberInRange(value.paragraphGap, 12, 0, 32),
    paragraphMode: value.paragraphMode === "indent" || value.paragraphMode === "center" || value.paragraphMode === "indent-center" ? value.paragraphMode : "default",
    showTimestamp: value.showTimestamp !== false,
    avatarGap: numberInRange(value.avatarGap, 10, 0, 64),
    avatarLayout: value.avatarLayout === "center" || value.avatarLayout === "reverse" ? value.avatarLayout : "default",
    avatarSize: numberInRange(value.avatarSize, 38, 20, 72),
    avatarShape: value.avatarShape === "circle" || value.avatarShape === "rounded" ? value.avatarShape : "square",
  };
}

export const normalizeStoryMessageGap = (value: unknown) => numberInRange(value, 24, 8, 64);

export function isStoryReadingPanelVisible(prefs: StoryAppearancePrefs): boolean {
  return prefs.readingPanel === "show" || (prefs.readingPanel !== "hide" && !prefs.wallpaper?.trim());
}

export function normalizeStoryChromeAppearance(input?: StoryChromeAppearance) {
  const value = input && typeof input === "object" ? input : {};
  return {
    barOpacity: numberInRange(value.barOpacity, 100, 0, 100),
    buttonOpacity: numberInRange(value.buttonOpacity, 100, 0, 100),
    controlsColor: color(value.controlsColor),
    hideHeaderAvatar: value.hideHeaderAvatar === true,
  };
}

export function storyChromeAttributes(prefs: StoryAppearancePrefs) {
  if (!isStoryBasicAppearanceEnabled(prefs)) return {};
  const chrome = normalizeStoryChromeAppearance(prefs.chrome);
  return {
    "data-story-bars-opacity": typeof prefs.chrome?.barOpacity === "number" ? "custom" : undefined,
    "data-story-controls-color": chrome.controlsColor ? "custom" : undefined,
    "data-story-controls-opacity": typeof prefs.chrome?.buttonOpacity === "number" ? "custom" : undefined,
    "data-story-header-avatar": chrome.hideHeaderAvatar ? "hidden" : undefined,
  };
}

export function storyMessageAppearanceAttributes(prefs: StoryAppearancePrefs, role: string) {
  return { "data-story-avatar-layout": isStoryBasicAppearanceEnabled(prefs) && (role === "user" || role === "assistant")
    ? normalizeStoryBubbleAppearance(prefs.appearance?.[role]).avatarLayout : undefined };
}

export function storyAppearanceStyle(prefs: StoryAppearancePrefs): CSSProperties {
  if (!isStoryBasicAppearanceEnabled(prefs)) return {};
  const style: Record<string, string | number> = { "--story-message-gap": `${normalizeStoryMessageGap(prefs.appearance?.messageGap)}px` };
  const chrome = normalizeStoryChromeAppearance(prefs.chrome);
  if (typeof prefs.chrome?.barOpacity === "number") {
    style["--story-header-background"] = `color-mix(in srgb, var(--c-story-bg-top, #ffffff) ${chrome.barOpacity}%, transparent)`;
    style["--story-footer-background"] = `color-mix(in srgb, var(--c-story-input-bar, #ffffff) ${chrome.barOpacity}%, transparent)`;
  }
  if (typeof prefs.chrome?.buttonOpacity === "number") style["--story-controls-background"] = `color-mix(in srgb, var(--c-story-bubble-bg, #ffffff) ${chrome.buttonOpacity}%, transparent)`;
  if (chrome.controlsColor) style["--story-controls-color"] = chrome.controlsColor;
  for (const role of ["user", "assistant"] as const) {
    const value = normalizeStoryBubbleAppearance(prefs.appearance?.[role]);
    const prefix = `--story-${role}-`;
    style[`${prefix}background`] = `color-mix(in srgb, ${value.backgroundColor || (role === "user" ? "var(--c-story-bubble-user, #f0f0f0)" : "var(--c-story-bubble-bg, #ffffff)")} ${value.backgroundOpacity}%, transparent)`;
    for (const key of ["padding", "radius", "fontSize", "paragraphGap", "avatarSize", "avatarGap"] as const) style[`${prefix}${key}`] = `${value[key]}px`;
    style[`${prefix}textAlign`] = value.paragraphMode === "center" || value.paragraphMode === "indent-center" ? "center" : "justify";
    style[`${prefix}textIndent`] = value.paragraphMode === "indent" || value.paragraphMode === "indent-center" ? "2em" : "0";
    style[`${prefix}timeDisplay`] = value.showTimestamp ? "inline" : "none";
    style[`${prefix}bubbleAlign`] = value.bubblePosition === "left" ? "flex-start" : value.bubblePosition === "right" ? "flex-end" : "center";
    style[`${prefix}maxWidth`] = `${value.maxWidth}%`;
    style[`${prefix}lineHeight`] = value.lineHeight;
    style[`${prefix}textColor`] = value.textColor || (role === "user" ? "var(--c-story-text-user, var(--c-story-text, #334155))" : "var(--c-story-text, #334155)");
    style[`${prefix}dialogueColor`] = value.dialogueColor || `var(${prefix}textColor)`;
    style[`${prefix}italicColor`] = value.italicColor || `var(${prefix}textColor)`;
    style[`${prefix}boldColor`] = value.boldColor || "var(--c-story-heading, #1e293b)";
    style[`${prefix}avatarRadius`] = value.avatarShape === "circle" ? "50%" : value.avatarShape === "rounded" ? "10px" : "0px";
  }
  return style as CSSProperties;
}
