// components/music/otome-video-overlay.tsx — Persistent video overlay for the
// otome player. Rendered in the desktop shell (not inside the Music app) so the
// video keeps playing while the user browses elsewhere. It repositions the shared
// YouTube iframe host over the phone screen (or the full window when expanded).
"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useMusicControlsOptional } from "@/lib/music-context";
import type { MusicTrack } from "@/lib/music-storage";
import { ytEngine, type VideoRect } from "@/lib/youtube-engine";
import {
    subscribeOtomeVideo,
    getOtomeVideoSnapshot,
    hideOtomeVideo,
} from "@/lib/otome-video";

function isYoutubeTrack(t: MusicTrack | null | undefined): boolean {
    return !!t && (t.source === "youtube" || t.id?.startsWith("yt_"));
}

function getPhoneRect(): VideoRect | null {
    if (typeof document === "undefined") return null;
    const el = document.querySelector('[data-ui="phone-screen"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function getViewportRect(): VideoRect {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export default function OtomeVideoOverlay() {
    const visible = useSyncExternalStore(subscribeOtomeVideo, getOtomeVideoSnapshot, getOtomeVideoSnapshot);
    const player = useMusicControlsOptional();
    const [expanded, setExpanded] = useState(false);

    const track = player?.currentTrack;
    const active = visible && isYoutubeTrack(track);

    // Reposition the shared iframe in response to visibility / mode / track.
    useEffect(() => {
        if (!active) {
            ytEngine.setVideoRect(null);
            return;
        }
        const apply = () => {
            const rect = expanded ? getViewportRect() : getPhoneRect();
            ytEngine.setVideoRect(rect);
        };
        apply();
        window.addEventListener("resize", apply);
        return () => {
            window.removeEventListener("resize", apply);
            ytEngine.setVideoRect(null);
        };
    }, [active, expanded]);

    // Reset expand state when the overlay hides.
    useEffect(() => {
        if (!visible) setExpanded(false);
    }, [visible]);

    const backToAudio = useCallback(() => {
        hideOtomeVideo();
    }, []);

    const toggleExpand = useCallback(() => {
        setExpanded(prev => !prev);
    }, []);

    if (!active || typeof document === "undefined") return null;

    const title = track?.title || "乙女抓播放";

    return createPortal(
        <div className="otome-video-ui" data-expanded={expanded ? "" : undefined}>
            <div className="otome-video-topbar">
                <div className="otome-video-title">
                    <span className="otome-video-live-dot" />
                    <span className="otome-video-title-text">{title}</span>
                </div>
                <div className="otome-video-actions">
                    <button className="otome-video-btn" onClick={backToAudio} title="切回音频模式" data-label="音频">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                        </svg>
                        <span>音频</span>
                    </button>
                    <button className="otome-video-btn" onClick={toggleExpand} title={expanded ? "退出放大" : "放大画面"}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            {expanded ? (
                                <><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></>
                            ) : (
                                <><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></>
                            )}
                        </svg>
                    </button>
                    <button className="otome-video-btn" onClick={backToAudio} title="关闭视频（声音继续播放）">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}