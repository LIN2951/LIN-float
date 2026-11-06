// lib/watch-link.ts — 「一起看」视频链接解析（客户端 / 服务端共用，无环境依赖）

export type WatchSource = "bilibili" | "youtube" | "bangumi" | "direct";

export type WatchLinkParse =
    | { kind: "bilibili"; bvid?: string; aid?: string; page?: number }
    | { kind: "bilibili-short"; url: string }
    | { kind: "youtube"; videoId: string }
    | { kind: "bangumi"; subjectId: string }
    | { kind: "direct"; url: string };

const BV_RE = /BV1[0-9A-Za-z]{9}/i;
const AV_RE = /av(\d{1,10})/i;
const BANGUMI_SUBJECT_RE = /(?:subject\/|^|[^\d])(\d{2,9})/;
const DIRECT_VIDEO_RE = /\.(mp4|webm|ogg|ogv|mov)(\?|#|$)/i;

/** 从一段可能夹杂文字的输入里抽出第一个 http(s) 链接 */
export function extractFirstUrl(raw: string): string | null {
    const match = raw.match(/https?:\/\/[^\s<>"'）)】\]]+/i);
    return match ? match[0] : null;
}

export function parseWatchLink(rawInput: string): WatchLinkParse | null {
    const raw = rawInput.trim();
    if (!raw) return null;

    // animeko（open-ani）分享：自定义 scheme 或网页链接，内部通常带 bangumi 条目信息
    if (/^animeko:/i.test(raw)) {
        const inner = extractFirstUrl(raw);
        if (inner) return parseWatchLink(inner);
        const digits = raw.match(/(\d{2,9})/);
        if (digits) return { kind: "bangumi", subjectId: digits[1] };
        return null;
    }

    const url = extractFirstUrl(raw);
    if (!url) return null;

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const host = parsed.hostname.toLowerCase();

    // B 站
    if (host === "b23.tv" || host.endsWith(".b23.tv")) {
        const bv = url.match(BV_RE);
        if (bv) return { kind: "bilibili", bvid: bv[0] };
        return { kind: "bilibili-short", url };
    }
    if (host === "www.bilibili.com" || host.endsWith(".bilibili.com") || host === "bilibili.com") {
        const bv = url.match(BV_RE);
        const page = parsed.searchParams.get("p");
        const pageNum = page && /^\d+$/.test(page) ? Math.max(1, parseInt(page, 10)) : undefined;
        if (bv) return { kind: "bilibili", bvid: bv[0], page: pageNum };
        const av = url.match(AV_RE);
        if (av) return { kind: "bilibili", aid: av[1], page: pageNum };
        return null;
    }

    // YouTube
    if (host === "youtu.be") {
        const id = parsed.pathname.replace(/^\//, "").split("/")[0];
        if (id) return { kind: "youtube", videoId: id };
        return null;
    }
    if (host === "www.youtube.com" || host.endsWith(".youtube.com") || host === "youtube.com" || host.endsWith(".youtube-nocookie.com")) {
        const v = parsed.searchParams.get("v");
        if (v) return { kind: "youtube", videoId: v };
        const m = parsed.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/);
        if (m) return { kind: "youtube", videoId: m[2] };
        return null;
    }

    // Bangumi（animeko / open-ani 的番剧数据源）
    if (host === "bangumi.tv" || host.endsWith(".bangumi.tv") || host === "bgm.tv" || host.endsWith(".bgm.tv") || host === "chii.in") {
        const m = parsed.pathname.match(/\/subject\/(\d+)/) || url.match(BANGUMI_SUBJECT_RE);
        if (m) return { kind: "bangumi", subjectId: m[1] };
        return null;
    }
    if (host.includes("animeko") || host.includes("openani") || host.includes("open-ani")) {
        const digits = url.match(/(\d{2,9})/);
        if (digits) return { kind: "bangumi", subjectId: digits[1] };
        return null;
    }

    // 直链视频
    if (DIRECT_VIDEO_RE.test(parsed.pathname)) {
        return { kind: "direct", url };
    }

    return null;
}

export function buildBilibiliEmbed(bvid: string | undefined, aid: string | undefined, page = 1): string {
    const params = new URLSearchParams({
        autoplay: "0",
        muted: "0",
        high_quality: "1",
        danmaku: "0",
        page: String(Math.max(1, page)),
    });
    if (bvid) params.set("bvid", bvid);
    else if (aid) params.set("aid", aid);
    return `https://player.bilibili.com/player.html?${params.toString()}`;
}

export function buildYoutubeEmbed(videoId: string): string {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0`;
}

export const WATCH_SOURCE_LABEL: Record<WatchSource, string> = {
    bilibili: "哔哩哔哩",
    youtube: "YouTube",
    bangumi: "番剧",
    direct: "直链",
};
