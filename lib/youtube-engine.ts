// lib/youtube-engine.ts — Hidden YouTube IFrame player singleton.
// Plays YouTube videos as "audio only": the IFrame is rendered off-screen
// (never display:none — YouTube refuses to start in a hidden container).
// All transport controls are bridged through callbacks into music-context.
// A "video mode" repositions the same iframe host over a visible region so
// the audio and video stay perfectly in sync with the global music state.
"use client";

export interface VideoRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

type EngineCallbacks = {
    onPlaying?: () => void;
    onPaused?: () => void;
    onEnded?: () => void;
    onTime?: (seconds: number) => void;
    onDuration?: (seconds: number) => void;
    onError?: (code: number) => void;
    onReady?: () => void;
};

// Minimal structural typing for the slice of the YT IFrame API we use.
// The full API is loaded at runtime from youtube.com/iframe_api.
interface YTPlayer {
    loadVideoById(id: string): void;
    cueVideoById(id: string): void;
    playVideo(): void;
    pauseVideo(): void;
    stopVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    setVolume(volume: number): void;
    getCurrentTime(): number;
    getDuration(): number;
}

interface YTPlayerEvent { data: number }
interface YTPlayerErrorEvent { data: number }

interface YTApi {
    Player: new (el: HTMLElement, config: Record<string, unknown>) => YTPlayer;
    PlayerState: { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}

declare global {
    interface Window {
        YT?: YTApi;
        onYouTubeIframeAPIReady?: () => void;
    }
}

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";
const STATES = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5,
} as const;

const OFFSCREEN_CSS = [
    "position:fixed",
    "right:-220px",
    "bottom:0",
    "width:200px",
    "height:180px",
    "opacity:0.01",
    "pointer-events:none",
    "z-index:-1",
].join(";");

class YoutubeEngine {
    private player: YTPlayer | null = null;
    private apiPromise: Promise<void> | null = null;
    private container: HTMLDivElement | null = null;
    private host: HTMLDivElement | null = null;
    private pendingVideo: string | null = null;
    private rafId = 0;
    private lastTimePush = 0;
    private volume = 80;
    private callbacks: EngineCallbacks = {};
    private ready = false;
    private videoRect: VideoRect | null = null;

    setCallbacks(cb: EngineCallbacks): void {
        this.callbacks = cb;
    }

