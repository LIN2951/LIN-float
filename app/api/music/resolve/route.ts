// app/api/music/resolve/route.ts
// Server-side link metadata resolver for YouTube / DLsite / Reddit.
// Running on the server avoids browser CORS restrictions and lets us send
// realistic browser headers to sites that block fetch() from pages.

import { NextResponse } from "next/server";
import { detectPlatform, type LinkPlatform } from "@/lib/music-links";

export const runtime = "nodejs";
export const maxDuration = 10;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ResolvedTrackMeta {
    id: string;
    title: string;
    artist: string;
    album?: string;
    duration: number;
    coverUrl?: string;
    source: LinkPlatform;
    sourceUrl: string;
    externalId: string;
    sampleUrl?: string;
    streamUrl?: string;
    streamFallbackUrl?: string;
    workTags?: string[];
}

export interface ResolveResponse {
    ok: boolean;
    platform?: LinkPlatform;
    track?: ResolvedTrackMeta;
    playable: boolean;
    message?: string;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: ctrl.signal,
            headers: {
                "User-Agent": BROWSER_UA,
                "Accept-Language": "ja,zh-CN;q=0.9,zh;q=0.8,en;q=0.7",
                ...(init?.headers || {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function metaContent(html: string, attr: "property" | "name", key: string): string | null {
    const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]).trim();
    // attribute order reversed
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`, "i");
    const m2 = html.match(re2);
    return m2 ? decodeHtmlEntities(m2[1]).trim() : null;
}

function normalizeImage(url: string): string {
    if (!url) return "";
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) return ""; // caller decides base
    return url;
}

// ── YouTube ──

async function resolveYouTube(url: string, videoId: string): Promise<ResolveResponse> {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let title = `YouTube ${videoId}`;
    let artist = "YouTube";
    let coverUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    try {
        const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
        const res = await fetchWithTimeout(api);
        if (res.ok) {
            const data = await res.json() as { title?: string; author_name?: string; thumbnail_url?: string };
            if (data.title) title = data.title;
            if (data.author_name) artist = data.author_name;
            if (data.thumbnail_url) coverUrl = data.thumbnail_url.replace(/^http:\/\//, "https://");
        } else {
            throw new Error(`oembed ${res.status}`);
        }
    } catch {
        // YouTube oEmbed blocked in some networks — fall back to noembed mirror.
        try {
            const mirror = `https://noembed.com/embed?url=${encodeURIComponent(watchUrl)}`;
            const res = await fetchWithTimeout(mirror);
            if (res.ok) {
                const data = await res.json() as { title?: string; author_name?: string; thumbnail_url?: string; error?: string };
                if (!data.error) {
                    if (data.title) title = data.title;
                    if (data.author_name) artist = data.author_name;
                    if (data.thumbnail_url) coverUrl = data.thumbnail_url.replace(/^http:\/\//, "https://");
                }
            }
        } catch {
            // ids and thumbnail URL are still usable without either endpoint.
        }
    }

    return {
        ok: true,
        platform: "youtube",
        playable: true,
        track: {
            id: `yt_${videoId}`,
            title, artist,
            duration: 0,
            coverUrl,
            source: "youtube",
            sourceUrl: url,
            externalId: videoId,
        },
    };
}

// ── DLsite ──

function extractDlsiteSamples(html: string): string[] {
    const found = new Set<string>();
    // Absolute mp3 URLs (modern trial player assets live under /modpub/)
    for (const m of html.matchAll(/(?:https?:)?\/\/[^"'\s<>]+?\.mp3[^"'\s<>]*/gi)) {
        found.add(m[0].replace(/&amp;/g, "&"));
    }
    // Relative /modpub/...mp3 paths
    for (const m of html.matchAll(/["'(](\/modpub\/[^"'\s<>()]+\.mp3[^"'\s<>()]*)["')]/gi)) {
        found.add(`https://www.dlsite.com${m[1].replace(/&amp;/g, "&")}`);
    }
    // File names paired with work_space inside inline JSON
    for (const m of html.matchAll(/"work_space":\s*"([^"]+)"[^}]*?"(?:file|downloadFile|file_name)":\s*"([^"]+\.mp3)"/gi)) {
        const space = m[1].startsWith("http") ? m[1].replace(/\/$/, "") : `https://www.dlsite.com${m[1].replace(/\/$/, "")}`;
        found.add(`${space}/${m[2]}`);
    }
    return Array.from(found);
}

async function resolveDlsite(url: string, code: string): Promise<ResolveResponse> {
    const pageUrl = /dlsite\.com\/[^"']*product_id/.test(url)
        ? url
        : `https://www.dlsite.com/maniax/work/=/product_id/${code}.html`;

    let html = "";
    try {
        const res = await fetchWithTimeout(pageUrl, {
            headers: {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": "https://www.dlsite.com/",
            },
        });
        if (res.ok) html = await res.text();
    } catch {
        html = "";
    }

    // Fallback: public product info ajax endpoint
    if (!html || !html.includes("work_name")) {
        try {
            const ajaxUrl = `https://www.dlsite.com/maniax/product/info/ajax?product_id=${code}`;
            const res = await fetchWithTimeout(ajaxUrl, {
                headers: { "Accept": "application/json", "Referer": pageUrl },
            });
            if (res.ok) {
                const data = await res.json() as Record<string, {
                    work_name?: string; maker_name?: string; work_image?: string;
                    name_ja?: string; maker_name_ja?: string;
                }>;
                const info = data[code] || data[code.toLowerCase()];
                if (info) {
                    return {
                        ok: true,
                        platform: "dlsite",
                        playable: false,
                        message: "已识别 DLsite 作品，暂未找到试听音频，可上传购买的正版 MP3 绑定",
                        track: {
                            id: `dlsite_${code}`,
                            title: info.work_name || info.name_ja || code,
                            artist: info.maker_name || info.maker_name_ja || "DLsite 社团",
                            duration: 0,
                            coverUrl: info.work_image ? normalizeImage(info.work_image) : undefined,
                            source: "dlsite",
                            sourceUrl: pageUrl,
                            externalId: code,
                        },
                    };
                }
            }
        } catch {
            // fall through
        }
    }

    if (!html) {
        return {
            ok: false,
            platform: "dlsite",
            playable: false,
            message: "DLsite 页面获取失败（可能触发了地区限制），可稍后重试",
        };
    }

    // Title: prefer the dedicated h1, fall back to og:title with suffix cleanup
    let title = "";
    const h1Match = html.match(/<h1[^>]+id=["']work_name["'][^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) title = decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, "")).trim();
    if (!title) title = metaContent(html, "property", "og:title") || code;
    title = title
        .replace(/\s*[-–—]\s*DLsite.*$/i, "")
        .replace(/^(?:【[^】]*】)+/g, m => m) // keep sale badges visible? drop them for cleanliness
        .trim();
    // Drop leading sale badges for the stored title (they expire).
    title = title.replace(/^(?:【[^】]*】\s*)+/, "").trim() || title;

    // Circle / maker
    let artist = "";
    const makerMatch =
        html.match(/<a[^>]+href=["'][^"']*maker_id[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
        || html.match(/class=["'][^"']*maker_name[^"']*["'][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)
        || html.match(/itemprop=["']brand["'][^>]*>\s*(?:<a[^>]*>)?([^<]+)/i);
    if (makerMatch) artist = decodeHtmlEntities(makerMatch[1].replace(/<[^>]+>/g, "")).trim();
    if (!artist) {
        const kw = metaContent(html, "name", "keywords");
        if (kw) {
            const parts = kw.split(",").map(s => s.trim()).filter(Boolean);
            artist = parts[parts.length - 1] || "DLsite 社团";
        }
    }

    // Cover
    let coverUrl = metaContent(html, "property", "og:image") || "";
    coverUrl = normalizeImage(coverUrl);
    if (!coverUrl) {
        const imgMatch = html.match(/<img[^>]+id=["']?main_imgs?["']?[^>]+src=["']([^"']+)["']/i)
            || html.match(/class=["'][^"']*product_img[^"']*["'][^>]+src=["']([^"']+)["']/i);
        if (imgMatch) coverUrl = normalizeImage(decodeHtmlEntities(imgMatch[1]));
    }

    // Genre tags
    const workTags: string[] = [];
    const tagRe = /<a[^>]+href=["'][^"']*(?:\/genre\/|genre_id=)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(tagRe)) {
        const tag = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "")).trim();
        if (tag && tag.length <= 12 && !workTags.includes(tag)) workTags.push(tag);
        if (workTags.length >= 8) break;
    }

    // Trial audio
    const samples = extractDlsiteSamples(html);
    const sampleUrl = samples.find(u => /sample/i.test(u)) || samples[0] || "";
    const sampleCount = samples.length;

    return {
        ok: true,
        platform: "dlsite",
        playable: Boolean(sampleUrl),
        message: sampleUrl
            ? `已识别 DLsite 作品${sampleCount > 1 ? `，共 ${sampleCount} 个试听片段（播放第一个）` : "，可播放试听片段"}；上传购买的正版 MP3 可绑定完整版`
            : "已识别 DLsite 作品，该作品没有公开试听，可上传购买的正版 MP3 绑定",
        track: {
            id: `dlsite_${code}`,
            title,
            artist: artist || "DLsite 社团",
            duration: 0,
            coverUrl: coverUrl || undefined,
            source: "dlsite",
            sourceUrl: pageUrl,
            externalId: code,
            sampleUrl: sampleUrl || undefined,
            workTags: workTags.length ? workTags : undefined,
        },
    };
}

// ── Reddit ──

interface RedditPostData {
    title?: string;
    subreddit?: string;
    author?: string;
    permalink?: string;
    domain?: string;
    url?: string;
    is_video?: boolean;
    thumbnail?: string;
    preview?: { images?: Array<{ source?: { url?: string } }> };
    secure_media?: {
        reddit_video?: {
            fallback_url?: string;
            hls_url?: string;
            dash_url?: string;
            is_gif?: boolean;
            duration?: number;
        };
        oembed?: { title?: string; author_name?: string; thumbnail_url?: string };
        type?: string;
    } | null;
    media?: RedditPostData["secure_media"] | null;
    crosspost_parent_list?: RedditPostData[];
}

async function fetchRedditJson(jsonUrl: string): Promise<RedditPostData | null> {
    const res = await fetchWithTimeout(jsonUrl, {
        headers: {
            "Accept": "application/json",
            "User-Agent": "LIN-float-music/1.0 (+https://vercel.app; personal media resolver)",
        },
    });
    if (!res.ok) return null;
    const json = await res.json() as [{ data?: { children?: Array<{ data?: RedditPostData }> } }?, unknown?];
    return json?.[0]?.data?.children?.[0]?.data || null;
}

async function resolveReddit(url: string, postId: string): Promise<ResolveResponse> {
    // Bare v.redd.it link: no metadata endpoint exists for the media token.
    if (url.includes("v.redd.it/") && !url.includes("reddit.com")) {
        const direct = /\.mp4(\?|$)/i.test(url) ? url : "";
        return {
            ok: Boolean(direct),
            platform: "reddit",
            playable: Boolean(direct),
            message: direct
                ? "已识别 Reddit 视频直链"
                : "v.redd.it 媒体链接缺少帖子信息，请粘贴帖子链接（reddit.com/r/.../comments/...）",
            track: direct ? {
                id: `reddit_${postId}`,
                title: `Reddit 视频 ${postId}`,
                artist: "Reddit",
                duration: 0,
                source: "reddit",
                sourceUrl: url,
                externalId: postId,
                streamUrl: direct,
            } : undefined,
        };
    }

    let post: RedditPostData | null = null;
    const candidates = [
        `https://www.reddit.com/comments/${postId}.json?raw_json=1&limit=1`,
        `https://old.reddit.com/comments/${postId}.json?raw_json=1&limit=1`,
    ];
    for (const candidate of candidates) {
        try {
            post = await fetchRedditJson(candidate);
        } catch {
            post = null;
        }
        if (post) break;
    }

    if (!post) {
        return {
            ok: false,
            platform: "reddit",
            playable: false,
            message: "Reddit 帖子获取失败（可能被地区/反爬限制），可稍后重试",
        };
    }

    // Unwrap crossposts for media lookup
    const media = post.secure_media || post.media
        || post.crosspost_parent_list?.[0]?.secure_media
        || post.crosspost_parent_list?.[0]?.media;
    const rv = media?.reddit_video;

    // Post links out to YouTube — resolve as YouTube instead.
    const linkedUrl = post.url || "";
    if (!rv && /(?:youtube\.com|youtu\.be)/i.test(linkedUrl)) {
        const yt = detectPlatform(linkedUrl);
        if (yt) {
            const r = await resolveYouTube(yt.canonicalUrl, yt.externalId);
            if (r.track) {
                r.track.artist = post.author ? `u/${post.author}` : r.track.artist;
                r.message = `来自 Reddit r/${post.subreddit || "??"} 的 YouTube 链接`;
            }
            return r;
        }
    }

    const cover =
        post.preview?.images?.[0]?.source?.url
        || (post.thumbnail && post.thumbnail.startsWith("http") ? post.thumbnail : "")
        || media?.oembed?.thumbnail_url
        || "";

    if (rv) {
        if (rv.is_gif) {
            return {
                ok: true, platform: "reddit", playable: false,
                message: "该 Reddit 帖子是无声 GIF 视频，没有音轨",
                track: {
                    id: `reddit_${postId}`,
                    title: post.title || `Reddit ${postId}`,
                    artist: post.subreddit ? `r/${post.subreddit}` : "Reddit",
                    duration: rv.duration || 0,
                    coverUrl: cover || undefined,
                    source: "reddit", sourceUrl: url, externalId: postId,
                },
            };
        }
        // v.redd.it muxes video/audio in separate DASH streams. Derive the
        // standalone audio track URL, keep the muxed fallback as backup.
        const fallback = (rv.fallback_url || "").split("?")[0];
        const base = fallback.replace(/\/DASH_[^/]+\.mp4$/i, "");
        const audioGuess = base ? `${base}/DASH_audio.mp4` : "";
        return {
            ok: true, platform: "reddit", playable: true,
            message: "已识别 Reddit 视频，正在尝试播放其音轨",
            track: {
                id: `reddit_${postId}`,
                title: post.title || `Reddit ${postId}`,
                artist: post.subreddit ? `r/${post.subreddit}` : "Reddit",
                duration: rv.duration || 0,
                coverUrl: cover || undefined,
                source: "reddit",
                sourceUrl: `https://www.reddit.com${post.permalink || `/comments/${postId}`}`,
                externalId: postId,
                streamUrl: audioGuess || undefined,
                streamFallbackUrl: fallback || undefined,
            },
        };
    }

    // No embedded video — keep metadata, let the client show guidance.
    return {
        ok: true, platform: "reddit", playable: false,
        message: "该 Reddit 帖子没有可直接播放的音视频（可能是图文/外链帖）",
        track: {
            id: `reddit_${postId}`,
            title: post.title || `Reddit ${postId}`,
            artist: post.subreddit ? `r/${post.subreddit}` : "Reddit",
            duration: 0,
            coverUrl: cover || undefined,
            source: "reddit",
            sourceUrl: `https://www.reddit.com${post.permalink || `/comments/${postId}`}`,
            externalId: postId,
        },
    };
}

export async function GET(req: Request) {
    const rawUrl = new URL(req.url).searchParams.get("url") || "";
    const parsed = detectPlatform(rawUrl);

    if (!parsed) {
        return NextResponse.json<ResolveResponse>({
            ok: false, playable: false,
            message: "无法识别该链接，目前支持 YouTube、DLsite、Reddit 链接",
        }, { status: 400 });
    }

    try {
        let result: ResolveResponse;
        switch (parsed.platform) {
            case "youtube":
                result = await resolveYouTube(parsed.canonicalUrl, parsed.externalId);
                break;
            case "dlsite":
                result = await resolveDlsite(parsed.canonicalUrl, parsed.externalId);
                break;
            case "reddit":
                result = await resolveReddit(parsed.canonicalUrl, parsed.externalId);
                break;
        }
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (err) {
        return NextResponse.json<ResolveResponse>({
            ok: false,
            platform: parsed.platform,
            playable: false,
            message: `解析失败：${err instanceof Error ? err.message : "未知错误"}`,
        }, { status: 502 });
    }
}
