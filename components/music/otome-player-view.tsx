// components/music/otome-player-view.tsx — Inline "乙女抓" player inside the
// Music app. Pastes a YouTube / DLsite / Reddit link, resolves metadata through
// the server, then routes playback through the global music context so it stays
// linked to the float bar / full player and keeps playing after leaving.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { detectPlatform, PLATFORM_LABELS, type ParsedLink } from "@/lib/music-links";
import type { MusicTrack } from "@/lib/music-storage";
import { useMusicPlayer, MUSIC_PLAYBACK_ERROR_EVENT } from "@/lib/music-context";
import { showOtomeVideo, hideOtomeVideo, subscribeOtomeVideo, getOtomeVideoSnapshot } from "@/lib/otome-video";

interface ResolveData {
    ok: boolean;
    playable: boolean;
    message?: string;
    track?: {
        id: string;
        title: string;
        artist: string;
        duration?: number;
        coverUrl?: string;
        source: "youtube" | "dlsite" | "reddit";
        externalId?: string;
        sampleUrl?: string;
        streamUrl?: string;
        streamFallbackUrl?: string;
        sourceUrl?: string;
    };
}

interface LrcLine { time: number; text: string }

function parseLrc(lrc: string): LrcLine[] {
    const out: LrcLine[] = [];
    for (const line of (lrc || "").split("\n")) {
        const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
        if (m) {
            const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
            const text = m[3].trim();
            if (text) out.push({ time: t, text });
        }
    }
    return out.sort((a, b) => a.time - b.time);
}

function isYoutubeTrack(t: MusicTrack | null | undefined): boolean {
    return !!t && (t.source === "youtube" || t.id?.startsWith("yt_"));
}

type Props = { onBack: () => void };

