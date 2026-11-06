"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { loadLockScreenSettings } from "@/lib/lockscreen-settings";

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
 * 锁屏（进入页）：小红书式的氛围锁屏。
 * - 支持自定义上传壁纸（在「主题 → 锁屏」里设置），默认是奶油色渐变氛围底
 * - 大时钟 + 日期 + 一句话签名
 * - 上滑或点击底部按钮进入桌面
 */
export function LockScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
    const now = useNow();
    const [settings] = useState(() => loadLockScreenSettings());
    const gestureRef = useRef<{ y: number; active: boolean }>({ y: 0, active: false });

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

    const hasWallpaper = Boolean(settings.wallpaper);

    return (
        <div
            className="lock-screen"
            data-variant={hasWallpaper ? "custom" : "default"}
            data-ready={ready ? "true" : "false"}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            role="button"
            aria-label={ready ? "上滑或点击进入桌面" : "加载中"}
        >
            {hasWallpaper ? (
                <div className="lock-screen-wall" style={{ backgroundImage: `url(${settings.wallpaper})` }} />
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
                {settings.signature.trim() ? (
                    <div className="lock-screen-signature">{settings.signature}</div>
                ) : null}

                <div className="lock-screen-flex" />

                <button type="button" className="lock-screen-enter" onClick={tryEnter} disabled={!ready}>
                    <span className="lock-screen-enter-pill">
                        <ArrowUp size={20} strokeWidth={1.6} />
                    </span>
                    <span className="lock-screen-enter-label">{ready ? "上滑进入" : "加载中…"}</span>
                </button>
            </div>
        </div>
    );
}
