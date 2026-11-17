// lib/lockscreen-settings.ts — 锁屏（进入页）设置
// 持久化：是否隐藏锁屏、锁屏壁纸。锁屏支持灰白渐变或用户上传的壁纸图，
// 上传图片走主题资源库（type: "bg"），避免锁屏数据冗余。
"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const LOCK_SCREEN_KEY = "ai_phone_lockscreen_v1";
registerKvMigration(LOCK_SCREEN_KEY);

export const LOCK_SCREEN_EVENT = "lock-screen-settings-change";

export type LockScreenSettings = {
    /** 为 true 时开机跳过锁屏，直接进入桌面 */
    hidden: boolean;
    /** 锁屏壁纸图片资源 ID（指向主题资源库），null = 使用默认灰白渐变 */
    wallpaperAssetId: string | null;
};

export const DEFAULT_LOCK_SCREEN_SETTINGS: LockScreenSettings = {
    hidden: false,
    wallpaperAssetId: null,
};

export function loadLockScreenSettings(): LockScreenSettings {
    if (typeof window === "undefined") return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
    try {
        const raw = kvGet(LOCK_SCREEN_KEY);
        if (!raw) return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<LockScreenSettings>;
        return {
            hidden: parsed.hidden === true,
            wallpaperAssetId: typeof parsed.wallpaperAssetId === "string" && parsed.wallpaperAssetId ? parsed.wallpaperAssetId : null,
        };
    } catch {
        return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
    }
}

export function saveLockScreenSettings(settings: LockScreenSettings): void {
    try {
        kvSet(LOCK_SCREEN_KEY, JSON.stringify(settings));
    } catch { /* ignore */ }
    if (typeof window !== "undefined") {
        // 隐藏锁屏需要在下次加载时「零停顿」跳过锁屏。KV 是异步的，等 hydrate 完
        // 再判断会先闪一下锁屏；这里同步镜像一份到 localStorage，首帧即可读取。
        try { localStorage.setItem(LOCK_SCREEN_HIDDEN_SYNC_KEY, settings.hidden ? "1" : "0"); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent(LOCK_SCREEN_EVENT));
    }
}

const LOCK_SCREEN_HIDDEN_SYNC_KEY = "ai_phone_lockscreen_hidden_sync";

/** 同步读取「隐藏锁屏」开关（首帧即可用，用于跳过锁屏渲染）。 */
export function loadLockScreenHiddenSync(): boolean {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem(LOCK_SCREEN_HIDDEN_SYNC_KEY) === "1"; } catch { return false; }
}