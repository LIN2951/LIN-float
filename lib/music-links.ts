// lib/music-links.ts — Link platform detection (YouTube / DLsite / Reddit)
// and subtitle format conversion (SRT / VTT → LRC). Pure module, safe to
// import from both client components and server route handlers.

export type LinkPlatform = "youtube" | "dlsite" | "reddit";

export interface ParsedLink {
    platform: LinkPlatform;
    originalUrl: string;
    /** Platform-native id: YouTube videoId / RJ work code / Reddit post id */
    externalId: string;
    /** MusicTrack id convention, matching the `netease_` prefix routing */
    trackId: string;
    /** Canonical URL to store / re-fetch */
    canonicalUrl: string;
}

export const PLATFORM_LABELS: Record<LinkPlatform, string> = {
    youtube: "YouTube",
    dlsite: "DLsite",
    reddit: "Reddit",
};

// ── YouTube ──

const YT_ID_RE = /^[\w-]{11}$/;

function parseYouTube(rawUrl: string, u: URL): ParsedLink | null {
    let id = "";
    const host = u.hostname.toLowerCase();

    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
        id = u.pathname.slice(1).split("/")[0];
    } else if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
        const v = u.searchParams.get("v");
        if (v) {
            id = v;
        } else {
            const parts = u.pathname.split("/").filter(Boolean);
            // /shorts/<id>, /embed/<id>, /v/<id>, /live/<id>, /music/...
            const keyIdx = parts.findIndex(p => ["shorts", "embed", "v", "live"].includes(p));
            if (keyIdx >= 0 && parts[keyIdx + 1]) id = parts[keyIdx + 1];
        }
    }

    if (!id || !YT_ID_RE.test(id)) return null;
    return {
        platform: "youtube",
        originalUrl: rawUrl,
        externalId: id,
        trackId: `yt_${id}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    };
}

// ── DLsite ──

// RJ = maniax (doujin), RE = rental/eng, BJ = books, VJ = comic pro
const DLSITE_CODE_RE = /\b((?:RJ|RE|BJ|VJ)\d{5,8})\b/i;

function parseDlsite(rawUrl: string, u: URL): ParsedLink | null {
    if (!u.hostname.toLowerCase().includes("dlsite.com")) return null;

    let code = "";
    const byParam = u.searchParams.get("product_id");
    if (byParam) {
        code = byParam.toUpperCase();
    } else {
        const m = u.pathname.match(DLSITE_CODE_RE) || u.search.match(DLSITE_CODE_RE);
        if (m) code = m[1].toUpperCase();
    }
    if (!code) return null;

    // Canonical maniax work page; keeps any locale the user originally had.
    const locale = u.searchParams.get("locale");
    const canonicalUrl = `https://www.dlsite.com/maniax/work/=/product_id/${code}.html`
        + (locale ? `?locale=${encodeURIComponent(locale)}` : "");

    return {
        platform: "dlsite",
        originalUrl: rawUrl,
        externalId: code,
        trackId: `dlsite_${code}`,
        canonicalUrl,
    };
}

// ── Reddit ──

function parseReddit(rawUrl: string, u: URL): ParsedLink | null {
    const host = u.hostname.toLowerCase();
    let postId = "";

    if (host.endsWith("redd.it")) {
        if (host === "v.redd.it") {
            // Bare media link — metadata is limited, resolve endpoint probes it.
            postId = u.pathname.slice(1).split("/")[0];
        } else {
            // redd.it/<postId> share link
            postId = u.pathname.slice(1).split("/")[0];
        }
    } else if (host.includes("reddit.com")) {
        const parts = u.pathname.split("/").filter(Boolean);
        const cIdx = parts.findIndex(p => p === "comments");
        if (cIdx >= 0 && parts[cIdx + 1]) {
            postId = parts[cIdx + 1];
        } else if (parts[0] && /^[a-z0-9]+$/i.test(parts[0]) && parts.length === 1) {
            // https://reddit.com/<postId>
            postId = parts[0];
        }
    }

    if (!postId) return null;
    return {
        platform: "reddit",
        originalUrl: rawUrl,
        externalId: postId,
        trackId: `reddit_${postId}`,
        canonicalUrl: postId.startsWith("http") ? rawUrl : `https://www.reddit.com/comments/${postId}`,
    };
}

/** Detect whether a clipboard string is a supported link. */
export function detectPlatform(input: string): ParsedLink | null {
    if (!input) return null;
    const rawUrl = input.trim().split(/\s+/)[0]?.trim();
    if (!rawUrl) return null;

    let u: URL;
    try {
        u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    } catch {
        return null;
    }

    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com") || host.includes("youtu.be") || host.includes("youtube-nocookie.com")) {
        return parseYouTube(rawUrl, u);
    }
    if (host.includes("dlsite.com")) {
        return parseDlsite(rawUrl, u);
    }
    if (host.includes("reddit.com") || host.endsWith("redd.it")) {
        return parseReddit(rawUrl, u);
    }
    return null;
}

