// components/music/music-desktop-lyrics.tsx — Desktop lyrics overlay, like & lyrics buttons
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMusicPlayerOptional, type MusicControlsValue } from "@/lib/music-context";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { getCloudSongLiked, getNeteaseLyrics, setCloudSongLiked } from "@/lib/music-service";

const LYRICS_POS_KEY = "music-desktop-lyrics-position-v1";
const LYRICS_APPEARANCE_KEY = "music-desktop-lyrics-appearance-v1";
registerKvMigration(LYRICS_POS_KEY);
registerKvMigration(LYRICS_APPEARANCE_KEY);

const FONT_MIN = 12;
const FONT_MAX = 30;
const FONT_DEFAULT = 18;
const FONT_STEP = 2;

export const LYRICS_COLORS = [
    { id: "white", value: "#ffffff", label: "白" },
    { id: "black", value: "#111111", label: "黑" },
    { id: "yellow", value: "#ffd75e", label: "黄" },
    { id: "green", value: "#7ee787", label: "绿" },
    { id: "blue", value: "#79b8ff", label: "蓝" },
    { id: "pink", value: "#ff9ecb", label: "粉" },
] as const;

type LyricsAppearance = { fontSize: number; color: string };
type LyricsPosition = { x: number; y: number };
type TimedLine = { time: number; text: string };

const DEFAULT_APPEARANCE: LyricsAppearance = { fontSize: FONT_DEFAULT, color: "white" };

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(v, max));
}

/** Parse LRC text into timed lines. Supports `[offset:ms]` and multiple tags per line. */
function parseLyrics(raw: string): { lines: TimedLine[]; plain: string[] } {
    if (!raw) return { lines: [], plain: [] };
    let offsetMs = 0;
    const offsetMatch = raw.match(/\[offset:(-?\d+)\]/i);
    if (offsetMatch) offsetMs = parseInt(offsetMatch[1], 10) || 0;

    const lines: TimedLine[] = [];
    const plain: string[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
        const text = rawLine.replace(/\[[^\]\n]*\]/g, "").trim();
        if (!text) continue;
        plain.push(text);
        const tags = rawLine.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g);
        if (!tags) continue;
        for (const tag of tags) {
            const m = tag.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
            if (!m) continue;
            const minutes = parseInt(m[1], 10);
            const seconds = parseInt(m[2], 10);
            const fractionRaw = m[3] || "0";
            const fraction = parseInt(fractionRaw.padEnd(3, "0"), 10) / 1000;
            const time = Math.max(0, minutes * 60 + seconds + fraction - offsetMs / 1000);
            lines.push({ time, text });
        }
    }
    lines.sort((a, b) => a.time - b.time);
    return { lines, plain };
}

export function formatMusicTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Extract the numeric Netease song id from a MusicTrack id (`netease_123`). */
export function neteaseIdFromTrackId(trackId: string | undefined): number | null {
    if (!trackId || !trackId.startsWith("netease_")) return null;
    const id = parseInt(trackId.replace("netease_", ""), 10);
    return Number.isFinite(id) ? id : null;
}

/** Heart button that reads/writes the real Netease account. */
export function CloudLikeButton({ player }: { player: MusicControlsValue | null }) {
    const track = player?.currentTrack ?? null;
    const songId = neteaseIdFromTrackId(track?.id);
    const [liked, setLiked] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const requestSeq = useRef(0);

    useEffect(() => {
        setLiked(false);
        setMessage("");
        setBusy(false);
        if (!songId) return;
        const seq = ++requestSeq.current;
        getCloudSongLiked(songId).then(res => {
            if (seq !== requestSeq.current) return;
            if (res.ok) setLiked(res.liked);
        });
        return () => { requestSeq.current++; };
    }, [songId]);

    const toggle = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!songId || busy) return;
        const next = !liked;
        setBusy(true);
        const res = await setCloudSongLiked(songId, next);
        if (res.ok) {
            setLiked(next);
            setMessage("");
        } else {
            setMessage(res.message || "操作失败");
            window.setTimeout(() => setMessage(""), 2600);
        }
        setBusy(false);
    };

    if (!songId) {
        return (
            <button className="music-float-icon-btn" disabled title="本地歌曲不支持网易云红心" aria-label="红心">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
                </svg>
            </button>
        );
    }

    return (
        <div className="music-float-heart-wrap">
            <button
                className="music-float-icon-btn music-float-like"
                {...(liked ? { "data-active": "" } : {})}
                onClick={toggle}
                disabled={busy}
                title={busy ? "同步中..." : liked ? "取消红心" : "设为红心"}
                aria-label="红心"
            >
                <svg width="18" height="18" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
                </svg>
            </button>
            {message && <span className="music-float-heart-msg">{message}</span>}
        </div>
    );
}