    /** Load the IFrame API script (idempotent). */
    loadApi(): Promise<void> {
        if (this.apiPromise) return this.apiPromise;
        this.apiPromise = new Promise<void>((resolve, reject) => {
            if (typeof window === "undefined") {
                reject(new Error("no window"));
                return;
            }
            if (window.YT?.Player) {
                resolve();
                return;
            }
            const prev = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                prev?.();
                resolve();
            };
            if (document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
                const check = setInterval(() => {
                    if (window.YT?.Player) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
                return;
            }
            const tag = document.createElement("script");
            tag.src = IFRAME_API_SRC;
            tag.async = true;
            tag.onerror = () => reject(new Error("YouTube IFrame API 加载失败"));
            document.head.appendChild(tag);
        });
        return this.apiPromise;
    }

    private applyHostStyles(): void {
        const host = this.host;
        if (!host) return;
        if (this.videoRect) {
            const r = this.videoRect;
            host.style.cssText = [
                "position:fixed",
                `left:${r.left}px`,
                `top:${r.top}px`,
                `width:${r.width}px`,
                `height:${r.height}px`,
                "opacity:1",
                "pointer-events:auto",
                "z-index:9001",
                "background:#000",
                "transition:opacity .2s ease,left .2s ease,top .2s ease,width .2s ease,height .2s ease",
            ].join(";");
            host.setAttribute("aria-hidden", "false");
        } else {
            host.style.cssText = OFFSCREEN_CSS;
            host.setAttribute("aria-hidden", "true");
        }
    }

    /**
     * Reposition the underlying iframe host over a visible rect (video mode)
     * or back off-screen (audio mode). Passing null both hides the iframe and
     * restores the default audio-only placement.
     */
    setVideoRect(rect: VideoRect | null): void {
        this.videoRect = rect;
        this.applyHostStyles();
    }

    private ensureContainer(): HTMLDivElement {
        if (this.container) return this.container;
        const host = document.createElement("div");
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = OFFSCREEN_CSS;
        const inner = document.createElement("div");
        inner.style.cssText = "width:100%;height:100%;";
        host.appendChild(inner);
        document.body.appendChild(host);
        this.host = host;
        this.container = inner;
        this.applyHostStyles();
        return inner;
    }

    private async ensurePlayer(): Promise<void> {
        if (this.player) return;
        await this.loadApi();
        await new Promise<void>((resolve) => {
            const yt = window.YT!;
            this.player = new yt.Player(this.ensureContainer(), {
                height: "180",
                width: "200",
                playerVars: {
                    playsinline: 1,
                    autoplay: 0,
                    controls: 0,
                    disablekb: 1,
                    fs: 0,
                    iv_load_policy: 3,
                    modestbranding: 1,
                    rel: 0,
                },
                events: {
                    onReady: () => {
                        this.ready = true;
                        this.player?.setVolume(this.volume);
                        this.callbacks.onReady?.();
                        resolve();
                        if (this.pendingVideo) {
                            const id = this.pendingVideo;
                            this.pendingVideo = null;
                            this.player?.loadVideoById(id);
                        }
                    },
                    onStateChange: (e: YTPlayerEvent) => this.handleState(e.data),
                    onError: (e: YTPlayerErrorEvent) => {
                        this.stopTicker();
                        this.callbacks.onError?.(e.data);
                    },
                },
            });
        });
    }

    private handleState(state: number): void {
        if (state === STATES.PLAYING) {
            const d = this.player?.getDuration?.() || 0;
            if (d > 0) this.callbacks.onDuration?.(d);
            this.startTicker();
            this.callbacks.onPlaying?.();
        } else if (state === STATES.PAUSED) {
            this.stopTicker();
            this.callbacks.onPaused?.();
        } else if (state === STATES.ENDED) {
            this.stopTicker();
            this.callbacks.onEnded?.();
        }
    }

    private startTicker(): void {
        if (this.rafId) return;
        const tick = () => {
            const t = this.player?.getCurrentTime?.() ?? 0;
            const now = performance.now();
            if (now - this.lastTimePush > 250) {
                this.lastTimePush = now;
                this.callbacks.onTime?.(t);
            }
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    private stopTicker(): void {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
    }

    /** Load a video and start playback. Must be triggered (or preceded) by a user gesture. */
    async load(videoId: string): Promise<void> {
        await this.ensurePlayer();
        this.pendingVideo = null;
        if (this.ready) {
            this.player?.loadVideoById(videoId);
            this.player?.setVolume(this.volume);
        } else {
            this.pendingVideo = videoId;
        }
    }

    play(): void {
        try {
            if (this.ready && this.player) {
                this.player.playVideo();
            }
        } catch { /* ignore */ }
    }

    pause(): void {
        try {
            this.player?.pauseVideo();
        } catch { /* ignore */ }
    }

    stop(): void {
        this.stopTicker();
        try {
            this.player?.stopVideo();
        } catch { /* ignore */ }
    }

    seekTo(seconds: number): void {
        try {
            this.player?.seekTo(seconds, true);
        } catch { /* ignore */ }
        this.callbacks.onTime?.(seconds);
    }

    setVolume(v01: number): void {
        this.volume = Math.round(Math.max(0, Math.min(1, v01)) * 100);
        try {
            this.player?.setVolume(this.volume);
        } catch { /* ignore */ }
    }
}

// Module-level singleton shared across the app session.
export const ytEngine = new YoutubeEngine();