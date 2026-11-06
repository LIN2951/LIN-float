// components/music/music-float.tsx — Floating music widget (orb ball + top dynamic island)
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicPlayerOptional, type MusicControlsValue } from "@/lib/music-context";
import { MUSIC_FLOAT_MODE_EVENT, loadMusicFloatMode, type MusicFloatMode } from "@/lib/music-bg";
import {
    CloudLikeButton,
    DesktopLyricsButton,
    MusicDesktopLyrics,
    formatMusicTime,
} from "./music-desktop-lyrics";

/** Controls plus the high-frequency currentTime needed by the cards. */
type MusicFloatPlayer = MusicControlsValue & { currentTime: number };

const ORB_SIZE = 46;
const ORB_SIDE_GAP = 10;
const DRAG_START_THRESHOLD = 6;
const TUCK_DELAY = 2800;
const CLOSE_ANIM_MS = 220;
const ISLAND_RETRACT_MS = 210;

function phoneScreenOf(el: HTMLElement | null): HTMLElement | null {
    return el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
}

function clampValue(v: number, min: number, max: number) {
    return Math.max(min, Math.min(v, max));
}

function seekFromEvent(e: React.MouseEvent<HTMLElement>, player: MusicFloatPlayer) {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = clampValue((e.clientX - rect.left) / rect.width, 0, 1);
    player.seek((player.duration || 0) * ratio);
}