/** "词" button used by the dynamic island card and the lyrics toolbar. */
export function DesktopLyricsButton({
    active,
    onClick,
}: {
    active?: boolean;
    onClick: (e: React.MouseEvent) => void;
}) {
    return (
        <button
            className="music-float-icon-btn music-float-lyrics-toggle"
            {...(active ? { "data-active": "" } : {})}
            onClick={onClick}
            title="桌面歌词"
            aria-label="桌面歌词"
        >
            词
        </button>
    );
}

export function MusicDesktopLyrics({
    visible,
    locked,
    hidden,
    onVisibleChange,
    onLockedChange,
}: {
    visible: boolean;
    locked: boolean;
    hidden?: boolean;
    onVisibleChange: (visible: boolean) => void;
    onLockedChange: (locked: boolean) => void;
}) {
    const player = useMusicPlayerOptional();
    const track = player?.currentTrack ?? null;
    const rootRef = useRef<HTMLDivElement>(null);

    const [pos, setPos] = useState<LyricsPosition | null>(() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = kvGet(LYRICS_POS_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as LyricsPosition;
            return Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y) ? parsed : null;
        } catch { return null; }
    });
    const [appearance, setAppearance] = useState<LyricsAppearance>(() => {
        if (typeof window === "undefined") return DEFAULT_APPEARANCE;
        try {
            const raw = kvGet(LYRICS_APPEARANCE_KEY);
            if (!raw) return DEFAULT_APPEARANCE;
            const parsed = JSON.parse(raw) as Partial<LyricsAppearance>;
            return {
                fontSize: clamp(Number(parsed.fontSize) || FONT_DEFAULT, FONT_MIN, FONT_MAX),
                color: LYRICS_COLORS.some(c => c.id === parsed.color) ? parsed.color as string : "white",
            };
        } catch { return DEFAULT_APPEARANCE; }
    });
    const [rawLyrics, setRawLyrics] = useState("");
    const [loading, setLoading] = useState(false);
    const [dragging, setDragging] = useState(false);

    const dragRef = useRef<{
        active: boolean; pointerId: number; startX: number; startY: number;
        origX: number; origY: number; moved: boolean; scaleX: number; scaleY: number;
    }>({ active: false, pointerId: 0, startX: 0, startY: 0, origX: 0, origY: 0, moved: false, scaleX: 1, scaleY: 1 });

    const trackId = track?.id;
    const trackLyrics = track?.lyrics;

    useEffect(() => {
        if (!trackId) { setRawLyrics(""); setLoading(false); return; }
        const inline = (trackLyrics || "").trim();
        if (inline) { setRawLyrics(inline); setLoading(false); return; }
        const songId = neteaseIdFromTrackId(trackId);
        if (!songId) { setRawLyrics(""); setLoading(false); return; }
        let cancelled = false;
        setLoading(true);
        getNeteaseLyrics(songId)
            .then(text => { if (!cancelled) setRawLyrics(text || ""); })
            .catch(() => { if (!cancelled) setRawLyrics(""); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [trackId, trackLyrics]);

    useEffect(() => {
        if (!visible || pos) return;
        const parent = rootRef.current?.closest("[data-ui='phone-screen']") as HTMLElement | null;
        if (!parent || !rootRef.current) return;
        const width = rootRef.current.offsetWidth || 320;
        setPos({
            x: Math.max(10, (parent.clientWidth - width) / 2),
            y: Math.max(60, parent.clientHeight * 0.24),
        });
    }, [visible, pos]);

    useEffect(() => {
        try { kvSet(LYRICS_APPEARANCE_KEY, JSON.stringify(appearance)); } catch { /* ignore */ }
    }, [appearance]);

    const parsed = useMemo(() => parseLyrics(rawLyrics), [rawLyrics]);
    const currentTime = player?.currentTime || 0;

    let currentText = "";
    let nextText = "";
    if (loading) {
        currentText = "歌词加载中…";
        nextText = "";
    } else if (!rawLyrics) {
        currentText = "暂无歌词";
        nextText = "";
    } else if (parsed.lines.length === 0) {
        currentText = parsed.plain[0] || "暂无歌词";
        nextText = parsed.plain[1] || "";
    } else {
        let index = -1;
        for (let i = 0; i < parsed.lines.length; i++) {
            if (parsed.lines[i].time <= currentTime) index = i;
            else break;
        }
        if (index < 0) {
            currentText = "前奏…";
            nextText = parsed.lines[0]?.text || "";
        } else {
            currentText = parsed.lines[index]?.text || "♪";
            nextText = parsed.lines[index + 1]?.text || "";
        }
    }

    const clampPosition = useCallback((x: number, y: number) => {
        const el = rootRef.current;
        if (!el) return { x, y };
        const parent = el.closest("[data-ui='phone-screen']") as HTMLElement | null;
        if (!parent) return { x, y };
        return {
            x: clamp(x, 0, Math.max(0, parent.clientWidth - el.offsetWidth)),
            y: clamp(y, 0, Math.max(0, parent.clientHeight - el.offsetHeight)),
        };
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (locked) return;
        const target = e.target as HTMLElement;
        if (target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        rootRef.current?.setPointerCapture?.(e.pointerId);
        const el = rootRef.current;
        const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
        const rect = el?.getBoundingClientRect();
        const scaleX = parent && rect ? (rect.width / Math.max(1, el!.offsetWidth)) : 1;
        const scaleY = parent && rect ? (rect.height / Math.max(1, el!.offsetHeight)) : 1;
        const origin = pos || { x: 0, y: 0 };
        dragRef.current = {
            active: true,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            origX: origin.x,
            origY: origin.y,
            moved: false,
            scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
            scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
        };
        setDragging(true);
    }, [locked, pos]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        const dx = (e.clientX - d.startX) / d.scaleX;
        const dy = (e.clientY - d.startY) / d.scaleY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        if (d.moved) setPos(clampPosition(d.origX + dx, d.origY + dy));
    }, [clampPosition]);

    const finishPointer = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        if (rootRef.current?.hasPointerCapture?.(e.pointerId)) {
            rootRef.current.releasePointerCapture(e.pointerId);
        }
        d.active = false;
        setDragging(false);
        if (d.moved && pos) {
            try { kvSet(LYRICS_POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
        }
    }, [pos]);

    const colorValue = LYRICS_COLORS.find(c => c.id === appearance.color)?.value || "#ffffff";
    const changeFont = (delta: number) => {
        setAppearance(prev => ({ ...prev, fontSize: clamp(prev.fontSize + delta, FONT_MIN, FONT_MAX) }));
    };

    if (!visible || hidden || !player || !track) return null;

    const style: React.CSSProperties = {
        color: colorValue,
        ...(pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }),
    };

    return (
        <div
            ref={rootRef}
            className="music-desktop-lyrics"
            data-color={appearance.color}
            {...(locked ? { "data-locked": "" } : {})}
            {...(dragging ? { "data-dragging": "" } : {})}
            style={style}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
        >
            <div className="music-desktop-lyrics-lines">
                <div className="music-desktop-lyrics-line" style={{ fontSize: `${appearance.fontSize}px` }}>{currentText}</div>
                {nextText && (
                    <div
                        className="music-desktop-lyrics-line"
                        data-next=""
                        style={{ fontSize: `${Math.max(FONT_MIN, appearance.fontSize - 4)}px` }}
                    >
                        {nextText}
                    </div>
                )}
            </div>

            {!locked && (
                <div className="music-desktop-lyrics-toolbar">
                    <button className="music-desktop-lyrics-btn" onClick={(e) => { e.stopPropagation(); onLockedChange(true); }} title="锁定歌词">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                        </svg>
                    </button>
                    <button className="music-desktop-lyrics-btn" onClick={(e) => { e.stopPropagation(); changeFont(-FONT_STEP); }} title="减小字号" disabled={appearance.fontSize <= FONT_MIN}>A−</button>
                    <button className="music-desktop-lyrics-btn" onClick={(e) => { e.stopPropagation(); changeFont(FONT_STEP); }} title="增大字号" disabled={appearance.fontSize >= FONT_MAX}>A＋</button>
                    <div className="music-desktop-lyrics-swatches">
                        {LYRICS_COLORS.map(c => (
                            <button
                                key={c.id}
                                className="music-desktop-lyrics-swatch"
                                style={{ background: c.value }}
                                {...(appearance.color === c.id ? { "data-on": "" } : {})}
                                onClick={(e) => { e.stopPropagation(); setAppearance(prev => ({ ...prev, color: c.id })); }}
                                title={`歌词颜色：${c.label}`}
                                aria-label={`歌词颜色：${c.label}`}
                            />
                        ))}
                    </div>
                    <button className="music-desktop-lyrics-btn music-desktop-lyrics-close" onClick={(e) => { e.stopPropagation(); onVisibleChange(false); }} title="关闭歌词">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>
            )}
        </div>
    );
}
