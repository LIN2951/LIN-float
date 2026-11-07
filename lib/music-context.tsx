// lib/music-context.tsx — Global music playback state & <audio> management
"use client";

import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { MusicTrack } from "./music-storage";
import { getAudioBlob, markTrackPlayed } from "./music-storage";
import { findPlayableMatch, getNeteaseLyrics, getNeteasePlayUrl, getNeteasePlayInfo, getNeteaseSongDetail, loadMusicSourceConfig } from "./music-service";
import { getFreePlayUrl, resolveFreeServerUrl } from "./music-free-source";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { registerMusicControlBridge } from "./music-control-bridge";
import { applyMusicTheme, loadMusicTheme, MUSIC_THEME_EVENT } from "./music-bg";
import { ytEngine } from "./youtube-engine";

/** Fired when an external link track has no playable source. */
export const MUSIC_PLAYBACK_ERROR_EVENT = "music-playback-error";

// ── Types ──

export type PlayMode = "sequence" | "shuffle" | "repeat-one";

export type MusicState = {
    currentTrack: MusicTrack | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    playMode: PlayMode;
    queue: MusicTrack[];
    volume: number;
    showFullPlayer: boolean;
    floatDismissed: boolean;
};

export type MusicActions = {
    playTrack: (track: MusicTrack) => void;
    playUrl: (url: string, track: MusicTrack) => void; // play from URL (online streams)
    pause: () => void;
    resume: () => void;
    togglePlay: () => void;
    next: () => void;
    prev: () => void;
    /** Always jump to the previous track (never restarts the current song). */
    prevTrack: () => void;
    seek: (time: number) => void;
    setPlayMode: (mode: PlayMode) => void;
    setQueue: (tracks: MusicTrack[]) => void;
    removeFromQueue: (trackId: string) => void;
    setVolume: (vol: number) => void;
    stop: () => void;
    dismissFloat: () => void;
    openFullPlayer: () => void;
    closeFullPlayer: () => void;
    /** Patch metadata of the current/queued track (used after caption import). */
    patchTrack: (trackId: string, patch: Partial<MusicTrack>) => void;
};

type MusicContextValue = MusicState & MusicActions;
export type MusicControlsValue = Omit<MusicContextValue, "currentTime">;

const MusicContext = createContext<MusicContextValue | null>(null);
const MusicControlsContext = createContext<MusicControlsValue | null>(null);

export function useMusicPlayer(): MusicContextValue {
    const ctx = useContext(MusicContext);
    if (!ctx) throw new Error("useMusicPlayer must be used within <MusicProvider>");
    return ctx;
}

// Optional: use in components that may render outside provider
export function useMusicPlayerOptional(): MusicContextValue | null {
    return useContext(MusicContext);
}

export function useMusicControls(): MusicControlsValue {
    const ctx = useContext(MusicControlsContext);
    if (!ctx) throw new Error("useMusicControls must be used within <MusicProvider>");
    return ctx;
}

export function useMusicControlsOptional(): MusicControlsValue | null {
    return useContext(MusicControlsContext);
}

// ── Queue persistence ──

const QUEUE_STORAGE_KEY = "ai_phone_music_queue_v1";
registerKvMigration(QUEUE_STORAGE_KEY);
const QUEUE_MAX_SIZE = 200;

function loadPersistedQueue(): MusicTrack[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(QUEUE_STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.slice(0, QUEUE_MAX_SIZE) : [];
    } catch { return []; }
}

function persistQueue(q: MusicTrack[]): void {
    try { kvSet(QUEUE_STORAGE_KEY, JSON.stringify(q.slice(0, QUEUE_MAX_SIZE))); } catch { /* ignore */ }
}

// ── Provider ──

