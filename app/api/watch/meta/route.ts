// app/api/watch/meta/route.ts
// 「一起看」视频元数据解析：B 站 / YouTube / Bangumi（animeko）/ 直链。
// 服务端抓取，避开浏览器 CORS；只返回标题、简介、封面、可嵌入播放地址。
//
// Endpoint: GET /api/watch/meta?url=<video url>

import { NextResponse } from "next/server";
import { buildBilibiliEmbed, buildYoutubeEmbed, parseWatchLink } from "@/lib/watch-link";

export const runtime = "nodejs";
export const maxDuration = 20;

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BANGUMI_UA = "float-phone/watch-together (https://github.com/LIN2951/LIN-float)";

type MetaResult = {
    ok: boolean;
    source?: "bilibili" | "youtube" | "bangumi" | "direct";
    title?: string;
    desc?: string;
    cover?: string;
    owner?: string;
    embedUrl?: string;
    directUrl?: string;
    error?: string;
};

async function fetchJson<T>(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function resolveBilibiliShort(url: string): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "User-Agent": BROWSER_UA }, signal: ctrl.signal });
        const location = res.headers.get("location");
        return location || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

type BiliViewData = {
    title?: string;
    desc?: string;
    pic?: string;
    bvid?: string;
    aid?: number;
    owner?: { name?: string };
    duration?: number;
};

async function fetchBilibiliMeta(bvid?: string, aid?: string, page = 1): Promise<MetaResult> {
    const api = bvid
        ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
        : `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid || "")}`;
    const data = await fetchJson<{ code?: number; data?: BiliViewData }>(api, {
        "User-Agent": BROWSER_UA,
        "Referer": "https://www.bilibili.com/",
    });
    if (!data || data.code !== 0 || !data.data) {
        return { ok: false, error: "B 站视频信息获取失败（视频可能不存在或被限制）" };
    }
    const view = data.data;
    return {
        ok: true,
        source: "bilibili",
        title: view.title || "B 站视频",
        desc: view.desc || "",
        cover: view.pic ? view.pic.replace(/^http:/, "https:") : undefined,
        owner: view.owner?.name || undefined,
        embedUrl: buildBilibiliEmbed(view.bvid || bvid, view.aid ? String(view.aid) : aid, page),
    };
}

async function fetchYoutubeMeta(videoId: string): Promise<MetaResult> {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const oembed = await fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string }>(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
        { "User-Agent": BROWSER_UA },
    );
    return {
        ok: true,
        source: "youtube",
        title: oembed?.title || "YouTube 视频",
        owner: oembed?.author_name || undefined,
        cover: oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        embedUrl: buildYoutubeEmbed(videoId),
    };
}

type BangumiSubject = {
    name?: string;
    name_cn?: string;
    summary?: string;
    images?: { common?: string; large?: string };
    eps?: number;
    date?: string;
    platform?: string;
};

async function fetchBangumiMeta(subjectId: string): Promise<MetaResult> {
    const data = await fetchJson<BangumiSubject>(`https://api.bgm.tv/v0/subjects/${encodeURIComponent(subjectId)}`, {
        "User-Agent": BANGUMI_UA,
    });
    if (!data || (!data.name && !data.name_cn)) {
        return { ok: false, error: "番剧信息获取失败（条目可能不存在）" };
    }
    const title = (data.name_cn || data.name || "未知番剧").trim();
    const metaBits = [
        data.platform ? `类型：${data.platform}` : "",
        data.date ? `开播：${data.date}` : "",
        data.eps ? `集数：${data.eps}` : "",
    ].filter(Boolean).join("　");
    return {
        ok: true,
        source: "bangumi",
        title,
        desc: [metaBits, (data.summary || "").trim()].filter(Boolean).join("\n"),
        cover: data.images?.large || data.images?.common || undefined,
    };
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const raw = (searchParams.get("url") || "").trim();
    if (!raw) {
        return NextResponse.json({ ok: false, error: "缺少 url 参数" } satisfies MetaResult, { status: 400 });
    }

    let parsed = parseWatchLink(raw);

    // b23.tv 短链：先跟随重定向拿到真实链接再解析
    if (parsed?.kind === "bilibili-short") {
        const target = await resolveBilibiliShort(parsed.url);
        if (target) parsed = parseWatchLink(target);
    }

    if (!parsed) {
        return NextResponse.json({ ok: false, error: "没认出这个链接。支持 B 站、YouTube、bangumi/animeko 番剧链接，或 mp4 直链" } satisfies MetaResult, { status: 200 });
    }

    try {
        switch (parsed.kind) {
            case "bilibili":
                return NextResponse.json(await fetchBilibiliMeta(parsed.bvid, parsed.aid, parsed.page) satisfies MetaResult);
            case "youtube":
                return NextResponse.json(await fetchYoutubeMeta(parsed.videoId) satisfies MetaResult);
            case "bangumi":
                return NextResponse.json(await fetchBangumiMeta(parsed.subjectId) satisfies MetaResult);
            case "direct": {
                const name = decodeURIComponent(new URL(parsed.url).pathname.split("/").pop() || "直链视频");
                return NextResponse.json({
                    ok: true,
                    source: "direct",
                    title: name.replace(/\.[a-z0-9]+$/i, "") || "直链视频",
                    directUrl: parsed.url,
                } satisfies MetaResult);
            }
            default:
                return NextResponse.json({ ok: false, error: "暂不支持的链接类型" } satisfies MetaResult);
        }
    } catch (error) {
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "解析失败" } satisfies MetaResult, { status: 200 });
    }
}