// ── Subtitle / caption conversion ──

function pad2(n: number): string {
    return n.toString().padStart(2, "0");
}

/** Convert millisecond timestamp to an LRC tag `[mm:ss.xx]` */
export function msToLrcTime(ms: number): string {
    const total = Math.max(0, ms);
    const mins = Math.floor(total / 60000);
    const secs = Math.floor((total % 60000) / 1000);
    const hundredths = Math.floor((total % 1000) / 10);
    return `[${pad2(mins)}:${pad2(secs)}.${pad2(hundredths)}]`;
}

function secondsToLrcTime(h: number, m: number, s: number, frac: string): string {
    const cs = Math.round(parseFloat(`0.${frac || "0"}`) * 100);
    return msToLrcTime(((h * 60 + m) * 60 + s) * 1000 + cs * 10);
}

function decodeCaptionText(text: string): string {
    return text
        .replace(/<[^>]+>/g, "")          // strip <i>, <font>, <c> tags
        .replace(/\{\\[^}]+\}/g, "")      // ASS override blocks
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

/** SRT text → LRC. Input e.g. `00:00:01,000 --> 00:00:03,000\nこんにちは` */
export function srtToLrc(input: string): string {
    const blocks = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n{2,}/);
    const out: string[] = [];
    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        // First line may be a numeric cue index.
        const timeLine = /^\d+$/.test(lines[0]) ? lines[1] : lines[0];
        const textStart = /^\d+$/.test(lines[0]) ? 2 : 1;
        if (!timeLine || !timeLine.includes("-->")) continue;
        const m = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) continue;
        const text = decodeCaptionText(lines.slice(textStart).join(" "));
        if (text) out.push(`${secondsToLrcTime(+m[1], +m[2], +m[3], m[4])}${text}`);
    }
    return out.join("\n");
}

/** WebVTT text → LRC (skips NOTE/STYLE blocks and cue settings). */
export function vttToLrc(input: string): string {
    const cleaned = input
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        // Drop NOTE / STYLE header blocks.
        .replace(/^(?:NOTE|STYLE)[\s\S]*?(?=\n\n|\n?\d{1,2}:\d{2}|\s*$)/gm, "");
    const blocks = cleaned.split(/\n{2,}/);
    const out: string[] = [];
    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        const idx = lines.findIndex(l => l.includes("-->"));
        if (idx < 0) continue;
        const timeLine = lines[idx];
        const m = timeLine.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
        if (!m) continue;
        const text = decodeCaptionText(lines.slice(idx + 1).join(" "));
        if (text) {
            out.push(secondsToLrcTime(+(m[1] || 0), +m[2], +m[3], m[4]) + text);
        }
    }
    return out.join("\n");
}

/**
 * Convert YouTube timedtext json3 payload to LRC.
 * Shape: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 */
export function json3ToLrc(data: unknown): string {
    const events = (data as { events?: Array<{
        tStartMs?: number | string;
        segs?: Array<{ utf8?: string }>;
    }> })?.events;
    if (!Array.isArray(events)) return "";
    const out: string[] = [];
    for (const ev of events) {
        if (typeof ev.tStartMs !== "number") continue;
        const raw = (ev.segs || []).map(s => s.utf8 || "").join("");
        const text = decodeCaptionText(raw);
        if (!text) continue;
        out.push(`${msToLrcTime(ev.tStartMs)}${text}`);
    }
    return out.join("\n");
}

/**
 * Normalize arbitrary pasted/imported subtitle text into LRC.
 * Returns "" for empty input. Plain text (no timing) is returned as-is so
 * the player can still show it without a timeline.
 */
export function normalizeSubtitleToLrc(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    if (/^\s*WEBVTT/m.test(trimmed) || /-->[\s\d:.,-]/.test(trimmed.split("\n").slice(0, 8).join("\n"))) {
        // VTT has hours-or-minutes-first ambiguity; srt converter handles both,
        // but WEBVTT cue blocks parse better with the VTT path.
        const lrc = /^\s*WEBVTT/m.test(trimmed) ? vttToLrc(trimmed) : srtToLrc(trimmed);
        return lrc || trimmed;
    }
    if (trimmed.includes("-->")) {
        const lrc = srtToLrc(trimmed);
        return lrc || trimmed;
    }
    return trimmed; // already LRC or plain text
}
