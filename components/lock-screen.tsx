"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
const ENTER_THRESHOLD = 72;

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
 * 锁屏（进入页）：极简进入页。
 * - 无壁纸、无签名，只保留时钟 + 日期 + 上滑进入
 * - 上滑（带跟手位移）或点击底部按钮进入桌面
 * - 若用户在「外观 → 锁屏」里开启隐藏锁屏，主应用会在首帧就跳过本组件，
 *   全程不渲染，直接进桌面。
 */
export function LockScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
    const now = useNow();
    const [drag, setDrag] = useState(0);
    const [dragging, setDragging] = useState(false);
    const gestureRef = useRef({ y: 0, active: false });

    const tryEnter = () => {
        if (!ready) return;
        onEnter?.();
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("button")) return;
        gestureRef.current = { y: e.clientY, active: true };
        setDragging(true);
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!gestureRef.current.active) return;
        const dy = gestureRef.current.y - e.clientY;
        setDrag(Math.max(0, Math.min(240, dy)));
    };

    const finishGesture = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!gestureRef.current.active) return;
        gestureRef.current.active = false;
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
        const dy = gestureRef.current.y - e.clientY;
        setDragging(false);
        if (dy > ENTER_THRESHOLD) {
            setDrag(0);
            tryEnter();
        } else {
            setDrag(0);
        }
    };

    const cancelGesture = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!gestureRef.current.active) return;
        gestureRef.current.active = false;
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
        setDragging(false);
        setDrag(0);
    };

    return (
        <div
            className="lock-screen"
            data-ready={ready ? "true" : "false"}
            data-dragging={dragging ? "true" : "false"}
            style={{ "--lock-drag": `${drag}px`, "--lock-drag-ratio": drag / 240 } as React.CSSProperties}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishGesture}
            onPointerCancel={cancelGesture}
            role="button"
            aria-label={ready ? "上滑或点击进入桌面" : "加载中"}
        >
            <div className="lock-screen-wall lock-screen-default-wall">
                <span className="lock-screen-bokeh lock-screen-bokeh-a" />
                <span className="lock-screen-bokeh lock-screen-bokeh-b" />
            </div>
            <div className="lock-screen-dim" />

            <div className="lock-screen-content">
                <div className="lock-screen-top">
                    <span className="lock-screen-date">
                        {now.getMonth() + 1}月{now.getDate()}日 · 周{WEEKDAYS[now.getDay()]}
                    </span>
                </div>

                <div className="lock-screen-clock">
                    <span className="lock-screen-time">
                        {pad2(now.getHours())}:{pad2(now.getMinutes())}
                    </span>
                </div>

                <div className="lock-screen-flex" />

                <button type="button" className="lock-screen-enter" onClick={tryEnter} disabled={!ready}>
                    <span className="lock-screen-enter-pill">
                        <ArrowUp size={20} strokeWidth={1.7} />
                    </span>
                    <span className="lock-screen-enter-label">{ready ? "上滑进入" : "加载中…"}</span>
                </button>
                <span className="lock-screen-home-bar" aria-hidden="true" />
            </div>
        </div>
    );
}