export default function OtomePlayerView({ onBack }: Props) {
    const player = useMusicPlayer();
    const videoVisible = useSyncExternalStore(subscribeOtomeVideo, getOtomeVideoSnapshot, getOtomeVideoSnapshot);

    const [input, setInput] = useState("");
    const [detected, setDetected] = useState<ParsedLink | null>(null);
    const [loading, setLoading] = useState(false);
    const [current, setCurrent] = useState<MusicTrack | null>(null);
    const [lyrics, setLyrics] = useState("");
    const [showSub, setShowSub] = useState(false);
    const [subLoading, setSubLoading] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((text: string, ms = 2800) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(text);
        toastTimerRef.current = setTimeout(() => setToast(null), ms);
    }, []);

    useEffect(() => () => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    }, []);

    // Surface playback errors from the global engine (neutral, non-red toast).
    useEffect(() => {
        const onErr = (e: Event) => {
            const msg = (e as CustomEvent<string>).detail;
            if (msg) showToast(msg, 3600);
        };
        window.addEventListener(MUSIC_PLAYBACK_ERROR_EVENT, onErr);
        return () => window.removeEventListener(MUSIC_PLAYBACK_ERROR_EVENT, onErr);
    }, [showToast]);

    const onInputChange = useCallback((value: string) => {
        setInput(value);
        setDetected(detectPlatform(value));
    }, []);

    const fetchCaptions = useCallback(async (track: MusicTrack) => {
        if (!isYoutubeTrack(track) || !track.externalId) return;
        setSubLoading(true);
        try {
            const res = await fetch(`/api/music/captions?videoId=${encodeURIComponent(track.externalId)}`);
            const data = await res.json() as { ok: boolean; lrc?: string; message?: string };
            if (data.ok && data.lrc) {
                setLyrics(data.lrc);
                player.patchTrack(track.id, { lyrics: data.lrc });
            }
        } catch {
            // caption fetch is best-effort
        } finally {
            setSubLoading(false);
        }
    }, [player]);

    const play = useCallback(async () => {
        if (!detected) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/music/resolve?url=${encodeURIComponent(detected.canonicalUrl)}`);
            const data = await res.json() as ResolveData;
            if (!data.ok || !data.track) {
                showToast(data.message || "无法解析该链接");
                setLoading(false);
                return;
            }
            const meta = data.track;
            const track: MusicTrack = {
                id: meta.id,
                title: meta.title || "未命名",
                artist: meta.artist || PLATFORM_LABELS[meta.source],
                duration: meta.duration || 0,
                coverUrl: meta.coverUrl,
                source: meta.source,
                externalId: meta.externalId,
                sampleUrl: meta.sampleUrl,
                streamUrl: meta.streamUrl,
                streamFallbackUrl: meta.streamFallbackUrl,
                canonicalUrl: meta.sourceUrl,
                lyrics: "",
                liked: false,
                addedAt: new Date().toISOString(),
            };
            setCurrent(track);
            setLyrics("");
            setShowSub(false);
            setLoading(false);
            hideOtomeVideo();
            player.playTrack(track);
            if (data.message) showToast(data.message);
            void fetchCaptions(track);
        } catch {
            showToast("网络错误，解析失败");
            setLoading(false);
        }
    }, [detected, fetchCaptions, player, showToast]);

    const setVideoMode = useCallback((video: boolean) => {
        if (video) {
            if (!current || !isYoutubeTrack(current)) {
                showToast("该链接暂不支持视频画面，将以音频播放");
                return;
            }
            showOtomeVideo();
        } else {
            hideOtomeVideo();
        }
    }, [current, showToast]);

    const parsedLyrics = useMemo(() => parseLrc(lyrics), [lyrics]);
    const activeLyricIdx = useMemo(() => {
        if (parsedLyrics.length === 0) return -1;
        let idx = -1;
        for (let i = 0; i < parsedLyrics.length; i++) {
            if (player.currentTime >= parsedLyrics[i].time) idx = i;
            else break;
        }
        return idx;
    }, [parsedLyrics, player.currentTime]);

    const isCurrentPlayingThis = !!current && player.currentTrack?.id === current.id;
    const playing = isCurrentPlayingThis && player.isPlaying;
    const platformLabel = detected ? PLATFORM_LABELS[detected.platform] : null;

    return (
        <div className="otome-view">
            {/* Header */}
            <div className="otome-view-header">
                <button className="otome-back" onClick={onBack} title="返回">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>
                <div className="otome-view-title">
                    <span className="otome-view-logo">乙女抓<span>·</span>播放器</span>
                </div>
            </div>

            {/* Link input */}
            <div className="otome-input-row">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <input
                    className="otome-input"
                    placeholder="粘贴 YouTube / DLsite / Reddit 链接"
                    value={input}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={e => onInputChange(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && detected && !loading) void play(); }}
                />
                <button className="otome-play-btn" disabled={!detected || loading} onClick={() => void play()}>
                    {loading ? "加载中…" : "播放"}
                </button>
            </div>
            <div className="otome-hint">
                {platformLabel && detected ? (
                    <span className="otome-chip" data-p={detected.platform}>{platformLabel}</span>
                ) : null}
                <span>支持 youtu.be / youtube.com / dlsite.com / reddit 链接</span>
            </div>

            {/* Now playing card */}
            {current && (
                <div className="otome-card">
                    <div className="otome-card-meta">
                        {current.coverUrl ? (
                            <img className="otome-cover" src={current.coverUrl} alt="" />
                        ) : (
                            <div className="otome-cover otome-cover-ph">
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                </svg>
                            </div>
                        )}
                        <div className="otome-card-info">
                            <div className="otome-card-title">{current.title}</div>
                            <div className="otome-card-artist">{current.artist}</div>
                            <div className="otome-card-badge">
                                <span className="otome-live-dot" data-playing={playing ? "" : undefined} />
                                {playing ? "正在播放" : "已就绪"}
                                <span className="otome-link-note">已联动到音乐</span>
                            </div>
                        </div>
                    </div>

                    {/* Mode switch */}
                    <div className="otome-mode">
                        <div className="otome-seg">
                            <button
                                type="button"
                                className={!videoVisible ? "active" : ""}
                                onClick={() => setVideoMode(false)}
                            >
                                音频
                            </button>
                            <button
                                type="button"
                                className={videoVisible ? "active" : ""}
                                onClick={() => setVideoMode(true)}
                            >
                                视频
                            </button>
                        </div>
                        <div className="otome-mode-actions">
                            <button className="otome-ghost-btn" onClick={() => player.openFullPlayer()} title="在完整播放器中打开">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                </svg>
                                完整播放器
                            </button>
                            <button
                                className="otome-ghost-btn"
                                disabled={!isYoutubeTrack(current) || subLoading}
                                onClick={() => {
                                    if (!isYoutubeTrack(current)) return;
                                    setShowSub(prev => !prev);
                                }}
                                title="字幕"
                            >
                                {subLoading ? "抓取中…" : (showSub ? "隐藏字幕" : "字幕")}
                            </button>
                        </div>
                    </div>

                    {/* Subtitle panel */}
                    {showSub && (
                        <div className="otome-sub">
                            {parsedLyrics.length === 0 ? (
                                <div className="otome-sub-empty">暂未抓取到字幕，可用视频右下角 CC 查看</div>
                            ) : (
                                parsedLyrics.map((line, i) => (
                                    <div key={i} className="otome-sub-line" data-active={i === activeLyricIdx ? "" : undefined}>
                                        <b>{formatLrcTime(line.time)}</b>
                                        <span>{line.text}</span>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
            )}

            {toast && <div className="otome-toast">{toast}</div>}
        </div>
    );
}

function formatLrcTime(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
}