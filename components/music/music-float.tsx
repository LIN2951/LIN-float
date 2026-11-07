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
import {
    DEFAULT_MUSIC_ISLAND_COLOR,
    MUSIC_ISLAND_COLOR_EVENT,
    hexToRgba,
    islandColorValue,
    loadMusicIslandColor,
    resolveTrackAccent,
    type MusicIslandColorSettings,
} from "@/lib/music-island-color";

/** Controls plus the high-frequency currentTime needed by the cards. */
type MusicFloatPlayer = MusicControlsValue & { currentTime: number };

const ORB_SIDE_GAP = 10;
const DRAG_START_THRESHOLD = 6;
const TUCK_DELAY = 2800;
const CLOSE_ANIM_MS = 220;
const ISLAND_RETRACT_MS = 210;
const SWIPE_THRESHOLD = 26;

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

function CoverFallback({ size }: { size: number }) {
    return (
        <span className="music-float-cover-glyph">
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
            </svg>
        </span>
    );
}

/** 上一首 / 下一首按钮：直接调用播放器切歌，不做任何延时或弹层跳转。 */
function TrackStepButton({
    dir,
    player,
    children,
    className,
}: {
    dir: "prev" | "next";
    player: MusicFloatPlayer;
    children: React.ReactNode;
    className?: string;
}) {
    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (dir === "prev") player.prevTrack();
        else player.next();
    };
    return (
        <button
            type="button"
            className={className}
            onClick={handleClick}
            aria-label={dir === "prev" ? "上一首" : "下一首"}
            title={dir === "prev" ? "上一首" : "下一首"}
        >
            {children}
        </button>
    );
}

/** 播放 / 暂停按钮：只负责暂停与继续，永远不切歌。 */
function PlayPauseButton({
    player,
    className,
}: {
    player: MusicFloatPlayer;
    className?: string;
}) {
    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        player.togglePlay();
    };
    return (
        <button
            type="button"
            className={className}
            onClick={handleClick}
            aria-label={player.isPlaying ? "暂停" : "播放"}
            title={player.isPlaying ? "暂停" : "播放"}
        >
            {player.isPlaying ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
            ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
        </button>
    );
}

function PrevIcon() {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>;
}

function NextIcon() {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" /></svg>;
}

// ─────────────────────────────────────────────────────────────
// Orb mode（悬浮球）
// ─────────────────────────────────────────────────────────────

