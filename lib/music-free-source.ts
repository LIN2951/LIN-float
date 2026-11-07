// lib/music-free-source.ts — Client wrapper around the free music resolver.

import type { MusicTrack } from "./music-storage";

export interface FreePlayUrlResult {
    url: string | null;
    source?: string;
}

/**
 * Resolve a playable URL for the given track through the free aggregation
 * source. Keeps the same NetEase metadata/search results; only the actual
 * audio URL is fetched from a free multi-source endpoint.
 */
export async function getFreePlayUrl(
    track: Pick<MusicTrack, "id" | "title" | "artist">,
    bases?: string,
): Promise<string | null> {
    const nid = track.id.startsWith("netease_")
        ? track.id.slice("netease_".length)
        : "";
    const params = new URLSearchParams({ action: "url", title: track.title });
    if (track.artist) params.set("artist", track.artist);
    if (nid) params.set("id", nid);
    if (bases && bases.trim()) params.set("bases", bases.trim());

    try {
        const resp = await fetch(`/api/music/free?${params.toString()}`);
        if (!resp.ok) return null;
        const data = (await resp.json()) as FreePlayUrlResult;
        return data.url || null;
    } catch {
        return null;
    }
}
