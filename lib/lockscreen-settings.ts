// lib/lockscreen-settings.ts — 锁屏（进入页）外观设置
// 持久化：是否隐藏锁屏、自定义锁屏壁纸
"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const LOCK_SCREEN_KEY = "ai_phone_lockscreen_v1";
registerKvMigration(LOCK_SCREEN_KEY);

export const LOCK_SCREEN_EVENT = "lock-screen-settings-change";

export type LockScreenSettings = {
    /** 为 true 时开机跳过锁屏，直接进入桌面 */
    hidden: boolean;
    /** 自定义锁屏壁纸（压缩后的 data URL），null = 默认氛围壁纸 */
    wallpaper: string | null;
    /** 锁屏上显示的一句话签名；空串 = 不显示 */
    signature: string;
};

export const DEFAULT_LOCK_SCREEN_SETTINGS: LockScreenSettings = {
    hidden: false,
    wallpaper: null,
    signature: "把日子过成喜欢的样子",
};

export function loadLockScreenSettings(): LockScreenSettings {
    if (typeof window === "undefined") return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
    try {
        const raw = kvGet(LOCK_SCREEN_KEY);
        if (!raw) return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<LockScreenSettings>;
        return {
            hidden: parsed.hidden === true,
            wallpaper: typeof parsed.wallpaper === "string" && parsed.wallpaper.startsWith("data:image/")
                ? parsed.wallpaper
                : null,
            signature: typeof parsed.signature === "string" ? parsed.signature : DEFAULT_LOCK_SCREEN_SETTINGS.signature,
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
        window.dispatchEvent(new CustomEvent(LOCK_SCREEN_EVENT));
    }
}
