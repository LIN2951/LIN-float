// components/music/music-float.tsx — Floating music widget (orb ball + top dynamic island)
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicPlayerOptional, type MusicControlsValue } from "@/lib/music-context";
import {
    DEFAULT_MUSIC_FLOAT_SIZES,
    DEFAULT_MUSIC_FLOAT_VISIBILITY,
    MUSIC_FLOAT_MODE_EVENT,
    MUSIC_FLOAT_SIZES_EVENT,
    MUSIC_FLOAT_VISIBILITY_EVENT,
    loadMusicFloatMode,
    loadMusicFloatSizes,
    loadMusicFloatVisibility,
    type MusicFloatMode,
    type MusicFloatSizes,
    type MusicFloatVisibility,
} from "@/lib/music-bg";
import {
    CloudLikeButton,
    DesktopLyricsButton,
    MusicDesktopLyrics,
    formatMusicTime,
} from "./music-desktop-lyrics";

/** Controls plus the high-frequency currentTime needed by the cards. */
type MusicFloatPlayer = MusicControlsValue & { currentTime: number };

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
    sizes,
}: {
    player: MusicFloatPlayer;
    sizes: MusicFloatSizes;
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
            x: clampValue(x, 0, parent.clientWidth - sizes.orb),
            y: clampValue(y, 0, parent.clientHeight - sizes.orb),
        };
    }, [sizes.orb]);

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
                const isLeft = px + sizes.orb / 2 < parent.clientWidth / 2;
                setSide(isLeft ? "left" : "right");
                setPos(prev => ({
                    x: isLeft ? ORB_SIDE_GAP : parent.clientWidth - sizes.orb - ORB_SIDE_GAP,
                    y: prev.y,
                }));
            }
            return;
        }

        if (d.woke) return; // first tap only wakes the tucked orb
        setExpanded(v => !v);
    }, [clampPos, sizes.orb]);

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
            style={{
                left: pos.x,
                top: pos.y,
                width: sizes.orb,
                height: sizes.orb,
                "--mf-card-w": `${sizes.orbCardWidth}px`,
                "--mf-card-h": `${sizes.orbCardHeight}px`,
            } as React.CSSProperties}
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
    sizes,
    lyricsVisible,
    onToggleLyrics,
}: {
    player: MusicFloatPlayer;
    sizes: MusicFloatSizes;
    lyricsVisible: boolean;
    onToggleLyrics: (e: React.MouseEvent) => void;
}) {
    const [expanded, setExpanded] = useState(false); // false = pill, true = card
    const [closing, setClosing] = useState(false);
    const [swipeHint, setSwipeHint] = useState<{ dir: "prev" | "next"; title: string } | null>(null);
    const retractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressClickRef = useRef(false);
    const swipeRef = useRef({ active: false, x: 0, y: 0, moved: false });

    useEffect(() => () => {
        if (retractTimerRef.current) clearTimeout(retractTimerRef.current);
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
        if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    }, []);

    const expand = () => {
        if (swipeRef.current.moved) return;
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

    const neighborTrack = (dir: "prev" | "next") => {
        const queue = player.queue;
        if (!queue.length) return null;
        const idx = queue.findIndex(t => t.id === player.currentTrack?.id);
        if (idx < 0) return null;
        return dir === "prev"
            ? queue[(idx - 1 + queue.length) % queue.length]
            : queue[(idx + 1) % queue.length];
    };

    const runSwipe = (dir: "prev" | "next") => {
        const target = neighborTrack(dir);
        setSwipeHint({ dir, title: target?.title || "" });
        if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
        if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
        actionTimerRef.current = setTimeout(() => {
            if (dir === "prev") player.prev();
            else player.next();
            actionTimerRef.current = null;
        }, 140);
        hintTimerRef.current = setTimeout(() => {
            setSwipeHint(null);
            hintTimerRef.current = null;
        }, 1500);
    };

    const beginSwipe = (e: React.PointerEvent) => {
        if (closing) return;
        const target = e.target as HTMLElement;
        const isPill = (e.currentTarget as HTMLElement).classList.contains("music-status-island");
        if (!isPill && target.closest("button")) return;
        swipeRef.current = { active: true, x: e.clientX, y: e.clientY, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    };

    const moveSwipe = (e: React.PointerEvent) => {
        const s = swipeRef.current;
        if (!s.active) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy)) s.moved = true;
    };

    const finishSwipe = (e: React.PointerEvent) => {
        const s = swipeRef.current;
        if (!s.active) return;
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
        s.active = false;
        if (!s.moved) return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) <= 34) return;
        suppressClickRef.current = true;
        // Left swipe = previous, right swipe = next (as requested).
        runSwipe(dx < 0 ? "prev" : "next");
        window.setTimeout(() => {
            swipeRef.current.moved = false;
            suppressClickRef.current = false;
        }, 400);
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
                <button
                    className="music-status-island"
                    onClick={() => {
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        expand();
                    }}
                    onPointerDown={beginSwipe}
                    onPointerMove={moveSwipe}
                    onPointerUp={finishSwipe}
                    onPointerCancel={finishSwipe}
                    title="展开音乐控制；左右滑动切换歌曲"
                >
                    {swipeHint ? (
                        <span className="music-island-swipe-hint" data-dir={swipeHint.dir}>
                            <span className="music-island-swipe-arrow">{swipeHint.dir === "prev" ? "‹" : "›"}</span>
                            <span className="music-island-swipe-title">{swipeHint.title}</span>
                        </span>
                    ) : (
                        <>
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
                        </>
                    )}
                </button>
            )}

            {expanded && (
                <>
                    <div className="music-island-scrim" onClick={collapse} />
                    <div
                        className="music-dynamic-island-panel"
                        {...(closing ? { "data-closing": "" } : {})}
                        style={{
                            width: sizes.islandWidth,
                            height: sizes.islandHeight,
                        }}
                        onClick={() => {
                            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                            player.openFullPlayer();
                        }}
                        onPointerDown={beginSwipe}
                        onPointerMove={moveSwipe}
                        onPointerUp={finishSwipe}
                        onPointerCancel={finishSwipe}
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
                                    onClick={(e) => { e.stopPropagation(); if (suppressClickRef.current) return; seekFromEvent(e, player); }}
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
                        {swipeHint && (
                            <div className="music-island-swipe-hint" data-dir={swipeHint.dir} data-overlay>
                                <span className="music-island-swipe-arrow">{swipeHint.dir === "prev" ? "‹" : "›"}</span>
                                <span className="music-island-swipe-title">{swipeHint.title}</span>
                            </div>
                        )}
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
    const [sizes, setSizes] = useState<MusicFloatSizes>(DEFAULT_MUSIC_FLOAT_SIZES);
    const [visible, setVisible] = useState<MusicFloatVisibility>(DEFAULT_MUSIC_FLOAT_VISIBILITY);
    const [lyricsVisible, setLyricsVisible] = useState(false);
    const [lyricsLocked, setLyricsLocked] = useState(false);

    useEffect(() => {
        setMode(loadMusicFloatMode());
        setSizes(loadMusicFloatSizes());
        setVisible(loadMusicFloatVisibility());
        const onModeChange = () => setMode(loadMusicFloatMode());
        const onSizesChange = () => setSizes(loadMusicFloatSizes());
        const onVisibilityChange = () => setVisible(loadMusicFloatVisibility());
        window.addEventListener(MUSIC_FLOAT_MODE_EVENT, onModeChange);
        window.addEventListener(MUSIC_FLOAT_SIZES_EVENT, onSizesChange);
        window.addEventListener(MUSIC_FLOAT_VISIBILITY_EVENT, onVisibilityChange);
        return () => {
            window.removeEventListener(MUSIC_FLOAT_MODE_EVENT, onModeChange);
            window.removeEventListener(MUSIC_FLOAT_SIZES_EVENT, onSizesChange);
            window.removeEventListener(MUSIC_FLOAT_VISIBILITY_EVENT, onVisibilityChange);
        };
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
            {active && !shouldHide && visible.orb && (mode === "orb" || mode === "both") && (
                <MusicFloatOrb player={active} sizes={sizes} />
            )}
            {active && !shouldHide && visible.island && (mode === "island" || mode === "both") && (
                <MusicFloatIsland player={active} sizes={sizes} lyricsVisible={lyricsVisible} onToggleLyrics={toggleLyrics} />
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
