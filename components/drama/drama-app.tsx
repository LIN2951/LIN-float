// components/drama/drama-app.tsx — 独立「广播剧 / 乙女抓」App。
// 粘贴 YouTube / DLsite / Reddit 链接 → 服务端解析 → 走全局音乐引擎播放，
// 支持音频 / 视频双模式、自动抓字幕、历史保留、收藏、分类、文件夹。
// 播放状态与全局悬浮窗（Melon 式上一首/下一首）联动，退出 App 声音不断。
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { detectPlatform, PLATFORM_LABELS, type ParsedLink } from "@/lib/music-links";
import type { MusicTrack } from "@/lib/music-storage";
import { useMusicPlayer, MUSIC_PLAYBACK_ERROR_EVENT } from "@/lib/music-context";
import { showOtomeVideo, hideOtomeVideo, subscribeOtomeVideo, getOtomeVideoSnapshot } from "@/lib/otome-video";
import {
    DRAMA_CATEGORY_LABELS, DRAMA_CATEGORY_ORDER,
    loadDramaLinks, loadDramaFolders, upsertDramaLink, updateDramaLink, removeDramaLink,
    createDramaFolder, renameDramaFolder, deleteDramaFolder,
    type DramaLink, type DramaFolder, type DramaCategory,
} from "@/lib/drama-storage";

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

function defaultCategory(source: DramaLink["source"]): DramaCategory {
    if (source === "dlsite") return "otome";
    if (source === "reddit") return "asmr";
    return "asmr";
}

function clock(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function toTrack(l: DramaLink): MusicTrack {
    return {
        id: l.id,
        title: l.title,
        artist: l.artist,
        coverUrl: l.coverUrl,
        source: l.source,
        externalId: l.externalId,
        canonicalUrl: l.canonicalUrl,
        liked: l.favorite,
        addedAt: l.addedAt,
        duration: 0,
    };
}

type TabId = "all" | DramaCategory | "fav";

const TABS: { id: TabId; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "otome", label: DRAMA_CATEGORY_LABELS.otome },
    { id: "drama", label: DRAMA_CATEGORY_LABELS.drama },
    { id: "asmr", label: DRAMA_CATEGORY_LABELS.asmr },
    { id: "fav", label: "收藏" },
];

