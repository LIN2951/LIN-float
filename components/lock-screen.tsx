"use client";

import { useEffect, useRef, useState } from "react";
import { getThemeAssetMap } from "@/lib/theme-storage";
import { loadLockScreenSettings, LOCK_SCREEN_EVENT } from "@/lib/lockscreen-settings";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

function pad2(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

function useNow() {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

/**
 * 锁屏（进入页）：苹果灰白极简风格
 * - 默认灰白渐变底 + 细腻颗粒噪点，大时钟 + 日期
 * - 支持上传本地壁纸作为背景
 * - 上滑或点击底部按钮丝滑进入桌面
 */
export function LockScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
    const now = useNow();
    const gestureRef = useRef<{ y: number; active: boolean }>({ y: 0, active: false });
    const [wallpaperAssetId, setWallpaperAssetId] = useState<string | null>(null);
    const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);

    // 加载锁屏壁纸设置
    useEffect(() => {
        const settings = loadLockScreenSettings();
        setWallpaperAssetId(settings.wallpaperAssetId);
        
        const handleLockScreenChange = () => {
            const updated = loadLockScreenSettings();
            setWallpaperAssetId(updated.wallpaperAssetId);
        };
        window.addEventListener(LOCK_SCREEN_EVENT, handleLockScreenChange);
        return () => window.removeEventListener(LOCK_SCREEN_EVENT, handleLockScreenChange);
    }, []);

    // 根据壁纸 ID 获取图片 Data URL
    useEffect(() => {
        if (!wallpaperAssetId) {
            setWallpaperUrl(null);
            return;
        }
        getThemeAssetMap([wallpaperAssetId]).then((assets) => {
            setWallpaperUrl(assets[wallpaperAssetId] || null);
        }).catch(() => setWallpaperUrl(null));
    }, [wallpaperAssetId]);

    const tryEnter = () => {
        if (!ready) return;
        onEnter?.();
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        gestureRef.current = { y: e.clientY, active: true };
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!gestureRef.current.active) return;
        gestureRef.current.active = false;
        if (gestureRef.current.y - e.clientY > 48) {
            tryEnter();
        }
    };

    return (
        <div
            className="lock-screen"
            data-variant="ios-gray"
            data-ready={ready ? "true" : "false"}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            role="button"
            aria-label={ready ? "上滑或点击进入桌面" : "加载中"}
        >
            {wallpaperUrl ? (
                <div className="lock-screen-wall" style={{ backgroundImage: `url(${wallpaperUrl})` }} />
            ) : (
                <div className="lock-screen-wall lock-screen-default-wall" />
            )}
            <div className="lock-screen-dim" />
            <div className="lock-screen-grain" />

            <div className="lock-screen-content">
                <div className="lock-screen-date">
                    {now.getMonth() + 1}月{now.getDate()}日 · 周{WEEKDAYS[now.getDay()]}
                </div>
                <div className="lock-screen-time">
                    {pad2(now.getHours())}:{pad2(now.getMinutes())}
                </div>

                <div className="lock-screen-flex" />

                <button type="button" className="lock-screen-enter" onClick={tryEnter} disabled={!ready}>
                    <span className="lock-screen-enter-pill">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                        </svg>
                    </span>
                    <span className="lock-screen-enter-label">{ready ? "上滑进入" : "加载中…"}</span>
                </button>
            </div>
        </div>
    );
}