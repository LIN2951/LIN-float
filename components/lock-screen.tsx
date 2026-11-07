"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

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
 * 锁屏（进入页）：初始样式锁屏。
 * - 默认奶油色渐变氛围底 + 颗粒噪点，大时钟 + 日期
 * - 上滑或点击底部按钮进入桌面
 * - 是否显示由「主题 → 锁屏 → 隐藏锁屏」控制（隐藏后直接进桌面）
 */
export function LockScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
    const now = useNow();
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

    return (
        <div
            className="lock-screen"
            data-variant="default"
            data-ready={ready ? "true" : "false"}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            role="button"
            aria-label={ready ? "上滑或点击进入桌面" : "加载中"}
        >
            <div className="lock-screen-wall lock-screen-default-wall" />
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
                        <ArrowUp size={20} strokeWidth={1.6} />
                    </span>
                    <span className="lock-screen-enter-label">{ready ? "上滑进入" : "加载中…"}</span>
                </button>
            </div>
        </div>
    );
}
