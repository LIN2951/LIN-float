// lib/lockscreen-settings.ts — 锁屏（进入页）设置
// 持久化：是否隐藏锁屏。锁屏本身固定为初始样式（氛围渐变 + 大时钟），
// 不再支持自定义壁纸/签名，避免多余状态残留。
"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const LOCK_SCREEN_KEY = "ai_phone_lockscreen_v1";
registerKvMigration(LOCK_SCREEN_KEY);

export const LOCK_SCREEN_EVENT = "lock-screen-settings-change";

export type LockScreenSettings = {
    /** 为 true 时开机跳过锁屏，直接进入桌面 */
    hidden: boolean;
};

export const DEFAULT_LOCK_SCREEN_SETTINGS: LockScreenSettings = {
    hidden: false,
};

export function loadLockScreenSettings(): LockScreenSettings {
    if (typeof window === "undefined") return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
    try {
        const raw = kvGet(LOCK_SCREEN_KEY);
        if (!raw) return { ...DEFAULT_LOCK_SCREEN_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<LockScreenSettings>;
        return {
            hidden: parsed.hidden === true,
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
