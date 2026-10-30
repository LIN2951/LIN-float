// app/api/music/captions/route.ts
// YouTube caption proxy: scrapes the caption track list from a watch page
// and returns timed text converted to LRC. Runs server-side to avoid CORS
// and to attach realistic browser headers.

import { NextResponse } from "next/server";
import { json3ToLrc } from "@/lib/music-links";

export const runtime = "nodejs";
export const maxDuration = 10;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface CaptionTrackInfo {
    lang: string;
    label: string;
    kind: "asr" | "manual";
    baseUrl: string;
}

export interface CaptionsResponse {
    ok: boolean;
    videoId: string;
    tracks?: CaptionTrackInfo[];
    lang?: string;
    lrc?: string;
    message?: string;
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                "User-Agent": BROWSER_UA,
                "Accept-Language": "ja,zh-CN;q=0.9,zh;q=0.8,en;q=0.7",
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

/** Extract the captionTracks array JSON substring from watch-page HTML. */
function extractCaptionTracks(html: string): CaptionTrackInfo[] {
    const key = '"captionTracks"';
    const idx = html.indexOf(key);
    if (idx < 0) return [];
    const arrStart = html.indexOf("[", idx);
    if (arrStart < 0) return [];

    // Bracket scan respecting strings/escapes
    let depth = 0;
    for (let i = arrStart; i < html.length; i++) {
        const ch = html[i];
        if (ch === "[") depth++;
        else if (ch === "]") {
            depth--;
            if (depth === 0) {
                const json = html.slice(arrStart, i + 1);
                try {
                    const raw = JSON.parse(json) as Array<{
                        baseUrl?: string;
                        languageCode?: string;
                        kind?: string;
                        name?: { simpleText?: string; runs?: Array<{ text?: string }> };
                        vssId?: string;
                    }>;
                    return raw
                        .filter(t => t.baseUrl && t.languageCode)
                        .map(t => ({
                            lang: t.languageCode!,
                            label: t.name?.simpleText
                                || t.name?.runs?.map(r => r.text || "").join("")
                                || t.languageCode!,
                            kind: (t.kind === "asr" || (t.vssId || "").startsWith("a.")) ? "asr" as const : "manual" as const,
                            baseUrl: t.baseUrl!,
                        }));
                } catch {
                    return [];
                }
            }
        }
    }
    return [];
}

/** Pick a sensible default: requested lang → Japanese → English → first. */
function pickTrack(tracks: CaptionTrackInfo[], preferred?: string): CaptionTrackInfo | null {
    if (tracks.length === 0) return null;
    const want = (preferred || "").toLowerCase();
    if (want) {
        const exact = tracks.find(t => t.lang.toLowerCase() === want);
        if (exact) return exact;
        const prefix = tracks.find(t => t.lang.toLowerCase().startsWith(want.split("-")[0]));
        if (prefix) return prefix;
    }
    const byLang = (code: string) =>
        tracks.find(t => t.lang.toLowerCase().startsWith(code) && t.kind === "manual")
        || tracks.find(t => t.lang.toLowerCase().startsWith(code));
    return byLang("ja") || byLang("en") || tracks.find(t => t.kind === "manual") || tracks[0];
}

async function fetchTrackAsLrc(baseUrl: string): Promise<string> {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}fmt=json3`;
    const text = await fetchText(url);
    return json3ToLrc(JSON.parse(text));
}

export async function GET(req: Request) {
    const params = new URL(req.url).searchParams;
    const videoId = (params.get("videoId") || "").trim();
    const wantedLang = (params.get("lang") || "").trim();
    const listOnly = params.get("list") === "1";

    if (!/^[\w-]{6,}$/.test(videoId)) {
        return NextResponse.json<CaptionsResponse>({
            ok: false, videoId, message: "缺少有效的 videoId",
        }, { status: 400 });
    }

    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
        + "&hl=ja&gl=JP&bpctr=9999999999&has_verified=1&ucbcb=1";

    let html: string;
    try {
        html = await fetchText(watchUrl);
    } catch (err) {
        return NextResponse.json<CaptionsResponse>({
            ok: false, videoId,
            message: `YouTube 页面获取失败：${err instanceof Error ? err.message : "网络错误"}`,
        }, { status: 502 });
    }

    const tracks = extractCaptionTracks(html);
    if (tracks.length === 0) {
        return NextResponse.json<CaptionsResponse>({
            ok: false, videoId,
            tracks: [],
            message: "没有找到字幕轨（该视频可能关闭了字幕，或触发了地区/同意页限制）",
        });
    }

    if (listOnly) {
        return NextResponse.json<CaptionsResponse>({
            ok: true, videoId,
            tracks: tracks.map(t => ({ ...t, baseUrl: "" })),
        }, { headers: { "Cache-Control": "no-store" } });
    }

    const chosen = pickTrack(tracks, wantedLang);
    if (!chosen) {
        return NextResponse.json<CaptionsResponse>({
            ok: false, videoId,
            tracks: tracks.map(t => ({ ...t, baseUrl: "" })),
            message: "所选语言的字幕不可用",
        });
    }

    try {
        const lrc = await fetchTrackAsLrc(chosen.baseUrl);
        if (!lrc) throw new Error("字幕内容为空");
        return NextResponse.json<CaptionsResponse>({
            ok: true, videoId,
            tracks: tracks.map(t => ({ ...t, baseUrl: "" })),
            lang: chosen.lang,
            lrc,
        }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
        return NextResponse.json<CaptionsResponse>({
            ok: false, videoId,
            tracks: tracks.map(t => ({ ...t, baseUrl: "" })),
            message: `字幕下载失败：${err instanceof Error ? err.message : "网络错误"}`,
        }, { status: 502 });
    }
}