function WaveBars({ playing }: { playing?: boolean }) {
    return (
        <div className="music-wave-bars" {...(playing ? { "data-playing": "" } : {})} aria-hidden>
            <i /><i /><i />
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Orb mode
// ─────────────────────────────────────────────────────────────

function MusicFloatOrb({
    player,
}: {
    player: MusicFloatPlayer;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x: 320, y: 620 });
    const [side, setSide] = useState<"left" | "right">("right");
    const [expanded, setExpanded] = useState(false);
    const [tucked, setTucked] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [dismissing, setDismissing] = useState(false);
    const [activity, setActivity] = useState(0);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dragRef = useRef<{
        active: boolean; pointerId: number; startX: number; startY: number;
        origX: number; origY: number; moved: boolean; woke: boolean;
    }>({ active: false, pointerId: 0, startX: 0, startY: 0, origX: 0, origY: 0, moved: false, woke: false });

    const clampPos = useCallback((x: number, y: number) => {
        const el = rootRef.current;
        const parent = phoneScreenOf(el);
        if (!el || !parent) return { x, y };
        return {
            x: clampValue(x, 0, parent.clientWidth - ORB_SIZE),
            y: clampValue(y, 0, parent.clientHeight - ORB_SIZE),
        };
    }, []);

    // Keep the orb inside the virtual phone, including after container resize.
    useEffect(() => {
        const raf = requestAnimationFrame(() => setPos(p => clampPos(p.x, p.y)));
        return () => cancelAnimationFrame(raf);
    }, [clampPos]);

    // Auto tuck after being idle, unless expanded or being dragged.
    useEffect(() => {
        if (expanded || dragging || dismissing) {
            setTucked(false);
            return;
        }
        const timer = setTimeout(() => setTucked(true), TUCK_DELAY);
        return () => clearTimeout(timer);
    }, [expanded, dragging, dismissing, activity, pos]);

    useEffect(() => () => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        e.stopPropagation();
        const wasTucked = tucked;
        if (wasTucked) {
            setTucked(false);
            setActivity(a => a + 1);
        }
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        dragRef.current = {
            active: true,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            origX: pos.x,
            origY: pos.y,
            moved: false,
            woke: wasTucked,
        };
    }, [pos, tucked]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && (Math.abs(dx) > DRAG_START_THRESHOLD || Math.abs(dy) > DRAG_START_THRESHOLD)) {
            d.moved = true;
            setDragging(true);
            setTucked(false);
        }
        if (d.moved) setPos(clampPos(d.origX + dx, d.origY + dy));
    }, [clampPos]);

    const finishPointer = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        const orb = e.currentTarget as HTMLElement;
        if (orb.hasPointerCapture?.(e.pointerId)) {
            orb.releasePointerCapture(e.pointerId);
        }
        d.active = false;
        setDragging(false);
        setActivity(a => a + 1);

        if (d.moved) {
            const parent = phoneScreenOf(rootRef.current);
            if (parent) {
                const px = clampPos(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY)).x;
                const isLeft = px + ORB_SIZE / 2 < parent.clientWidth / 2;
                setSide(isLeft ? "left" : "right");
                setPos(prev => ({
                    x: isLeft ? ORB_SIDE_GAP : parent.clientWidth - ORB_SIZE - ORB_SIDE_GAP,
                    y: prev.y,
                }));
            }
            return;
        }

        if (d.woke) return; // first tap only wakes the tucked orb
        setExpanded(v => !v);
    }, [clampPos]);

    const handleClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        setDismissing(true);
        closeTimerRef.current = setTimeout(() => {
            player.stop();
            player.dismissFloat();
            setDismissing(false);
            setExpanded(false);
            closeTimerRef.current = null;
        }, CLOSE_ANIM_MS);
    }, [player]);

    const progressPct = player.duration > 0 ? clampValue(player.currentTime / player.duration, 0, 1) * 100 : 0;

    return (
        <div
            ref={rootRef}
            className="music-float"
            data-side={side}
            {...(expanded ? { "data-expanded": "" } : {})}
            {...(tucked ? { "data-tucked": "" } : {})}
            {...(dragging ? { "data-dragging": "" } : {})}
            {...(dismissing ? { "data-dismissing": "" } : {})}
            style={{ left: pos.x, top: pos.y }}
        >
            {expanded && (
                <div className="music-float-island" data-side={side} onPointerDown={e => e.stopPropagation()}>
                    <div className="music-float-card">
                        <button
                            className="music-float-card-cover"
                            onClick={(e) => { e.stopPropagation(); player.openFullPlayer(); }}
                            title="返回播放器"
                            aria-label="返回播放器"
                        >
                            {player.currentTrack?.coverUrl ? (
                                <img src={player.currentTrack.coverUrl} alt="" draggable={false} />
                            ) : (
                                <span className="music-float-cover-glyph">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                    </svg>
                                </span>
                            )}
                        </button>

                        <div className="music-float-card-info">
                            <div className="music-float-title">{player.currentTrack?.title}</div>
                            <div className="music-float-artist">{player.currentTrack?.artist}</div>
                        </div>

                        <WaveBars playing={player.isPlaying} />
                    </div>

                    <div className="music-float-progress-row">
                        <span className="music-float-time">{formatMusicTime(player.currentTime)}</span>
                        <div
                            className="music-float-progress"
                            onClick={(e) => { e.stopPropagation(); seekFromEvent(e, player); }}
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(progressPct)}
                        >
                            <span className="music-float-progress-fill" style={{ width: `${progressPct}%` }} />
                        </div>
                        <span className="music-float-time">{formatMusicTime(player.duration)}</span>
                    </div>

                    <div className="music-float-card-controls">
                        <button className="music-float-ctrl" onClick={(e) => { e.stopPropagation(); player.prev(); }} title="上一首">
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                        </button>
                        <button className="music-float-ctrl music-float-ctrl-play" onClick={(e) => { e.stopPropagation(); player.togglePlay(); }} title={player.isPlaying ? "暂停" : "播放"}>
                            {player.isPlaying ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                            )}
                        </button>
                        <button className="music-float-ctrl" onClick={(e) => { e.stopPropagation(); player.next(); }} title="下一首">
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" /></svg>
                        </button>
                    </div>
                </div>
            )}

            <div
                className="music-float-orb"
                {...(player.isPlaying ? { "data-playing": "" } : {})}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={finishPointer}
                title={expanded ? "收起" : "展开"}
            >
                {player.currentTrack?.coverUrl ? (
                    <img src={player.currentTrack.coverUrl} alt="" className="music-float-cover-img" draggable={false} />
                ) : (
                    <span className="music-float-cover-glyph">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                        </svg>
                    </span>
                )}
                <span className="music-float-orb-wave"><WaveBars playing={player.isPlaying} /></span>
            </div>

            {expanded && (
                <button className="music-float-close" onClick={handleClose} title="关闭音乐">
                    关闭
                </button>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Top dynamic island mode
// ─────────────────────────────────────────────────────────────

function MusicFloatIsland({
    player,
    lyricsVisible,
    onToggleLyrics,
}: {
    player: MusicFloatPlayer;
    lyricsVisible: boolean;
    onToggleLyrics: (e: React.MouseEvent) => void;
}) {
    const [expanded, setExpanded] = useState(false); // false = pill, true = card
    const [closing, setClosing] = useState(false);
    const retractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (retractTimerRef.current) clearTimeout(retractTimerRef.current);
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    }, []);

    const expand = () => {
        if (closing) return;
        setExpanded(true);
    };

    const collapse = () => {
        if (!expanded || closing) return;
        setClosing(true);
        retractTimerRef.current = setTimeout(() => {
            setExpanded(false);
            setClosing(false);
            retractTimerRef.current = null;
        }, ISLAND_RETRACT_MS);
    };

    const closePlayback = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        setClosing(true);
        closeTimerRef.current = setTimeout(() => {
            player.stop();
            player.dismissFloat();
            setExpanded(false);
            setClosing(false);
            closeTimerRef.current = null;
        }, ISLAND_RETRACT_MS);
    };

    const progressPct = player.duration > 0 ? clampValue(player.currentTime / player.duration, 0, 1) * 100 : 0;

    return (
        <div className="music-island-root">
            {!expanded && (
                <button className="music-status-island" onClick={expand} title="展开音乐控制">
                    <span className="music-status-island-cover">
                        {player.currentTrack?.coverUrl ? (
                            <img src={player.currentTrack.coverUrl} alt="" draggable={false} />
                        ) : (
                            <span className="music-float-cover-glyph">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                </svg>
                            </span>
                        )}
                    </span>
                    <span className="music-status-island-title">{player.currentTrack?.title}</span>
                    <WaveBars playing={player.isPlaying} />
                </button>
            )}

            {expanded && (
                <>
                    <div className="music-island-scrim" onClick={collapse} />
                    <div
                        className="music-dynamic-island-panel"
                        {...(closing ? { "data-closing": "" } : {})}
                        onClick={() => player.openFullPlayer()}
                    >
                        <div className="music-dynamic-island-content">
                            <div className="music-dynamic-island-top">
                                <span className="music-dynamic-island-cover">
                                    {player.currentTrack?.coverUrl ? (
                                        <img src={player.currentTrack.coverUrl} alt="" draggable={false} />
                                    ) : (
                                        <span className="music-float-cover-glyph">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                            </svg>
                                        </span>
                                    )}
                                </span>
                                <div className="music-dynamic-island-info">
                                    <div className="music-dynamic-island-title">{player.currentTrack?.title}</div>
                                    <div className="music-dynamic-island-artist">{player.currentTrack?.artist}</div>
                                </div>
                                <button className="music-dynamic-island-close" onClick={closePlayback} title="关闭音乐" aria-label="关闭音乐">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                </button>
                            </div>

                            <div className="music-dynamic-island-progress-row" onClick={(e) => e.stopPropagation()}>
                                <span className="music-dynamic-island-time">{formatMusicTime(player.currentTime)}</span>
                                <div
                                    className="music-dynamic-island-progress"
                                    onClick={(e) => { e.stopPropagation(); seekFromEvent(e, player); }}
                                    role="progressbar"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(progressPct)}
                                >
                                    <span className="music-dynamic-island-progress-fill" style={{ width: `${progressPct}%` }} />
                                </div>
                                <span className="music-dynamic-island-time">{formatMusicTime(player.duration)}</span>
                            </div>

                            <div className="music-dynamic-island-controls">
                                <DesktopLyricsButton active={lyricsVisible} onClick={onToggleLyrics} />
                                <button className="music-float-icon-btn" onClick={(e) => { e.stopPropagation(); player.prev(); }} title="上一首">
                                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                                </button>
                                <button className="music-float-icon-btn music-float-ctrl-play" onClick={(e) => { e.stopPropagation(); player.togglePlay(); }} title={player.isPlaying ? "暂停" : "播放"}>
                                    {player.isPlaying ? (
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
                                    ) : (
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                                    )}
                                </button>
                                <button className="music-float-icon-btn" onClick={(e) => { e.stopPropagation(); player.next(); }} title="下一首">
                                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" /></svg>
                                </button>
                                <CloudLikeButton player={player} />
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Composed entry
// ─────────────────────────────────────────────────────────────

export default function MusicFloat({ hidden }: { hidden?: boolean }) {
    const player = useMusicPlayerOptional();
    const [mode, setMode] = useState<MusicFloatMode>("orb");
    const [lyricsVisible, setLyricsVisible] = useState(false);
    const [lyricsLocked, setLyricsLocked] = useState(false);

    useEffect(() => {
        setMode(loadMusicFloatMode());
        const onChange = () => setMode(loadMusicFloatMode());
        window.addEventListener(MUSIC_FLOAT_MODE_EVENT, onChange);
        return () => window.removeEventListener(MUSIC_FLOAT_MODE_EVENT, onChange);
    }, []);

    const toggleLyrics = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setLyricsVisible(prev => {
            if (!prev) {
                setLyricsLocked(false);
                return true;
            }
            if (lyricsLocked) {
                setLyricsLocked(false);
                return true;
            }
            return false;
        });
    }, [lyricsLocked]);

    const shouldHide = Boolean(hidden || player?.floatDismissed);
    const active = player && player.currentTrack ? player : null;

    return (
        <>
            {active && !shouldHide && mode === "orb" && (
                <MusicFloatOrb player={active} />
            )}
            {active && !shouldHide && mode === "island" && (
                <MusicFloatIsland player={active} lyricsVisible={lyricsVisible} onToggleLyrics={toggleLyrics} />
            )}
            <MusicDesktopLyrics
                visible={lyricsVisible}
                locked={lyricsLocked}
                hidden={shouldHide}
                onVisibleChange={setLyricsVisible}
                onLockedChange={setLyricsLocked}
            />
        </>
    );
}
