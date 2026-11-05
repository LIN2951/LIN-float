import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { MomentPost } from "./moments-types";

const KEY = "ai_phone_character_moments_profiles_v1";
registerKvMigration(KEY);
export const CHARACTER_MOMENTS_PROFILE_UPDATED = "character-moments-profile-updated";
export type CharacterMomentsProfile = { coverAssetId?: string; signature?: string };

function loadProfiles(): Record<string, CharacterMomentsProfile> {
  try {
    const value = JSON.parse(kvGet(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function loadCharacterMomentsProfile(characterId: string): CharacterMomentsProfile {
  const value = loadProfiles()[characterId];
  return { coverAssetId: typeof value?.coverAssetId === "string" ? value.coverAssetId : undefined,
    signature: typeof value?.signature === "string" ? value.signature : undefined };
}

export function saveCharacterMomentsProfile(characterId: string, patch: CharacterMomentsProfile): void {
  if (!characterId) return;
  const profiles = loadProfiles();
  kvSet(KEY, JSON.stringify({ ...profiles, [characterId]: { ...loadCharacterMomentsProfile(characterId), ...patch } }));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHARACTER_MOMENTS_PROFILE_UPDATED, { detail: { characterId } }));
}

export function getCharacterMomentPosts(posts: MomentPost[], characterId: string): MomentPost[] {
  return posts.filter(post => post.authorType === "character" && post.authorId === characterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