function MusicFloatOrb({
    player,
    sizes,
    hideWave,
    accent,
    accentSoft,
}: {
    player: MusicFloatPlayer;
    sizes: MusicFloatSizes;
    hideWave?: boolean;
    accent?: string;
    accentSoft?: string;
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
    const dragRef = useRef({
        active: false,
        pointerId: 0,
        startX: 0,
        startY: 0,
        origX: 0,
        origY: 0,
        moved: false,
        woke: false,
    });

    const clampPos = useCallback((x: number, y: number) => {
        const el = rootRef.current;
        const parent = phoneScreenOf(el);
        if (!el || !parent) return { x, y };
        return {
            x: clampValue(x, 0, parent.clientWidth - sizes.orb),
            y: clampValue(y, 0, parent.clientHeight - sizes.orb),
        };
    }, [sizes.orb]);

    // 容器尺寸变化后把球拉回可视范围
    useEffect(() => {
        const raf = requestAnimationFrame(() => setPos(p => clampPos(p.x, p.y)));
        return () => cancelAnimationFrame(raf);
    }, [clampPos]);

    // 静置收边
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
        if (e.pointerType === "mouse" && e.button !== 0) return;
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
        if (orb.hasPointerCapture?.(e.pointerId)) orb.releasePointerCapture(e.pointerId);
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

        if (d.woke) return; // 收边状态第一次点按只唤醒
        setExpanded(v => !v);
    }, [clampPos, sizes.orb]);

    const cancelPointer = useCallback(() => {
        dragRef.current.active = false;
        setDragging(false);
    }, []);

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
                "--mi-accent": accent || "#ffffff",
                "--mi-accent-soft": accentSoft || "rgba(255, 255, 255, 0.08)",
            } as React.CSSProperties}
        >
            {expanded && (
                <div
                    className="music-float-island"
                    data-side={side}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => e.stopPropagation()}
                >
                    <div className="music-float-card">
                        <button
                            type="button"
                            className="music-float-card-cover"
                            onClick={(e) => { e.stopPropagation(); player.openFullPlayer(); }}
                            title="返回播放器"
                            aria-label="返回播放器"
                        >
                            {player.currentTrack?.coverUrl ? (
                                <img src={player.currentTrack.coverUrl} alt="" draggable={false} />
                            ) : (
                                <CoverFallback size={16} />
                            )}
                        </button>

                        <div className="music-float-card-info">
                            <div className="music-float-title">{player.currentTrack?.title}</div>
                            <div className="music-float-artist">{player.currentTrack?.artist}</div>
                        </div>

                        {!hideWave && <WaveBars playing={player.isPlaying} />}
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
                        <TrackStepButton dir="prev" player={player} className="music-float-ctrl">
                            <PrevIcon />
                        </TrackStepButton>
                        <PlayPauseButton player={player} className="music-float-ctrl music-float-ctrl-play" />
                        <TrackStepButton dir="next" player={player} className="music-float-ctrl">
                            <NextIcon />
                        </TrackStepButton>
                    </div>
                </div>
            )}

            <div
                className="music-float-orb"
                {...(player.isPlaying ? { "data-playing": "" } : {})}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={cancelPointer}
                title={expanded ? "收起" : "展开"}
            >
                {player.currentTrack?.coverUrl ? (
                    <img src={player.currentTrack.coverUrl} alt="" className="music-float-cover-img" draggable={false} />
                ) : (
                    <CoverFallback size={16} />
                )}
                {!hideWave && <span className="music-float-orb-wave"><WaveBars playing={player.isPlaying} /></span>}
            </div>

            {expanded && (
                <button type="button" className="music-float-close" onClick={handleClose} title="关闭音乐">
                    关闭
                </button>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Top dynamic island mode（灵动岛）
// ─────────────────────────────────────────────────────────────

function MusicFloatIsland({
    player,
    sizes,
    lyricsVisible,
    onToggleLyrics,
    hideWave,
    accent,
    accentSoft,
}: {
    player: MusicFloatPlayer;
    sizes: MusicFloatSizes;
    lyricsVisible: boolean;
    onToggleLyrics: (e: React.MouseEvent) => void;
    hideWave?: boolean;
    accent?: string;
    accentSoft?: string;
}) {
    const [expanded, setExpanded] = useState(false);
    const [closing, setClosing] = useState(false);
    const [hint, setHint] = useState<{ dir: "prev" | "next"; title: string } | null>(null);
    const retractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gestureRef = useRef({ active: false, pointerId: 0, x: 0, y: 0, swiping: false });

    useEffect(() => () => {
        if (retractTimerRef.current) clearTimeout(retractTimerRef.current);
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    }, []);

    const neighborTitle = useCallback((dir: "prev" | "next") => {
        const queue = player.queue;
        if (!queue.length) return "";
        const idx = queue.findIndex(t => t.id === player.currentTrack?.id);
        if (idx < 0) return queue[dir === "prev" ? queue.length - 1 : 0]?.title || "";
        const nextIdx = dir === "prev"
            ? (idx - 1 + queue.length) % queue.length
            : (idx + 1) % queue.length;
        return queue[nextIdx]?.title || "";
    }, [player.queue, player.currentTrack?.id]);

    const expand = useCallback(() => {
        if (closing) return;
        setExpanded(true);
    }, [closing]);

    const collapse = useCallback(() => {
        if (!expanded || closing) return;
        setClosing(true);
        retractTimerRef.current = setTimeout(() => {
            setExpanded(false);
            setClosing(false);
            retractTimerRef.current = null;
        }, ISLAND_RETRACT_MS);
    }, [expanded, closing]);

    const closePlayback = useCallback((e: React.MouseEvent) => {
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
    }, [player]);

    /** 左右滑动切歌：左滑上一首、右滑下一首，立即切歌，提示只显示歌名。 */
    const runSwipe = useCallback((dx: number) => {
        const dir: "prev" | "next" = dx < 0 ? "prev" : "next";
        setHint({ dir, title: neighborTitle(dir) });
        if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
        hintTimerRef.current = setTimeout(() => {
            setHint(null);
            hintTimerRef.current = null;
        }, 1400);
        if (dir === "prev") player.prevTrack();
        else player.next();
    }, [neighborTitle, player]);

    // 收起胶囊：不用 onClick，全部在 pointerup 里判定「滑动 / 点击」，
    // 避免 pointer capture 与 click 互相吞事件。
    const pillDown = (e: React.PointerEvent) => {
        if (closing) return;
        gestureRef.current = { active: true, pointerId: e.pointerId, x: e.clientX, y: e.clientY, swiping: false };
    };

    const pillMove = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g.active || g.pointerId !== e.pointerId) return;
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (!g.swiping && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            g.swiping = true;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }
    };

    const pillUp = (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g.active || g.pointerId !== e.pointerId) return;
        g.active = false;
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
        if (g.swiping) {
            g.swiping = false;
            runSwipe(e.clientX - g.x);
            return;
        }
        expand();
    };

    const pillCancel = () => {
        gestureRef.current = { active: false, pointerId: 0, x: 0, y: 0, swiping: false };
    };

    const progressPct = player.duration > 0 ? clampValue(player.currentTime / player.duration, 0, 1) * 100 : 0;

    return (
        <div
            className="music-island-root"
            style={{
                "--mi-accent": accent || "#ffffff",
                "--mi-accent-soft": accentSoft || "rgba(255, 255, 255, 0.08)",
            } as React.CSSProperties}
        >
            {!expanded && (
                <div
                    className="music-status-island"
                    role="button"
                    tabIndex={0}
                    onPointerDown={pillDown}
                    onPointerMove={pillMove}
                    onPointerUp={pillUp}
                    onPointerCancel={pillCancel}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            expand();
                        } else if (e.key === "ArrowLeft") {
                            e.preventDefault();
                            runSwipe(-1);
                        } else if (e.key === "ArrowRight") {
                            e.preventDefault();
                            runSwipe(1);
                        }
                    }}
                    title="展开音乐控制；左滑上一首、右滑下一首"
                >
                    {hint ? (
                        <span className="music-island-swipe-hint" data-dir={hint.dir}>
                            <span className="music-island-swipe-arrow">{hint.dir === "prev" ? "‹" : "›"}</span>
                            <span className="music-island-swipe-title">{hint.title}</span>
                        </span>
                    ) : (
                        <>
                            <span className="music-status-island-cover">
                                {player.currentTrack?.coverUrl ? (
                                    <img src={player.currentTrack.coverUrl} alt="" draggable={false} />
                                ) : (
                                    <CoverFallback size={12} />
                                )}
                            </span>
                            <span className="music-status-island-title">{player.currentTrack?.title}</span>
                            {!hideWave && <WaveBars playing={player.isPlaying} />}
                        </>
                    )}
                </div>
            )}

            {expanded && (
                <>
                    <div className="music-island-scrim" onClick={collapse} />
                    <div
                        className="music-dynamic-island-panel"
                        {...(closing ? { "data-closing": "" } : {})}
                        style={{ width: sizes.islandWidth, height: sizes.islandHeight }}
                        onClick={() => player.openFullPlayer()}
                    >
                        <div className="music-dynamic-island-content">
                            <div className="music-dynamic-island-top">
                                <span className="music-dynamic-island-cover">
                                    {player.currentTrack?.coverUrl ? (
                                        <img src={player.currentTrack.coverUrl} alt="" draggable={false} />
                                    ) : (
                                        <CoverFallback size={14} />
                                    )}
                                </span>
                                <div className="music-dynamic-island-info">
                                    <div className="music-dynamic-island-title">{player.currentTrack?.title}</div>
                                    <div className="music-dynamic-island-artist">{player.currentTrack?.artist}</div>
                                </div>
                                <button
                                    type="button"
                                    className="music-dynamic-island-close"
                                    onClick={closePlayback}
                                    title="关闭音乐"
                                    aria-label="关闭音乐"
                                >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
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
                                <TrackStepButton dir="prev" player={player} className="music-float-icon-btn">
                                    <PrevIcon />
                                </TrackStepButton>
                                <PlayPauseButton player={player} className="music-float-icon-btn music-float-ctrl-play" />
                                <TrackStepButton dir="next" player={player} className="music-float-icon-btn">
                                    <NextIcon />
                                </TrackStepButton>
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
    const [sizes, setSizes] = useState<MusicFloatSizes>(DEFAULT_MUSIC_FLOAT_SIZES);
    const [visible, setVisible] = useState<MusicFloatVisibility>(DEFAULT_MUSIC_FLOAT_VISIBILITY);
    const [lyricsVisible, setLyricsVisible] = useState(false);
    const [lyricsLocked, setLyricsLocked] = useState(false);
    const [islandColor, setIslandColor] = useState<MusicIslandColorSettings>(DEFAULT_MUSIC_ISLAND_COLOR);
    const [accent, setAccent] = useState("#ffffff");

    useEffect(() => {
        setIslandColor(loadMusicIslandColor());
        const onColorChange = () => setIslandColor(loadMusicIslandColor());
        window.addEventListener(MUSIC_ISLAND_COLOR_EVENT, onColorChange);
        return () => window.removeEventListener(MUSIC_ISLAND_COLOR_EVENT, onColorChange);
    }, []);

    useEffect(() => {
        if (islandColor.mode === "fixed") {
            setAccent(islandColorValue(islandColor.color));
            return;
        }
        const track = player?.currentTrack;
        if (!track) {
            setAccent("#ffffff");
            return;
        }
        let cancelled = false;
        setAccent("#ffffff");
        resolveTrackAccent(track.id, track.coverUrl).then(color => {
            if (!cancelled) setAccent(color);
        });
        return () => { cancelled = true; };
    }, [islandColor.mode, islandColor.color, player?.currentTrack?.id, player?.currentTrack?.coverUrl]);

    const accentSoft = hexToRgba(
        accent,
        islandColor.mode === "fixed" ? (islandColor.color === "white" ? 0.06 : 0.22) : 0.2,
    );

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
                <MusicFloatOrb
                    player={active}
                    sizes={sizes}
                    hideWave={islandColor.hideWave}
                    accent={accent}
                    accentSoft={accentSoft}
                />
            )}
            {active && !shouldHide && visible.island && (mode === "island" || mode === "both") && (
                <MusicFloatIsland
                    player={active}
                    sizes={sizes}
                    lyricsVisible={lyricsVisible}
                    onToggleLyrics={toggleLyrics}
                    hideWave={islandColor.hideWave}
                    accent={accent}
                    accentSoft={accentSoft}
                />
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
