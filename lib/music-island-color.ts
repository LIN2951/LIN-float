// lib/music-island-color.ts — 灵动岛配色：跟随歌曲取色 / 固定色 / 隐藏跳动条
"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const KEY = "music-island-color-v1";
registerKvMigration(KEY);

export const MUSIC_ISLAND_COLOR_EVENT = "music-island-color-change";

export type MusicIslandColorMode = "follow" | "fixed";

export type MusicIslandColorSettings = {
    /** follow = 跟随当前歌曲取色；fixed = 使用下方固定颜色 */
    mode: MusicIslandColorMode;
    /** 固定色 id（见 ISLAND_COLORS） */
    color: string;
    /** 隐藏跳动波浪条，只保留灵动岛本体 */
    hideWave: boolean;
};

export const ISLAND_COLORS = [
    { id: "white", value: "#ffffff", label: "白" },
    { id: "blue", value: "#6fb2ff", label: "蓝" },
    { id: "pink", value: "#ff9ecb", label: "粉" },
    { id: "green", value: "#63e6a5", label: "绿" },
    { id: "purple", value: "#b18cff", label: "紫" },
    { id: "orange", value: "#ffb066", label: "橙" },
] as const;

export type IslandColorId = typeof ISLAND_COLORS[number]["id"];

export const DEFAULT_MUSIC_ISLAND_COLOR: MusicIslandColorSettings = {
    mode: "follow",
    color: "white",
    hideWave: false,
};

function normalizeColorId(value: unknown, fallback: string): string {
    return ISLAND_COLORS.some(c => c.id === value) ? (value as string) : fallback;
}

export function loadMusicIslandColor(): MusicIslandColorSettings {
    if (typeof window === "undefined") return DEFAULT_MUSIC_ISLAND_COLOR;
    try {
        const raw = kvGet(KEY);
        if (!raw) return DEFAULT_MUSIC_ISLAND_COLOR;
        const parsed = JSON.parse(raw) as Partial<MusicIslandColorSettings>;
        return {
            mode: parsed.mode === "fixed" ? "fixed" : "follow",
            color: normalizeColorId(parsed.color, DEFAULT_MUSIC_ISLAND_COLOR.color),
            hideWave: parsed.hideWave === true,
        };
    } catch {
        return DEFAULT_MUSIC_ISLAND_COLOR;
    }
}

export function saveMusicIslandColor(settings: MusicIslandColorSettings): void {
    const next: MusicIslandColorSettings = {
        mode: settings.mode === "fixed" ? "fixed" : "follow",
        color: normalizeColorId(settings.color, DEFAULT_MUSIC_ISLAND_COLOR.color),
        hideWave: settings.hideWave === true,
    };
    try { kvSet(KEY, JSON.stringify(next)); } catch { /* ignore */ }
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(MUSIC_ISLAND_COLOR_EVENT));
    }
}

export function islandColorValue(id: string): string {
    return ISLAND_COLORS.find(c => c.id === id)?.value || "#ffffff";
}

/** 十六进制颜色 → 带透明度的 rgba 字符串 */
export function hexToRgba(hex: string, alpha: number): string {
    const match = hex.replace("#", "").match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return `rgba(255, 255, 255, ${alpha})`;
    let raw = match[1];
    if (raw.length === 3) raw = raw.split("").map(ch => ch + ch).join("");
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** 封面不可取色时的兜底：按歌曲 id 稳定地散列到一个舒服的色彩 */
const FALLBACK_ACCENTS = ["#6fb2ff", "#ff9ecb", "#63e6a5", "#b18cff", "#ffb066", "#7fd8ff", "#ff8f8f"];

function hashString(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

export function fallbackTrackAccent(seed: string): string {
    if (!seed) return "#ffffff";
    return FALLBACK_ACCENTS[hashString(seed) % FALLBACK_ACCENTS.length];
}

const accentCache = new Map<string, string>();

/**
 * 从封面图片里取一个「可用的强调色」。
 * 封面 CDN 通常不允许跨域读取像素，取不到时按歌曲 id 做稳定散列，保证每首歌都会变色。
 */
export function resolveTrackAccent(trackId: string | undefined, coverUrl: string | undefined): Promise<string> {
    const cacheKey = `${trackId || ""}|${coverUrl || ""}`;
    const cached = accentCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const fallback = fallbackTrackAccent(trackId || coverUrl || "");
    if (!coverUrl || typeof window === "undefined") {
        accentCache.set(cacheKey, fallback);
        return Promise.resolve(fallback);
    }

    return new Promise<string>((resolve) => {
        let settled = false;
        const finish = (value: string) => {
            if (settled) return;
            settled = true;
            accentCache.set(cacheKey, value);
            resolve(value);
        };

        const timer = window.setTimeout(() => finish(fallback), 1800);
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.onerror = () => {
            window.clearTimeout(timer);
            finish(fallback);
        };
        img.onload = () => {
            try {
                const size = 24;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                if (!ctx) throw new Error("no ctx");
                ctx.drawImage(img, 0, 0, size, size);
                const data = ctx.getImageData(0, 0, size, size).data;
                let r = 0;
                let g = 0;
                let b = 0;
                let count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const alpha = data[i + 3];
                    if (alpha < 128) continue;
                    const pr = data[i];
                    const pg = data[i + 1];
                    const pb = data[i + 2];
                    const max = Math.max(pr, pg, pb);
                    const min = Math.min(pr, pg, pb);
                    // 跳过近黑 / 近白像素，它们对「取色」没有帮助
                    if (max < 40 || min > 225) continue;
                    if (max - min < 18) continue; // 灰阶也不取
                    r += pr; g += pg; b += pb; count++;
                }
                if (count < 8) {
                    // 封面本身低饱和（黑白/灰调），退回到稳定散列色
                    finish(fallback);
                    return;
                }
                r /= count; g /= count; b /= count;
                // 把取到的平均色提亮到适合发光条的亮度
                const lift = (v: number) => Math.round(Math.min(255, Math.max(90, v * 1.18)));
                const toHex = (v: number) => lift(v).toString(16).padStart(2, "0");
                window.clearTimeout(timer);
                finish(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
            } catch {
                // canvas 被跨域污染 / 取像素失败
                window.clearTimeout(timer);
                finish(fallback);
            }
        };
        try {
            img.src = coverUrl;
        } catch {
            window.clearTimeout(timer);
            finish(fallback);
        }
    });
}
