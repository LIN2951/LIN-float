// lib/music-free-source.ts — Client wrapper around the free music resolver.

import type { MusicTrack } from "./music-storage";

export interface FreePlayUrlResult {
    url: string | null;
    source?: string;
}

// 免费源播放地址内存缓存：按 歌名+歌手 命中，二次播放秒出。
const freeUrlCache = new Map<string, string | null>();

/**
 * Resolve a playable URL for the given track through the free aggregation
 * source. Keeps the same NetEase metadata/search results; only the actual
 * audio URL is fetched from a free multi-source endpoint.
 */
export async function getFreePlayUrl(
    track: Pick<MusicTrack, "id" | "title" | "artist">,
    bases?: string,
): Promise<string | null> {
    const cacheKey = `${track.title}__${track.artist || ""}`;
    if (freeUrlCache.has(cacheKey)) return freeUrlCache.get(cacheKey) ?? null;
    const nid = track.id.startsWith("netease_")
        ? track.id.slice("netease_".length)
        : "";
    const params = new URLSearchParams({ action: "url", title: track.title });
    if (track.artist) params.set("artist", track.artist);
    if (nid) params.set("id", nid);
    if (bases && bases.trim()) params.set("bases", bases.trim());

    try {
        const resp = await fetch(`/api/music/free?${params.toString()}`);
        if (!resp.ok) { freeUrlCache.set(cacheKey, null); return null; }
        const data = (await resp.json()) as FreePlayUrlResult;
        const url = data.url || null;
        freeUrlCache.set(cacheKey, url);
        return url;
    } catch {
        freeUrlCache.set(cacheKey, null);
        return null;
    }
}
