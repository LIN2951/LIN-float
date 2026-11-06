// app/api/music/free/route.ts
// Free music source: resolve a playable song URL through Meting-compatible
// aggregation APIs. Runs server-side to avoid browser CORS and lets us verify
// the resolved link is real audio (not a 404 / trial page).
//
// Endpoint: GET /api/music/free?action=url&id=<neteaseId>&title=<...>&artist=<...>&bases=<...>
// Returns: { url: string | null, source?: string }

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 15;

// Public Meting-compatible instances. The default one only supports the
// netease server; users can add their own multi-source instance (Meting /
// inmeting / UNM) via the `bases` query param for full VIP support.
const DEFAULT_BASES = [
    "https://met.api.xiaoguan.fit/api",
];

const FALLBACK_SERVERS = ["netease", "kugou", "kuwo", "tencent", "baidu"];

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function parseBases(raw: string | null): string[] {
    if (!raw) return DEFAULT_BASES;
    const list = raw
        .split(/[,;\n]/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => (s.endsWith("/") ? s.slice(0, -1) : s));
    return list.length ? list : DEFAULT_BASES;
}

async function fetchText(url: string, timeoutMs = 6000): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { "User-Agent": BROWSER_UA, "Accept": "*/*" },
        });
        return await res.text();
    } catch {
        return "";
    } finally {
        clearTimeout(t);
    }
}

/** True when the response actually serves audio (not a 404 / HTML page). */
async function isPlayableAudio(url: string): Promise<boolean> {
    if (!url) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch(url, {
            method: "HEAD",
            signal: ctrl.signal,
            headers: { "User-Agent": BROWSER_UA },
        });
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.startsWith("audio/")) return true;
        if (ct.includes("mpeg") || ct.includes("mp4") || ct.includes("ogg")) return true;
        // Some CDNs return octet-stream for audio files.
        if (ct.includes("octet-stream")) return true;
        return false;
    } catch {
        return false;
    } finally {
        clearTimeout(t);
    }
}

/**
 * Resolve a URL from a Meting-compatible endpoint. The endpoint may respond
 * with either a 302 redirect to the audio file or a JSON body `{ url }`.
 */
async function metingUrl(base: string, server: string, id: string): Promise<string | null> {
    const endpoint = `${base}?server=${encodeURIComponent(server)}&type=url&id=${encodeURIComponent(id)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch(endpoint, {
            redirect: "follow",
            signal: ctrl.signal,
            headers: { "User-Agent": BROWSER_UA, "Accept": "*/*" },
        });
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        // Direct redirect to audio.
        if (ct.startsWith("audio/") || ct.includes("mpeg") || ct.includes("octet-stream")) {
            return res.url;
        }
        // JSON body.
        if (ct.includes("json")) {
            const data = await res.json() as { url?: string } | null;
            if (data?.url) return data.url;
        }
        return null;
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

interface MetingSearchItem {
    title?: string;
    author?: string;
    url?: string;
    id?: string;
}

async function metingSearch(base: string, server: string, keyword: string): Promise<MetingSearchItem[]> {
    const endpoint = `${base}?server=${encodeURIComponent(server)}&type=search&s=${encodeURIComponent(keyword)}`;
    const text = await fetchText(endpoint, 7000);
    if (!text) return [];
    try {
        const data = JSON.parse(text) as { status?: number; data?: unknown };
        const arr = Array.isArray(data) ? data : data.data;
        if (!Array.isArray(arr)) return [];
        return arr.slice(0, 8) as MetingSearchItem[];
    } catch {
        return [];
    }
}

function similarityScore(a: string, b: string): number {
    const sa = a.toLowerCase().replace(/\s+/g, "");
    const sb = b.toLowerCase().replace(/\s+/g, "");
    if (!sa || !sb) return 0;
    if (sa === sb) return 1;
    let common = 0;
    for (const ch of new Set(sa)) {
        if (sb.includes(ch)) common++;
    }
    return common / Math.max(sa.length, sb.length);
}

function pickBestMatch(items: MetingSearchItem[], title: string, artist: string): MetingSearchItem | null {
    let best: MetingSearchItem | null = null;
    let bestScore = 0;
    for (const it of items) {
        const t = it.title || "";
        const a = it.author || "";
        const score = similarityScore(t, title) + (artist ? similarityScore(a, artist) * 0.4 : 0);
        if (score > bestScore) {
            bestScore = score;
            best = it;
        }
    }
    return best;
}

export async function GET(req: Request) {
    const params = new URL(req.url).searchParams;
    const action = params.get("action") || "url";
    const id = params.get("id") || "";
    const title = params.get("title") || "";
    const artist = params.get("artist") || "";
    const bases = parseBases(params.get("bases"));

    if (action !== "url") {
        return NextResponse.json({ url: null }, { status: 400 });
    }

    // 1) Try netease by id first (best metadata, but VIP songs 404).
    if (id) {
        for (const base of bases) {
            const url = await metingUrl(base, "netease", id);
            if (url && await isPlayableAudio(url)) {
                return NextResponse.json({ url, source: "netease" });
            }
        }
    }

    // 2) Fall back: search title+artist across other servers and resolve.
    const keyword = artist ? `${title} ${artist}` : title;
    if (keyword.trim()) {
        for (const server of FALLBACK_SERVERS) {
            for (const base of bases) {
                const items = await metingSearch(base, server, keyword);
                const best = pickBestMatch(items, title, artist);
                if (!best) continue;
                // Search results include a direct `url` field pointing at the
                // meting url endpoint; resolve it and verify.
                const targetId = best.id || "";
                let url: string | null = null;
                if (targetId) url = await metingUrl(base, server, targetId);
                if (url && await isPlayableAudio(url)) {
                    return NextResponse.json({ url, source: server });
                }
            }
        }
    }

    return NextResponse.json({ url: null });
}
