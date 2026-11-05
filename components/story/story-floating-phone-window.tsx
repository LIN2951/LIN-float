"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Minus, Move, Plus, X } from "lucide-react";
import { floatingPhoneGeometry, type FloatingPhonePosition } from "@/lib/floating-phone-geometry";
import { loadFloatingPhoneScale, saveFloatingPhoneScale } from "@/lib/floating-phone-settings";

export function StoryFloatingPhoneWindow({ children, compact = false, onClose }: { children: ReactNode; compact?: boolean; onClose: () => void }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [bounds, setBounds] = useState({ width: 0, height: 0 });
    const [scale, setScale] = useState(loadFloatingPhoneScale);
    const [position, setPosition] = useState<FloatingPhonePosition | null>(null);
    const drag = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number; scaleX: number; scaleY: number } | null>(null);
    const frame = floatingPhoneGeometry(bounds, scale, compact, position);

    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const measure = () => setBounds({ width: host.clientWidth, height: host.clientHeight });
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
        observer?.observe(host);
        window.addEventListener("resize", measure);
        measure();
        return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
    }, []);

    const zoom = (value: number) => setScale(saveFloatingPhoneScale(value));
    const startMove = (event: PointerEvent<HTMLButtonElement>) => {
        const host = hostRef.current;
        if (!host) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = host.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
            x: frame.x, y: frame.y, scaleX: rect.width / Math.max(1, host.clientWidth), scaleY: rect.height / Math.max(1, host.clientHeight) };
    };
    const move = (event: PointerEvent<HTMLButtonElement>) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const next = floatingPhoneGeometry(bounds, scale, compact, {
            x: start.x + (event.clientX - start.clientX) / (start.scaleX || 1),
            y: start.y + (event.clientY - start.clientY) / (start.scaleY || 1),
        });
        setPosition({ x: next.x, y: next.y });
    };
    const endMove = (event: PointerEvent<HTMLButtonElement>) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    return <div ref={hostRef} className="story-phone-window-space">
        <section className="story-phone-window-frame" aria-label="剧情悬浮小手机" onClick={event => event.stopPropagation()}
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, visibility: bounds.width ? "visible" : "hidden" }}>
            <div className="story-phone-window-toolbar" role="toolbar" aria-label="小手机窗口控制">
                <span>小手机</span>
                <button type="button" aria-label="移动小手机窗口" title="按住拖动，或使用方向键移动" style={{ touchAction: "none", cursor: "move" }}
                    onPointerDown={startMove} onPointerMove={move} onPointerUp={endMove} onPointerCancel={endMove} onLostPointerCapture={() => { drag.current = null; }}
                    onKeyDown={event => {
                        const delta = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }[event.key];
                        if (!delta) return;
                        event.preventDefault();
                        setPosition({ x: frame.x + delta[0], y: frame.y + delta[1] });
                    }}><Move size={15} /></button>
                <button type="button" aria-label="缩小小手机窗口" disabled={scale <= 0.8} onClick={() => zoom(scale - 0.05)}><Minus size={15} /></button>
                <input type="range" aria-label="小手机窗口大小" min="80" max="100" step="1" value={Math.round(scale * 100)} onChange={event => zoom(Number(event.target.value) / 100)} />
                <output>{Math.round(scale * 100)}％</output>
                <button type="button" aria-label="放大小手机窗口" disabled={scale >= 1} onClick={() => zoom(scale + 0.05)}><Plus size={15} /></button>
                <button type="button" aria-label="关闭悬浮小手机" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="story-phone-window-content">{children}</div>
        </section>
    </div>;
}