export default function DramaApp({ onClose }: { onClose: () => void }) {
    const player = useMusicPlayer();
    const videoVisible = useSyncExternalStore(subscribeOtomeVideo, getOtomeVideoSnapshot, getOtomeVideoSnapshot);

    const [links, setLinks] = useState<DramaLink[]>(() => loadDramaLinks());
    const [folders, setFolders] = useState<DramaFolder[]>(() => loadDramaFolders());
    const [tab, setTab] = useState<TabId>("all");
    const [folderFilter, setFolderFilter] = useState<string | null>(null);
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [night, setNight] = useState(false);

    const [input, setInput] = useState("");
    const [detected, setDetected] = useState<ParsedLink | null>(null);
    const [loading, setLoading] = useState(false);
    const [current, setCurrent] = useState<DramaLink | null>(null);
    const [lyrics, setLyrics] = useState("");
    const [showSub, setShowSub] = useState(false);
    const [subLoading, setSubLoading] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((text: string, ms = 2600) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(text);
        toastTimerRef.current = setTimeout(() => setToast(null), ms);
    }, []);

    useEffect(() => () => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    }, []);

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
            // best-effort
        } finally {
            setSubLoading(false);
        }
    }, [player]);

    const playLink = useCallback((link: DramaLink, all: DramaLink[]) => {
        const queue = all.map(toTrack);
        player.setQueue(queue);
        player.playTrack(toTrack(link));
        setCurrent(link);
        hideOtomeVideo();
    }, [player]);

    const resolveAndPlay = useCallback(async () => {
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
            const existing = loadDramaLinks().find(l => l.id === meta.id);
            const link: DramaLink = {
                id: meta.id,
                title: meta.title || "未命名",
                artist: meta.artist || PLATFORM_LABELS[meta.source],
                coverUrl: meta.coverUrl,
                source: meta.source,
                externalId: meta.externalId,
                canonicalUrl: meta.sourceUrl,
                category: existing?.category ?? defaultCategory(meta.source),
                folderId: existing?.folderId ?? null,
                favorite: existing?.favorite ?? false,
                addedAt: existing?.addedAt ?? new Date().toISOString(),
            };
            const nextLinks = upsertDramaLink(link);
            setLinks(nextLinks);
            setLoading(false);
            setLyrics("");
            setShowSub(false);
            playLink(link, nextLinks);
            if (data.message) showToast(data.message);
            void fetchCaptions(toTrack(link));
        } catch {
            showToast("网络错误，解析失败");
            setLoading(false);
        }
    }, [detected, fetchCaptions, playLink, showToast]);

    const play = useCallback((link: DramaLink) => {
        playLink(link, links);
        if (isYoutubeTrack(toTrack(link))) void fetchCaptions(toTrack(link));
    }, [links, playLink, fetchCaptions]);

    const toggleFavorite = useCallback((id: string) => {
        setLinks(prev => {
            const target = prev.find(l => l.id === id);
            const next = updateDramaLink(id, { favorite: !target?.favorite });
            return next;
        });
    }, []);

    const changeCategory = useCallback((id: string, category: DramaCategory) => {
        setLinks(prev => updateDramaLink(id, { category }));
    }, []);

    const changeFolder = useCallback((id: string, folderId: string | null) => {
        setLinks(prev => updateDramaLink(id, { folderId: folderId || null }));
    }, []);

    const removeLink = useCallback((id: string, title: string) => {
        setLinks(prev => removeDramaLink(id));
        showToast(`已删除「${title}」`);
    }, [showToast]);

    const addFolder = useCallback(() => {
        const name = newFolderName.trim();
        if (!name) return;
        setFolders(createDramaFolder(name));
        setNewFolderName("");
        setNewFolderOpen(false);
    }, [newFolderName]);

    const renameFolderAt = useCallback((id: string, name: string) => {
        setFolders(renameDramaFolder(id, name));
    }, []);

    const removeFolder = useCallback((id: string) => {
        const { folders: nextFolders, links: nextLinks } = deleteDramaFolder(id);
        setFolders(nextFolders);
        setLinks(nextLinks);
        if (folderFilter === id) setFolderFilter(null);
    }, [folderFilter]);

    const setVideoMode = useCallback((video: boolean) => {
        if (video) {
            if (!current || !isYoutubeTrack(toTrack(current))) {
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

    const filtered = useMemo(() => links.filter(l => {
        const catOk = tab === "all" ? true : tab === "fav" ? l.favorite : l.category === tab;
        const folderOk = folderFilter === null ? true : l.folderId === folderFilter;
        return catOk && folderOk;
    }), [links, tab, folderFilter]);

    const platformLabel = detected ? PLATFORM_LABELS[detected.platform] : null;
    const isCurrentPlayingThis = !!current && player.currentTrack?.id === current.id;
    const playing = isCurrentPlayingThis && player.isPlaying;
    const folderName = (id: string | null) => id === null ? "" : (folders.find(f => f.id === id)?.name || "");

    return (
        <div className="drama-app" {...(night ? { "data-night": "" } : {})}>
            {/* Header */}
            <div className="drama-header">
                <button className="drama-back" onClick={onClose} title="返回">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>
                <div className="drama-title">
                    <span className="drama-logo">广播剧<span>·</span>乙女抓</span>
                </div>
                <button className="drama-night-btn" onClick={() => setNight(v => !v)} title={night ? "切换日间" : "切换夜间"}>
                    {night ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                        </svg>
                    ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                        </svg>
                    )}
                </button>
            </div>

            {/* Link input */}
            <div className="drama-input-row">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <input
                    className="drama-input"
                    placeholder="粘贴 YouTube / DLsite / Reddit 链接"
                    value={input}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={e => onInputChange(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && detected && !loading) void resolveAndPlay(); }}
                />
                <button className="drama-play-btn" disabled={!detected || loading} onClick={() => void resolveAndPlay()}>
                    {loading ? "加载中…" : "播放"}
                </button>
            </div>
            <div className="drama-hint">
                {platformLabel && detected ? (
                    <span className="drama-chip" data-p={detected.platform}>{platformLabel}</span>
                ) : null}
                <span>识别链接后可播音频 / 视频，字幕自动抓取</span>
            </div>

            {/* Now playing */}
            {current && (
                <div className="drama-now">
                    <div className="drama-now-meta">
                        {current.coverUrl ? (
                            <img className="drama-cover" src={current.coverUrl} alt="" />
                        ) : (
                            <div className="drama-cover drama-cover-ph">
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                </svg>
                            </div>
                        )}
                        <div className="drama-now-info">
                            <div className="drama-now-title">{current.title}</div>
                            <div className="drama-now-artist">{current.artist}</div>
                            <div className="drama-now-badge">
                                <span className="drama-live-dot" data-playing={playing ? "" : undefined} />
                                {playing ? "正在播放" : "已就绪"}
                                <span className="drama-cat-tag">{DRAMA_CATEGORY_LABELS[current.category]}</span>
                            </div>
                        </div>
                    </div>

                    {/* Progress */}
                    <div className="drama-progress">
                        <div className="drama-progress-fill" style={{ width: `${player.duration > 0 ? Math.min(100, (player.currentTime / player.duration) * 100) : 0}%` }} />
                    </div>
                    <div className="drama-progress-time">
                        <span>{clock(player.currentTime)}</span>
                        <span>{isCurrentPlayingThis ? clock(player.duration) : ""}</span>
                    </div>

                    {/* Mode + subtitle */}
                    <div className="drama-mode">
                        <div className="drama-seg">
                            <button type="button" className={!videoVisible ? "active" : ""} onClick={() => setVideoMode(false)}>音频</button>
                            <button type="button" className={videoVisible ? "active" : ""} onClick={() => setVideoMode(true)}>视频</button>
                        </div>
                        <div className="drama-mode-actions">
                            <button
                                className="drama-ghost-btn"
                                disabled={!isYoutubeTrack(toTrack(current)) || subLoading}
                                onClick={() => setShowSub(prev => !prev)}
                            >
                                {subLoading ? "抓取中…" : (showSub ? "隐藏字幕" : "字幕")}
                            </button>
                        </div>
                    </div>

                    {/* Subtitle panel */}
                    {showSub && (
                        <div className="drama-sub">
                            {parsedLyrics.length === 0 ? (
                                <div className="drama-sub-empty">暂未抓取到字幕，可稍后重新打开字幕</div>
                            ) : (
                                parsedLyrics.map((line, i) => (
                                    <div key={i} className="drama-sub-line" data-active={i === activeLyricIdx ? "" : undefined}>
                                        <b>{clock(line.time)}</b>
                                        <span>{line.text}</span>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Folder bar */}
            <div className="drama-folders">
                <button className={`drama-folder-chip${folderFilter === null ? " active" : ""}`} onClick={() => setFolderFilter(null)}>
                    全部
                </button>
                {folders.map(f => (
                    <div key={f.id} className="drama-folder-chip-wrap">
                        <button
                            className={`drama-folder-chip${folderFilter === f.id ? " active" : ""}`}
                            onClick={() => setFolderFilter(folderFilter === f.id ? null : f.id)}
                            onDoubleClick={() => {
                                const name = window.prompt("重命名文件夹", f.name);
                                if (name && name.trim()) renameFolderAt(f.id, name);
                            }}
                        >
                            {f.name}
                        </button>
                        <button className="drama-folder-del" title="删除文件夹" onClick={() => removeFolder(f.id)}>×</button>
                    </div>
                ))}
                {newFolderOpen ? (
                    <div className="drama-folder-new">
                        <input
                            value={newFolderName}
                            autoFocus
                            placeholder="文件夹名"
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") addFolder(); if (e.key === "Escape") setNewFolderOpen(false); }}
                        />
                        <button onClick={addFolder}>确定</button>
                    </div>
                ) : (
                    <button className="drama-folder-add" onClick={() => setNewFolderOpen(true)}>＋ 新建</button>
                )}
            </div>

            {/* Category tabs */}
            <div className="drama-tabs">
                {TABS.map(t => (
                    <button key={t.id} className={`drama-tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
                        {t.label}
                    </button>
                ))}
            </div>

            {/* List */}
            <div className="drama-list">
                {filtered.length === 0 ? (
                    <div className="drama-empty">
                        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                        </svg>
                        <span>还没有收录任何音频，先在上方粘贴一个链接吧</span>
                    </div>
                ) : (
                    filtered.map(link => {
                        const isThis = player.currentTrack?.id === link.id;
                        return (
                            <div key={link.id} className="drama-item" data-active={isThis ? "" : undefined}>
                                {link.coverUrl ? (
                                    <img className="drama-item-cover" src={link.coverUrl} alt="" />
                                ) : (
                                    <div className="drama-item-cover drama-item-cover-ph">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                        </svg>
                                    </div>
                                )}
                                <div className="drama-item-main">
                                    <div className="drama-item-title">{link.title}</div>
                                    <div className="drama-item-artist">{link.artist}{folderName(link.folderId) ? ` · ${folderName(link.folderId)}` : ""}</div>
                                    <div className="drama-item-tags">
                                        <span className="drama-cat-tag">{DRAMA_CATEGORY_LABELS[link.category]}</span>
                                        {isThis && <span className="drama-now-note" data-playing={playing ? "" : undefined}>{playing ? "播放中" : "已暂停"}</span>}
                                    </div>
                                </div>
                                <div className="drama-item-actions">
                                    <button className="drama-item-ico" onClick={() => play(link)} title="播放">
                                        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                                    </button>
                                    <button
                                        className="drama-item-ico"
                                        data-on={link.favorite ? "" : undefined}
                                        onClick={() => toggleFavorite(link.id)}
                                        title={link.favorite ? "取消收藏" : "收藏"}
                                    >
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill={link.favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
                                            <path d="M12 21s-7.5-4.6-9.5-9C1.4 8.6 3.5 5 7 5c2 0 3.4 1 4.5 2.5C12.6 6 14 5 16 5c3.5 0 5.6 3.6 4.5 7-2 4.4-9.5 9-9.5 9z" />
                                        </svg>
                                    </button>
                                    <button className="drama-item-ico drama-item-delete" onClick={() => removeLink(link.id, link.title)} title="删除">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                        </svg>
                                    </button>
                                    <select
                                        className="drama-item-select"
                                        value={link.category}
                                        onChange={e => changeCategory(link.id, e.target.value as DramaCategory)}
                                        title="分类"
                                    >
                                        {DRAMA_CATEGORY_ORDER.map(c => (
                                            <option key={c} value={c}>{DRAMA_CATEGORY_LABELS[c]}</option>
                                        ))}
                                    </select>
                                    <select
                                        className="drama-item-select drama-item-folder-select"
                                        value={link.folderId || ""}
                                        onChange={e => changeFolder(link.id, e.target.value || null)}
                                        title="存进文件夹"
                                    >
                                        <option value="">未分类</option>
                                        {folders.map(f => (
                                            <option key={f.id} value={f.id}>{f.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {toast && <div className="drama-toast">{toast}</div>}
        </div>
    );
}