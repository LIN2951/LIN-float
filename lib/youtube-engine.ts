// lib/youtube-engine.ts — Hidden YouTube IFrame player singleton.
// Plays YouTube videos as "audio only": the IFrame is rendered off-screen
// (never display:none — YouTube refuses to start in a hidden container).
// All transport controls are bridged through callbacks into music-context.
"use client";

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
            // Script tag may already be present from a previous engine instance.
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

    private ensureContainer(): HTMLDivElement {
        if (this.container) return this.container;
        const host = document.createElement("div");
        // Off-screen but still rendered: position/opacity tricks only.
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = [
            "position:fixed",
            "right:-220px",
            "bottom:0",
            "width:200px",
            "height:180px",
            "opacity:0.01",
            "pointer-events:none",
            "z-index:-1",
        ].join(";");
        const inner = document.createElement("div");
        host.appendChild(inner);
        document.body.appendChild(host);
        this.host = host;
        this.container = inner;
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
                        // A load() call may have raced player creation.
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
