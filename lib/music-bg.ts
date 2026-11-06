// lib/music-bg.ts — User-customizable backgrounds for the music app
// App pages and the full-screen player can each have their own image.
// Changes broadcast via a window event.

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type MusicPlayerBgMode = "cover" | "follow" | "custom";

export type MusicBgConfig = {
    image: string;          // app pages background: data URL or https URL; "" = default
    dim: number;            // 0-100, dark overlay strength for app pages
    playerMode: MusicPlayerBgMode; // player backdrop: cover palette / follow app bg / own image
    playerImage: string;    // player-specific image when playerMode === "custom"
    playerDim: number;      // 0-100, dark overlay strength for the player image
};

const MUSIC_BG_KEY = "music-custom-bg-v1";
registerKvMigration(MUSIC_BG_KEY);

export const MUSIC_BG_EVENT = "music-bg-change";

export const DEFAULT_MUSIC_BG: MusicBgConfig = {
    image: "", dim: 45, playerMode: "follow", playerImage: "", playerDim: 50,
};

function clampDim(value: unknown, fallback: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value as number)) : fallback;
}

export function loadMusicBg(): MusicBgConfig {
    if (typeof window === "undefined") return DEFAULT_MUSIC_BG;
    try {
        const raw = kvGet(MUSIC_BG_KEY);
        if (!raw) return DEFAULT_MUSIC_BG;
        const parsed = JSON.parse(raw) as Partial<MusicBgConfig> & { applyPlayer?: boolean };
        let playerMode: MusicPlayerBgMode =
            parsed.playerMode === "cover" || parsed.playerMode === "follow" || parsed.playerMode === "custom"
                ? parsed.playerMode
                // Migrate from the earlier {applyPlayer} shape
                : parsed.applyPlayer === false ? "cover" : "follow";
        return {
            image: typeof parsed.image === "string" ? parsed.image : "",
            dim: clampDim(parsed.dim, 45),
            playerMode,
            playerImage: typeof parsed.playerImage === "string" ? parsed.playerImage : "",
            playerDim: clampDim(parsed.playerDim, 50),
        };
    } catch { return DEFAULT_MUSIC_BG; }
}

export function saveMusicBg(cfg: MusicBgConfig): { ok: boolean; message: string } {
    try {
        if (!cfg.image && !cfg.playerImage && cfg.playerMode === "follow") {
            kvRemove(MUSIC_BG_KEY);
        } else {
            kvSet(MUSIC_BG_KEY, JSON.stringify(cfg));
        }
        window.dispatchEvent(new CustomEvent(MUSIC_BG_EVENT));
        return { ok: true, message: "背景已更新" };
    } catch {
        // Most likely storage quota exceeded by a large data URL
        return { ok: false, message: "保存失败，图片可能过大" };
    }
}

export function clearMusicBg(): void {
    try { kvRemove(MUSIC_BG_KEY); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(MUSIC_BG_EVENT));
}

/** Compress an uploaded image to a reasonably sized JPEG data URL. */
export function fileToCompressedDataUrl(file: File, maxDim = 1440, quality = 0.82): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片读取失败")); };
        img.onload = () => {
            URL.revokeObjectURL(url);
            try {
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) { reject(new Error("图片处理失败")); return; }
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL("image/jpeg", quality));
            } catch {
                reject(new Error("图片处理失败"));
            }
        };
        img.src = url;
    });
}

type BgInlineStyle = { backgroundImage: string; backgroundSize: "cover"; backgroundPosition: string };

