// lib/music-free-source.ts — Client wrapper around the free music resolver.

import type { MusicTrack } from "./music-storage";

export interface FreePlayUrlResult {
    url: string | null;
    source?: string;
}

export interface FreeSearchResult {
    id: string;
    title: string;
    artist: string;
    server: string;
    pic?: string;
}

/** 从一个可播放结果解析直链（GD音乐：提供 server + id）。 */
export async function resolveFreeServerUrl(
    server: string,
    id: string,
    title: string,
    artist: string,
    bases?: string,
): Promise<string | null> {
    const params = new URLSearchParams({ action: "url", title, server, id });
    if (artist) params.set("artist", artist);
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

/** GD音乐：多平台免费搜索，返回可免费试听的结果。 */
export async function searchFreeMusic(
    keyword: string,
    bases?: string,
): Promise<FreeSearchResult[]> {
    const params = new URLSearchParams({ action: "search", s: keyword });
    if (bases && bases.trim()) params.set("bases", bases.trim());
    try {
        const resp = await fetch(`/api/music/free?${params.toString()}`);
        if (!resp.ok) return [];
        const data = (await resp.json()) as { list?: FreeSearchResult[] };
        return data.list || [];
    } catch {
        return [];
    }
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