export function MusicProvider({ children }: { children: ReactNode }) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const blobUrlRef = useRef<string | null>(null);
    // Which engine currently owns playback: the <audio> element or hidden YT iframe.
    const activeEngineRef = useRef<"audio" | "yt">("audio");
    const isPlayingRef = useRef(false);
    const currentTrackRef = useRef<MusicTrack | null>(null);
    const currentTimeRef = useRef(0);
    const durationRef = useRef(0);
    const fallbackTriedRef = useRef(false);
    const handleTrackEndRef = useRef<() => void>(() => {});
    // 切歌时 audio.pause() 会触发 pause 事件，不能把「正在切歌」误判成用户暂停。
    const switchingRef = useRef(false);
    const queueRef = useRef<MusicTrack[]>([]);
    const loadAndPlayRef = useRef<(track: MusicTrack) => void>(() => {});

    const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playMode, setPlayMode] = useState<PlayMode>("sequence");
    const [queue, setQueueRaw] = useState<MusicTrack[]>(() => loadPersistedQueue());
    const [volume, setVolumeState] = useState(0.8);
    const [showFullPlayer, setShowFullPlayer] = useState(false);
    const [floatDismissed, setFloatDismissed] = useState(false);

    // Apply the persisted music theme (dark / light) globally on mount.
    useEffect(() => {
        applyMusicTheme(loadMusicTheme());
        const onChange = () => applyMusicTheme(loadMusicTheme());
        window.addEventListener(MUSIC_THEME_EVENT, onChange);
        return () => window.removeEventListener(MUSIC_THEME_EVENT, onChange);
    }, []);

    // Persist queue on change.
    useEffect(() => {
        persistQueue(queue);
    }, [queue]);

    /** Wrapped setQueue with max size enforcement */
    const setQueue = useCallback((tracks: MusicTrack[]) => {
        setQueueRaw(tracks.slice(0, QUEUE_MAX_SIZE));
    }, []);

    const notifyPlaybackError = useCallback((message: string) => {
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(MUSIC_PLAYBACK_ERROR_EVENT, { detail: message }));
        }
    }, []);

    // Initialize audio element once
    useEffect(() => {
        const audio = new Audio();
        audio.volume = 0.8;
        audio.preload = "auto";
        audio.setAttribute("playsinline", "");
        // 常驻 DOM（隐藏），安卓 Chrome 更容易识别为「正在播放」并生成下拉通知栏媒体卡片
        audio.style.display = "none";
        try { document.body.appendChild(audio); } catch { /* ignore */ }
        audioRef.current = audio;

        audio.addEventListener("timeupdate", () => {
            setCurrentTime(audio.currentTime);
        });
        audio.addEventListener("loadedmetadata", () => {
            setDuration(audio.duration || 0);
        });
        audio.addEventListener("ended", () => {
            handleTrackEndRef.current();
        });
        audio.addEventListener("pause", () => {
            if (switchingRef.current) return; // 切歌过程中的暂停不算用户暂停
            setIsPlaying(false);
        });
        audio.addEventListener("play", () => setIsPlaying(true));
        audio.addEventListener("error", () => {
            if (activeEngineRef.current !== "audio") return;
            const track = currentTrackRef.current;
            if (!track) return;
            // Reddit DASH audio guess may 404 — try the muxed fallback once.
            if (!fallbackTriedRef.current && track.streamFallbackUrl && track.streamUrl
                && audio.src && audio.src !== track.streamFallbackUrl) {
                fallbackTriedRef.current = true;
                audio.src = track.streamFallbackUrl;
                audio.play().catch(() => {});
                return;
            }
            if (track.source === "dlsite") {
                notifyPlaybackError("试听片段加载失败，可能已被 DLsite 调整，可重新解析链接或上传正版 MP3");
            } else if (track.source === "reddit") {
                notifyPlaybackError("Reddit 音轨加载失败（部分视频音画分离且不允许跨域播放）");
            }
        });

        // Bridge the hidden YouTube IFrame engine into the same state shape.
        ytEngine.setCallbacks({
            onPlaying: () => setIsPlaying(true),
            onPaused: () => { if (!switchingRef.current) setIsPlaying(false); },
            onTime: (t) => setCurrentTime(t),
            onDuration: (d) => setDuration(d),
            onEnded: () => handleTrackEndRef.current(),
            onError: (code) => {
                const messages: Record<number, string> = {
                    2: "YouTube 播放器参数错误",
                    5: "该视频不允许嵌入播放，请在 YouTube 中打开",
                    100: "视频不存在或已被删除",
                    101: "视频所有者禁止嵌入播放",
                    150: "视频所有者禁止嵌入播放",
                };
                notifyPlaybackError(messages[code] || `YouTube 播放失败（错误码 ${code}）`);
            },
        });

        return () => {
            audio.pause();
            audio.src = "";
            try { audio.remove(); } catch { /* ignore */ }
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
            ytEngine.stop();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [notifyPlaybackError]);

    // Keep refs mirrored for use inside engine/audio callbacks.
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
    useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
    useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
    useEffect(() => { durationRef.current = duration; }, [duration]);

    // ── Media Session：把播放信息同步到真实手机的状态栏/锁屏媒体卡片 ──
    // 卡片上的播放/暂停/上一首/下一首/拖动进度都会路由回这里的播放器，
    // 效果与网易云音乐等原生 App 一致（Chrome/Edge + 安卓 PWA 均支持）。
    const mediaActionsRef = useRef<{
        resume: () => void; pause: () => void; next: () => void; prevTrack: () => void; seek: (t: number) => void;
    }>({ resume: () => {}, pause: () => {}, next: () => {}, prevTrack: () => {}, seek: () => {} });

    useEffect(() => {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
            try { ms.setActionHandler(action, handler); } catch { /* 个别 action 某些平台不支持 */ }
        };
        bind("play", () => mediaActionsRef.current.resume());
        bind("pause", () => mediaActionsRef.current.pause());
        bind("stop", () => mediaActionsRef.current.pause());
        bind("nexttrack", () => mediaActionsRef.current.next());
        bind("previoustrack", () => mediaActionsRef.current.prevTrack());
        bind("seekto", (details) => {
            if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
                mediaActionsRef.current.seek(details.seekTime);
            }
        });
        bind("seekbackward", (details) => {
            const offset = details.seekOffset ?? 10;
            mediaActionsRef.current.seek(Math.max(0, currentTimeRef.current - offset));
        });
        bind("seekforward", (details) => {
            const offset = details.seekOffset ?? 10;
            const max = durationRef.current > 0 ? durationRef.current : Number.MAX_SAFE_INTEGER;
            mediaActionsRef.current.seek(Math.min(max, currentTimeRef.current + offset));
        });
        return () => {
            bind("play", null);
            bind("pause", null);
            bind("stop", null);
            bind("nexttrack", null);
            bind("previoustrack", null);
            bind("seekto", null);
            bind("seekbackward", null);
            bind("seekforward", null);
        };
    }, []);

    // 同步系统媒体卡片的标题/歌手/封面与播放状态
    useEffect(() => {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        if (!currentTrack) {
            try { ms.metadata = null; } catch { /* ignore */ }
            try { ms.playbackState = "none"; } catch { /* ignore */ }
            return;
        }
        try {
            ms.metadata = new MediaMetadata({
                title: currentTrack.title || "未知歌曲",
                artist: currentTrack.artist || "未知歌手",
                album: "Float 音乐",
                artwork: currentTrack.coverUrl
                    ? [{ src: currentTrack.coverUrl, sizes: "512x512" }]
                    : [],
            });
        } catch { /* ignore */ }
        try { ms.playbackState = isPlaying ? "playing" : "paused"; } catch { /* ignore */ }
    }, [currentTrack, isPlaying]);

    // 同步系统媒体卡片的进度条（支持系统侧拖进度）
    useEffect(() => {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        if (typeof ms.setPositionState !== "function") return;
        if (!currentTrack || !Number.isFinite(duration) || duration <= 0) return;
        try {
            ms.setPositionState({
                duration,
                playbackRate: 1,
                position: Math.max(0, Math.min(currentTime, duration)),
            });
        } catch { /* position 超出范围等平台差异，忽略 */ }
    }, [currentTrack, currentTime, duration]);


    const playModeRef = useRef(playMode);
    useEffect(() => { playModeRef.current = playMode; }, [playMode]);

    // 播放结束 → 按播放模式自动切下一首。
    // 注意：这里必须只读 ref、只做副作用，不能把 setState 套进另一个 setState 的
    // updater 里（原来的写法在 React 18 下 updater 可能不执行，导致一首歌放完就停）。
    const handleTrackEnd = useCallback(() => {
        const q = queueRef.current;
        if (q.length === 0) {
            setIsPlaying(false);
            return;
        }
        const cur = currentTrackRef.current;
        const idx = cur ? q.findIndex(t => t.id === cur.id) : -1;
        const mode = playModeRef.current;

        let nextTrack: MusicTrack | null = null;
        if (mode === "repeat-one") {
            nextTrack = cur;
        } else if (mode === "shuffle") {
            nextTrack = q.length > 1
                ? q[Math.floor(Math.random() * q.length)]
                : q[0];
        } else {
            const nextIdx = idx < 0 ? 0 : idx + 1;
            nextTrack = nextIdx < q.length ? q[nextIdx] : null;
        }

        if (nextTrack) {
            loadAndPlayRef.current(nextTrack);
        } else {
            setIsPlaying(false);
            setCurrentTime(durationRef.current || 0);
        }
    }, []);

    // Latest end-handler for the audio element / YT engine callbacks.
    useEffect(() => { handleTrackEndRef.current = handleTrackEnd; }, [handleTrackEnd]);
    useEffect(() => { queueRef.current = queue; }, [queue]);

    const cleanupBlobUrl = useCallback(() => {
        if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }
    }, []);

    const loadAndPlay = useCallback(async (trackInput: MusicTrack) => {
        const audio = audioRef.current;
        if (!audio) return;
        let track = trackInput;

        switchingRef.current = true;
        cleanupBlobUrl();
        audio.pause();

        // 先把当前歌曲切过去（歌名/封面/进度条立即变化），再去解析播放地址。
        // 否则在线歌曲要等接口返回 1~2 秒，看起来像「点了没反应」。
        activeEngineRef.current = "audio";
        setCurrentTrack(track);
        setCurrentTime(0);
        setDuration(track.duration || 0);

        // ── YouTube: hidden IFrame engine ──
        if (track.source === "youtube" || track.id.startsWith("yt_")) {
            activeEngineRef.current = "yt";
            const videoId = track.externalId || track.id.replace(/^yt_/, "");
            setIsPlaying(false);
            const playedAt = new Date().toISOString();
            void markTrackPlayed(track.id, playedAt).catch(() => undefined);
            try {
                await ytEngine.load(videoId);
            } catch {
                notifyPlaybackError("YouTube 播放器加载失败，请检查网络后重试");
            } finally {
                switchingRef.current = false;
            }
            return;
        }

        // ── Everything else goes through the HTMLAudioElement ──
        ytEngine.pause();
        fallbackTriedRef.current = false;

        let shouldMarkPlayed = false;

        if (track.id.startsWith("netease_")) {
            // Netease tracks: fetch play URL from API
            const nid = parseInt(track.id.replace("netease_", ""), 10);
            const srcCfg = loadMusicSourceConfig();
            const src = srcCfg.source;
            const bases = srcCfg.freeBases;
            let playUrl: string | null = null;
            if (src === "free") {
                playUrl = await getFreePlayUrl(track, bases);
            } else {
                playUrl = await getNeteasePlayUrl(nid);
                // Netease returned nothing (VIP / no copyright) — try the free
                // aggregation source so the song can still play fully.
                if (!playUrl) playUrl = await getFreePlayUrl(track, bases);
            }
            if (!playUrl) {
                notifyPlaybackError("该歌曲暂无可用播放源");
                switchingRef.current = false;
                setIsPlaying(false);
                return;
            }
            audio.src = playUrl;
            // 从队列切歌时，队列里的歌可能还没有封面/歌词，这里补齐，
            // 保证灵动岛取色、歌词面板都能跟上当前歌曲。
            if (!track.coverUrl || !track.lyrics) {
                void Promise.all([
                    getNeteaseSongDetail(nid).catch(() => null),
                    getNeteaseLyrics(nid).catch(() => ""),
                ]).then(([detail, lyrics]) => {
                    const patch: Partial<MusicTrack> = {};
                    if (detail?.coverUrl && !track.coverUrl) patch.coverUrl = detail.coverUrl;
                    if (detail?.name) patch.title = detail.name;
                    if (detail?.artists) patch.artist = detail.artists;
                    if (lyrics && !track.lyrics) patch.lyrics = lyrics;
                    if (Object.keys(patch).length === 0) return;
                    setCurrentTrack(prev => (prev && prev.id === track.id ? { ...prev, ...patch } : prev));
                    setQueueRaw(prev => {
                        const nextQueue = prev.map(item => (
                            item.id === track.id ? { ...item, ...patch } : item
                        ));
                        persistQueue(nextQueue);
                        return nextQueue;
                    });
                });
            }
        } else if (track.source === "dlsite") {
            // Purchased MP3 bound to this link first; otherwise the trial clip.
            const blob = await getAudioBlob(track.id);
            if (blob) {
                const url = URL.createObjectURL(blob);
                blobUrlRef.current = url;
                audio.src = url;
                shouldMarkPlayed = true;
            } else if (track.sampleUrl) {
                audio.src = track.sampleUrl;
            } else {
                notifyPlaybackError("该 DLsite 作品没有试听片段，可上传购买的正版 MP3 绑定后播放");
                switchingRef.current = false;
                return;
            }
        } else if (track.source === "reddit") {
            if (track.streamUrl) {
                audio.src = track.streamUrl;
            } else if (track.streamFallbackUrl) {
                audio.src = track.streamFallbackUrl;
                fallbackTriedRef.current = true;
            } else {
                notifyPlaybackError("该 Reddit 帖子没有可播放的音轨");
                switchingRef.current = false;
                return;
            }
        } else if (track.id.startsWith("gd_")) {
            // GD音乐：免费多平台直链。id 形如 gd_<server>:<songId>，按需实时解析。
            const rest = track.id.slice(3);
            const sep = rest.indexOf(":");
            const server = sep > 0 ? rest.slice(0, sep) : "netease";
            const sid = sep > 0 ? rest.slice(sep + 1) : rest;
            const direct = await resolveFreeServerUrl(server, sid, track.title, track.artist);
            if (!direct) {
                notifyPlaybackError("该歌曲暂无可用免费源，换一首试试");
                switchingRef.current = false;
                setIsPlaying(false);
                return;
            }
            audio.src = direct;
        } else {
            // Local tracks: load blob from IndexedDB
            const blob = await getAudioBlob(track.id);
            if (!blob) {
                switchingRef.current = false;
                setIsPlaying(false);
                return;
            }
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            audio.src = url;
            shouldMarkPlayed = true;
        }

        if (shouldMarkPlayed) {
            const playedAt = new Date().toISOString();
            void markTrackPlayed(track.id, playedAt).catch(() => undefined);
            track = { ...track, lastPlayedAt: playedAt };
        }

        setCurrentTrack(track);
        setCurrentTime(0);

        try {
            await audio.play();
        } catch {
            // Autoplay blocked — user interaction needed
        } finally {
            switchingRef.current = false;
        }
    }, [cleanupBlobUrl, notifyPlaybackError]);

    useEffect(() => { loadAndPlayRef.current = (t) => { void loadAndPlay(t); }; }, [loadAndPlay]);

    const playTrack = useCallback((track: MusicTrack) => {
        setFloatDismissed(false);
        loadAndPlay(track);
    }, [loadAndPlay]);

    /** Play from a direct URL (for online streaming) */
    const playUrl = useCallback((url: string, track: MusicTrack) => {
        const audio = audioRef.current;
        if (!audio) return;
        setFloatDismissed(false);
        activeEngineRef.current = "audio";
        ytEngine.pause();
        fallbackTriedRef.current = false;
        switchingRef.current = true;
        cleanupBlobUrl();
        audio.pause();
        audio.src = url;
        setCurrentTrack(track);
        setCurrentTime(0);
        setDuration(track.duration || 0);
        audio.play()
            .catch(() => {})
            .finally(() => { switchingRef.current = false; });
    }, [cleanupBlobUrl]);

    const pause = useCallback(() => {
        if (activeEngineRef.current === "yt") {
            ytEngine.pause();
        } else {
            audioRef.current?.pause();
        }
    }, []);

    const resume = useCallback(() => {
        if (activeEngineRef.current === "yt") {
            ytEngine.play();
        } else {
            audioRef.current?.play().catch(() => {});
        }
    }, []);

    const togglePlay = useCallback(() => {
        if (activeEngineRef.current === "yt") {
            if (isPlayingRef.current) ytEngine.pause();
            else ytEngine.play();
            return;
        }
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    }, []);

    const seek = useCallback((time: number) => {
        const audio = audioRef.current;
        const maxDuration = activeEngineRef.current === "yt"
            ? duration
            : (Number.isFinite(audio?.duration) && audio!.duration > 0 ? audio!.duration : duration);
        const clamped = Math.max(0, Math.min(time, maxDuration > 0 ? maxDuration : time));
        setCurrentTime(clamped);
        if (activeEngineRef.current === "yt") {
            ytEngine.seekTo(clamped);
        } else if (audio) {
            audio.currentTime = clamped;
        }
    }, [duration]);

    const next = useCallback(() => {
        if (queue.length === 0 || !currentTrack) return;
        // 当前歌曲不在队列里（例如链接点播）时，从队列第一首开始播
        const idx = queue.findIndex(t => t.id === currentTrack.id);
        let nextIdx: number;
        if (playMode === "shuffle") {
            nextIdx = Math.floor(Math.random() * queue.length);
        } else {
            nextIdx = idx < 0 ? 0 : (idx + 1) % queue.length;
        }
        loadAndPlay(queue[nextIdx]);
    }, [queue, currentTrack, playMode, loadAndPlay]);

    const prev = useCallback(() => {
        if (queue.length === 0 || !currentTrack) return;
        // If more than 3s into the song, restart it (works for both engines)
        if (currentTime > 3) {
            seek(0);
            return;
        }
        const idx = queue.findIndex(t => t.id === currentTrack.id);
        let prevIdx: number;
        if (playMode === "shuffle") {
            prevIdx = Math.floor(Math.random() * queue.length);
        } else {
            prevIdx = (idx - 1 + queue.length) % queue.length;
        }
        loadAndPlay(queue[prevIdx]);
    }, [queue, currentTrack, currentTime, playMode, loadAndPlay, seek]);

    // Always switch to the previous track, regardless of playback position.
    const prevTrack = useCallback(() => {
        if (queue.length === 0 || !currentTrack) return;
        const idx = queue.findIndex(t => t.id === currentTrack.id);
        const prevIdx = playMode === "shuffle"
            ? Math.floor(Math.random() * queue.length)
            : idx < 0
                ? queue.length - 1
                : (idx - 1 + queue.length) % queue.length;
        loadAndPlay(queue[prevIdx]);
    }, [queue, currentTrack, playMode, loadAndPlay]);

    // 让系统媒体卡片（通知栏/锁屏）的按钮始终调用最新的播放控制
    useEffect(() => {
        mediaActionsRef.current = { resume, pause, next, prevTrack, seek };
    }, [resume, pause, next, prevTrack, seek]);

    const setVolume = useCallback((vol: number) => {
        const clamped = Math.max(0, Math.min(1, vol));
        setVolumeState(clamped);
        if (audioRef.current) audioRef.current.volume = clamped;
        ytEngine.setVolume(clamped);
    }, []);

    const stop = useCallback(() => {
        switchingRef.current = false;
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
        ytEngine.stop();
        activeEngineRef.current = "audio";
        cleanupBlobUrl();
        setCurrentTrack(null);
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setShowFullPlayer(false);
    }, [cleanupBlobUrl]);

    const removeFromQueue = useCallback((trackId: string) => {
        setQueueRaw(prev => {
            const next = prev.filter(t => t.id !== trackId);
            persistQueue(next);
            return next;
        });
    }, []);

    const dismissFloat = useCallback(() => {
        if (activeEngineRef.current === "yt") ytEngine.pause();
        else audioRef.current?.pause();
        setFloatDismissed(true);
    }, []);

    const openFullPlayer = useCallback(() => { setFloatDismissed(false); setShowFullPlayer(true); }, []);
    const closeFullPlayer = useCallback(() => setShowFullPlayer(false), []);

    /** Patch a track in the current playback slot and persisted queue. */
    const patchTrack = useCallback((trackId: string, patch: Partial<MusicTrack>) => {
        setCurrentTrack(prev => (prev && prev.id === trackId ? { ...prev, ...patch } : prev));
        setQueueRaw(prev => {
            const next = prev.map(t => (t.id === trackId ? { ...t, ...patch } : t));
            persistQueue(next);
            return next;
        });
    }, []);

    const playResolvedTrack = useCallback(async (track: MusicTrack): Promise<{ ok: boolean; message: string; track?: MusicTrack }> => {
        setFloatDismissed(false);
        setQueueRaw(prev => prev.some(item => item.id === track.id) ? prev : [track, ...prev]);

        if (track.id.startsWith("netease_")) {
            const nid = parseInt(track.id.replace("netease_", ""), 10);
            const srcCfg = loadMusicSourceConfig();
            const src = srcCfg.source;
            const bases = srcCfg.freeBases;
            let url: string | null = null;
            if (src === "free") {
                url = await getFreePlayUrl(track, bases);
            } else {
                const info = await getNeteasePlayInfo(nid);
                url = info.url;
                if (!url) url = await getFreePlayUrl(track, bases);
            }
            if (!url) return { ok: false, message: "该歌曲暂无可用播放源" };
            const [detail, lyrics] = await Promise.all([
                getNeteaseSongDetail(nid).catch(() => null),
                getNeteaseLyrics(nid).catch(() => ""),
            ]);
            const resolvedTrack: MusicTrack = {
                ...track,
                title: detail?.name || track.title,
                artist: detail?.artists || track.artist,
                coverUrl: detail?.coverUrl || track.coverUrl,
                lyrics: lyrics || track.lyrics,
            };
            playUrl(url, resolvedTrack);
            return { ok: true, message: `正在播放「${resolvedTrack.title}」`, track: resolvedTrack };
        }

        playTrack(track);
        return { ok: true, message: `正在播放「${track.title}」`, track };
    }, [playTrack, playUrl]);

    const playByQuery = useCallback(async (query: string, artist?: string): Promise<{ ok: boolean; message: string; track?: MusicTrack }> => {
        const found = await findPlayableMatch(query, artist);
        if (!found) return { ok: false, message: "没有找到可播放的音乐" };
        const { result, playUrl: onlineUrl } = found;
        if (result.source === "local" && result.localTrack) {
            return playResolvedTrack(result.localTrack);
        }
        if (result.source === "netease" && result.neteaseResult && onlineUrl) {
            const r = result.neteaseResult;
            const [detail, lyrics] = await Promise.all([
                getNeteaseSongDetail(r.id).catch(() => null),
                getNeteaseLyrics(r.id).catch(() => ""),
            ]);
            const track: MusicTrack = {
                id: `netease_${r.id}`,
                title: detail?.name || r.name,
                artist: detail?.artists || r.artists,
                duration: r.duration / 1000,
                coverUrl: detail?.coverUrl || r.coverUrl,
                lyrics,
                liked: false,
                addedAt: new Date().toISOString(),
            };
            setFloatDismissed(false);
            setQueueRaw(prev => prev.some(item => item.id === track.id) ? prev : [track, ...prev]);
            playUrl(onlineUrl, track);
            return { ok: true, message: `正在播放「${track.title}」`, track };
        }
        return { ok: false, message: "没有找到可播放的音乐" };
    }, [playResolvedTrack, playUrl]);

    const addToQueue = useCallback(async (
        tracksToAdd: MusicTrack[],
        options?: { replace?: boolean; playFirst?: boolean },
    ): Promise<{ ok: boolean; message: string; queue: MusicTrack[] }> => {
        const cleanTracks = tracksToAdd.filter(track => track.id && track.title);
        if (cleanTracks.length === 0) return { ok: false, message: "没有可加入播放列表的歌曲", queue };

        const base = options?.replace ? [] : queue;
        const seen = new Set(base.map(track => track.id));
        const merged = [...base];
        for (const track of cleanTracks) {
            if (seen.has(track.id)) continue;
            seen.add(track.id);
            merged.push(track);
        }
        const nextQueue = merged.slice(0, QUEUE_MAX_SIZE);
        setQueueRaw(nextQueue);

        if (options?.playFirst) {
            await playResolvedTrack(cleanTracks[0]);
        }

        return {
            ok: true,
            message: options?.replace ? `已替换播放列表，共 ${cleanTracks.length} 首` : `已加入播放列表，共 ${cleanTracks.length} 首`,
            queue: nextQueue.length > 0 ? nextQueue : cleanTracks,
        };
    }, [playResolvedTrack, queue]);

    useEffect(() => {
        registerMusicControlBridge({
            getState: () => ({
                currentTrack,
                isPlaying,
                currentTime,
                duration,
                playMode,
                queue,
                volume,
            }),
            playTrack: playResolvedTrack,
            playByQuery,
            addToQueue,
            pause,
            resume,
            stop,
            next,
            prev,
            prevTrack,
            setPlayMode,
        });
        return () => registerMusicControlBridge(null);
    }, [
        currentTrack, isPlaying, currentTime, duration, playMode, queue, volume,
        playResolvedTrack, playByQuery, addToQueue, pause, resume, stop, next, prev, prevTrack, setPlayMode,
    ]);

    const controlsValue = useMemo<MusicControlsValue>(() => ({
        currentTrack, isPlaying, duration, playMode, queue, volume, showFullPlayer, floatDismissed,
        playTrack, playUrl, pause, resume, togglePlay, next, prev, prevTrack, seek,
        setPlayMode, setQueue, removeFromQueue, setVolume, stop, dismissFloat, openFullPlayer, closeFullPlayer,
        patchTrack,
    }), [
        currentTrack, isPlaying, duration, playMode, queue, volume, showFullPlayer, floatDismissed,
        playTrack, playUrl, pause, resume, togglePlay, next, prev, prevTrack, seek,
        setQueue, removeFromQueue, setVolume, stop, dismissFloat, openFullPlayer, closeFullPlayer,
        patchTrack,
    ]);

    const value = useMemo<MusicContextValue>(() => ({
        ...controlsValue,
        currentTime,
    }), [controlsValue, currentTime]);

    return (
        <MusicControlsContext.Provider value={controlsValue}>
            <MusicContext.Provider value={value}>
                {children}
            </MusicContext.Provider>
        </MusicControlsContext.Provider>
    );
}