function buildBgStyle(image: string, dimPct: number, boost: number): BgInlineStyle {
    const a = Math.max(0, Math.min(0.95, dimPct / 100 + boost));
    return {
        backgroundImage: `linear-gradient(rgba(8, 9, 14, ${a}), rgba(8, 9, 14, ${a})), url("${image}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
    };
}

// ── Music float mode (orb ball / top dynamic island) ──

export type MusicFloatMode = "orb" | "island" | "both";

const MUSIC_FLOAT_MODE_KEY = "music-float-mode-v1";
registerKvMigration(MUSIC_FLOAT_MODE_KEY);

export const MUSIC_FLOAT_MODE_EVENT = "music-float-mode-change";

export const DEFAULT_MUSIC_FLOAT_MODE: MusicFloatMode = "both";

export function loadMusicFloatMode(): MusicFloatMode {
    if (typeof window === "undefined") return DEFAULT_MUSIC_FLOAT_MODE;
    try {
        const stored = kvGet(MUSIC_FLOAT_MODE_KEY);
        if (stored === "orb" || stored === "island" || stored === "both") return stored;
        return DEFAULT_MUSIC_FLOAT_MODE;
    } catch {
        return DEFAULT_MUSIC_FLOAT_MODE;
    }
}

export function saveMusicFloatMode(mode: MusicFloatMode): void {
    try { kvSet(MUSIC_FLOAT_MODE_KEY, mode); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(MUSIC_FLOAT_MODE_EVENT));
}

// ── Music float sizes (orb / orb card / island card) ──

export type MusicFloatSizes = {
    orb: number;
    orbCardWidth: number;
    orbCardHeight: number;
    islandWidth: number;
    islandHeight: number;
};

const MUSIC_FLOAT_SIZES_KEY = "music-float-sizes-v1";
registerKvMigration(MUSIC_FLOAT_SIZES_KEY);

export const MUSIC_FLOAT_SIZES_EVENT = "music-float-sizes-change";

export const MUSIC_FLOAT_SIZE_LIMITS = {
    orb: { min: 34, max: 76, step: 2 },
    orbCardWidth: { min: 210, max: 340, step: 8 },
    orbCardHeight: { min: 112, max: 184, step: 6 },
    islandWidth: { min: 240, max: 380, step: 10 },
    islandHeight: { min: 112, max: 190, step: 6 },
} as const;

export const DEFAULT_MUSIC_FLOAT_SIZES: MusicFloatSizes = {
    orb: 46,
    orbCardWidth: 264,
    orbCardHeight: 126,
    islandWidth: 300,
    islandHeight: 128,
};

function clampSize(key: keyof MusicFloatSizes, value: unknown): number {
    const limit = MUSIC_FLOAT_SIZE_LIMITS[key];
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_MUSIC_FLOAT_SIZES[key];
    return Math.max(limit.min, Math.min(limit.max, Math.round(n)));
}

export function normalizeMusicFloatSizes(input: Partial<MusicFloatSizes> | null | undefined): MusicFloatSizes {
    return {
        orb: clampSize("orb", input?.orb),
        orbCardWidth: clampSize("orbCardWidth", input?.orbCardWidth),
        orbCardHeight: clampSize("orbCardHeight", input?.orbCardHeight),
        islandWidth: clampSize("islandWidth", input?.islandWidth),
        islandHeight: clampSize("islandHeight", input?.islandHeight),
    };
}

export function loadMusicFloatSizes(): MusicFloatSizes {
    if (typeof window === "undefined") return DEFAULT_MUSIC_FLOAT_SIZES;
    try {
        const raw = kvGet(MUSIC_FLOAT_SIZES_KEY);
        if (!raw) return DEFAULT_MUSIC_FLOAT_SIZES;
        return normalizeMusicFloatSizes(JSON.parse(raw) as Partial<MusicFloatSizes>);
    } catch {
        return DEFAULT_MUSIC_FLOAT_SIZES;
    }
}

export function saveMusicFloatSizes(sizes: MusicFloatSizes): void {
    const next = normalizeMusicFloatSizes(sizes);
    try { kvSet(MUSIC_FLOAT_SIZES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(MUSIC_FLOAT_SIZES_EVENT));
}

/** Background style for app pages (home / playlists / mine), or undefined for default. */
export function appBgStyle(cfg: MusicBgConfig): BgInlineStyle | undefined {
    if (!cfg.image) return undefined;
    return buildBgStyle(cfg.image, cfg.dim, 0);
}

/** Background style for the full-screen player, or undefined for the cover-palette default. */
export function playerBgStyle(cfg: MusicBgConfig): BgInlineStyle | undefined {
    if (cfg.playerMode === "custom" && cfg.playerImage) {
        return buildBgStyle(cfg.playerImage, cfg.playerDim, 0.08);
    }
    if (cfg.playerMode === "follow" && cfg.image) {
        return buildBgStyle(cfg.image, cfg.dim, 0.08);
    }
    return undefined;
}
