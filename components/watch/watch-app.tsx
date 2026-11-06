// components/watch/watch-app.tsx — 「一起看」：和角色一起看视频/番剧，边看边聊 + 角色弹幕
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowLeft,
    Link2,
    LoaderCircle,
    Maximize,
    Play,
    SendHorizontal,
    Trash2,
    Tv,
    UserPlus,
    X,
} from "lucide-react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { parseWatchLink, WATCH_SOURCE_LABEL } from "@/lib/watch-link";
import { fetchWatchMeta, generateWatchReply } from "@/lib/watch-engine";
import {
    appendWatchChat,
    loadWatchChat,
    loadWatchDanmakuEnabled,
    loadWatchInvited,
    loadWatchVideos,
    makeWatchMsgId,
    removeWatchVideo,
    saveWatchDanmakuEnabled,
    saveWatchInvited,
    upsertWatchVideo,
    type WatchChatMsg,
    type WatchVideoItem,
} from "@/lib/watch-storage";

function hashId(input: string): string {
    let h = 5381;
    for (let i = 0; i < input.length; i += 1) {
        h = ((h << 5) + h + input.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}

function charColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360} 85% 72%)`;
}

type DanmakuItem = {
    id: string;
    text: string;
    color: string;
    top: number;
    duration: number;
};

const AMBIENT_INTERVAL_MS = 55_000;

export default function WatchApp({ onClose }: { onClose: () => void }) {
    const [view, setView] = useState<"home" | "room">("home");
    const [videos, setVideos] = useState<WatchVideoItem[]>(() => loadWatchVideos());
    const [current, setCurrent] = useState<WatchVideoItem | null>(null);
    const [chat, setChat] = useState<WatchChatMsg[]>([]);
    const [invitedIds, setInvitedIds] = useState<string[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [linkInput, setLinkInput] = useState("");
    const [parsing, setParsing] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [generating, setGenerating] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [danmakuOn, setDanmakuOn] = useState(() => loadWatchDanmakuEnabled());
    const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
    const [toast, setToast] = useState<string | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const stageRef = useRef<HTMLDivElement | null>(null);
    const chatListRef = useRef<HTMLDivElement | null>(null);
    const generatingRef = useRef(false);
    const toastTimerRef = useRef<number | null>(null);
    const currentRef = useRef<WatchVideoItem | null>(null);
    const invitedRef = useRef<Character[]>([]);
    const chatRef = useRef<WatchChatMsg[]>([]);

    useEffect(() => { currentRef.current = current; }, [current]);
    useEffect(() => { chatRef.current = chat; }, [chat]);
    useEffect(() => {
        setCharacters(loadCharacters());
    }, []);

    const invitedChars = useMemo(
        () => invitedIds.map(id => characters.find(c => c.id === id)).filter((c): c is Character => Boolean(c)),
        [invitedIds, characters],
    );
    useEffect(() => { invitedRef.current = invitedChars; }, [invitedChars]);

    const showToast = useCallback((text: string) => {
        setToast(text);
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
    }, []);

    const pushDanmaku = useCallback((text: string, color: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const item: DanmakuItem = {
            id: makeWatchMsgId(),
            text: trimmed.slice(0, 32),
            color,
            top: 6 + Math.random() * 52,
            duration: 8 + Math.random() * 5,
        };
        setDanmakus(prev => [...prev.slice(-24), item]);
        window.setTimeout(() => {
            setDanmakus(prev => prev.filter(d => d.id !== item.id));
        }, item.duration * 1000 + 400);
    }, []);

    const appendMsg = useCallback((videoId: string, msg: Omit<WatchChatMsg, "id" | "at">) => {
        const full: WatchChatMsg = { ...msg, id: makeWatchMsgId(), at: Date.now() };
        const next = appendWatchChat(videoId, full);
        setChat(next);
        return full;
    }, []);

    const openVideo = useCallback(async (rawLink: string) => {
        const link = rawLink.trim();
        if (!link) return;
        if (!parseWatchLink(link)) {
            showToast("没认出这个链接，支持 B 站 / YouTube / bangumi（animeko）/ mp4 直链");
            return;
        }
        setParsing(true);
        try {
            const meta = await fetchWatchMeta(link);
            if (!meta.ok || !meta.source) {
                showToast(meta.error || "链接解析失败");
                return;
            }
            const id = `${meta.source}_${hashId(meta.embedUrl || meta.directUrl || link)}`;
            const video: WatchVideoItem = {
                id,
                url: link,
                source: meta.source,
                title: meta.title || "未命名视频",
                desc: meta.desc,
                cover: meta.cover,
                owner: meta.owner,
                embedUrl: meta.embedUrl,
                directUrl: meta.directUrl,
                addedAt: Date.now(),
            };
            setVideos(upsertWatchVideo(video));
            setCurrent(video);
            setChat(loadWatchChat(video.id));
            setInvitedIds(loadWatchInvited(video.id));
            setDanmakus([]);
            setView("room");
            setLinkInput("");
        } finally {
            setParsing(false);
        }
    }, [showToast]);

    const reopenVideo = useCallback((video: WatchVideoItem) => {
        setCurrent(video);
        setChat(loadWatchChat(video.id));
        setInvitedIds(loadWatchInvited(video.id));
        setDanmakus([]);
        setView("room");
    }, []);

    const runCharacterRound = useCallback(async (trigger?: string) => {
        const video = currentRef.current;
        const chars = invitedRef.current;
        if (!video || chars.length === 0 || generatingRef.current) return;
        generatingRef.current = true;
        setGenerating(true);
        try {
            for (let i = 0; i < chars.length; i += 1) {
                const char = chars[i];
                const others = chars.filter(c => c.id !== char.id);
                try {
                    const result = await generateWatchReply({
                        character: char,
                        others,
                        video,
                        chat: chatRef.current,
                        trigger,
                    });
                    if (result.reply) {
                        appendMsg(video.id, {
                            role: "character",
                            characterId: char.id,
                            name: char.name,
                            avatar: char.chatAvatarEnabled === false ? char.avatar : (char.chatAvatar || char.avatar),
                            text: result.reply,
                        });
                    }
                    if (result.danmaku && loadWatchDanmakuEnabled()) {
                        pushDanmaku(`${char.name}：${result.danmaku}`, charColor(char.id));
                    }
                } catch (error) {
                    showToast(error instanceof Error ? error.message : "角色回复失败");
                    break;
                }
                if (i < chars.length - 1) {
                    await new Promise(resolve => window.setTimeout(resolve, 900));
                }
            }
        } finally {
            generatingRef.current = false;
            setGenerating(false);
        }
    }, [appendMsg, pushDanmaku, showToast]);

    const handleSend = useCallback(() => {
        const video = currentRef.current;
        const text = chatInput.trim();
        if (!video || !text) return;
        setChatInput("");
        appendMsg(video.id, { role: "user", name: "我", text });
        if (danmakuOn && text.length <= 30) {
            pushDanmaku(text, "#ffffff");
        }
        if (invitedRef.current.length > 0) {
            void runCharacterRound(text);
        }
    }, [appendMsg, chatInput, danmakuOn, pushDanmaku, runCharacterRound]);

    // 氛围发言：看片过程中角色每隔一会儿随口评论
    useEffect(() => {
        if (view !== "room") return;
        const timer = window.setInterval(() => {
            if (document.visibilityState !== "visible") return;
            if (invitedRef.current.length === 0) return;
            void runCharacterRound(undefined);
        }, AMBIENT_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [view, runCharacterRound]);

    // 聊天自动滚到底部
    useEffect(() => {
        const el = chatListRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [chat, generating]);

    // 全屏状态跟踪
    useEffect(() => {
        const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            void document.exitFullscreen?.().catch(() => {});
        } else {
            void stageRef.current?.requestFullscreen?.().catch(() => {});
        }
    }, []);

    const toggleDanmaku = useCallback(() => {
        setDanmakuOn(prev => {
            const next = !prev;
            saveWatchDanmakuEnabled(next);
            return next;
        });
    }, []);

    const toggleInvite = useCallback((characterId: string) => {
        const video = currentRef.current;
        if (!video) return;
        setInvitedIds(prev => {
            const next = prev.includes(characterId)
                ? prev.filter(id => id !== characterId)
                : [...prev, characterId];
            saveWatchInvited(video.id, next);
            return next;
        });
    }, []);

    const handleDeleteVideo = useCallback((id: string) => {
        setVideos(removeWatchVideo(id));
    }, []);

    // ── 房间视图 ──
    if (view === "room" && current) {
        return (
            <div className="watch-app watch-room-root">
                <header className="watch-header">
                    <button type="button" className="watch-icon-btn" onClick={() => setView("home")} aria-label="返回">
                        <ArrowLeft size={18} strokeWidth={1.8} />
                    </button>
                    <div className="watch-header-title" title={current.title}>{current.title}</div>
                    <button
                        type="button"
                        className={`watch-icon-btn${danmakuOn ? " is-on" : ""}`}
                        onClick={toggleDanmaku}
                        title={danmakuOn ? "关闭弹幕" : "开启弹幕"}
                        aria-label="弹幕开关"
                    >
                        弹
                    </button>
                    <button type="button" className="watch-icon-btn" onClick={() => setInviteOpen(true)} aria-label="邀请角色">
                        <UserPlus size={18} strokeWidth={1.8} />
                    </button>
                    <button type="button" className="watch-icon-btn" onClick={toggleFullscreen} aria-label="全屏">
                        {isFullscreen ? <X size={18} strokeWidth={1.8} /> : <Maximize size={17} strokeWidth={1.8} />}
                    </button>
                </header>

                <div className="watch-stage" ref={stageRef}>
                    {current.embedUrl ? (
                        <iframe
                            key={current.embedUrl}
                            src={current.embedUrl}
                            className="watch-player"
                            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                            allowFullScreen
                        />
                    ) : current.directUrl ? (
                        <video key={current.directUrl} src={current.directUrl} className="watch-player" controls playsInline />
                    ) : (
                        <div className="watch-info-card">
                            {current.cover ? <img src={current.cover} alt="" className="watch-info-cover" /> : null}
                            <div className="watch-info-body">
                                <div className="watch-info-title">{current.title}</div>
                                {current.desc ? <div className="watch-info-desc">{current.desc}</div> : null}
                                <div className="watch-info-tip">番剧条目已识别，角色知道剧情简介，可以边看聊边。贴上可播放的视频链接可在此直接放映。</div>
                            </div>
                        </div>
                    )}
                    {danmakuOn && (current.embedUrl || current.directUrl) ? (
                        <div className="watch-danmaku-layer" aria-hidden>
                            {danmakus.map(d => (
                                <span
                                    key={d.id}
                                    className="watch-danmaku-item"
                                    style={{
                                        top: `${d.top}%`,
                                        color: d.color,
                                        animationDuration: `${d.duration}s`,
                                    }}
                                >
                                    {d.text}
                                </span>
                            ))}
                        </div>
                    ) : null}
                </div>

                <div className="watch-members">
                    <span className="watch-members-label">陪看</span>
                    {invitedChars.length === 0 ? (
                        <button type="button" className="watch-member-add" onClick={() => setInviteOpen(true)}>
                            <UserPlus size={13} strokeWidth={1.8} /> 邀请角色陪看
                        </button>
                    ) : (
                        <>
                            {invitedChars.map(c => (
                                <span key={c.id} className="watch-member-chip" style={{ borderColor: charColor(c.id) }}>
                                    {c.avatar ? <img src={c.avatar} alt="" /> : null}
                                    {c.name}
                                </span>
                            ))}
                            <button type="button" className="watch-member-add" onClick={() => setInviteOpen(true)}>
                                <UserPlus size={13} strokeWidth={1.8} />
                            </button>
                        </>
                    )}
                </div>

                <div className="watch-chat" ref={chatListRef}>
                    {chat.length === 0 ? (
                        <div className="watch-chat-empty">
                            {invitedChars.length === 0
                                ? "先邀请角色，再边看边聊；你的消息和弹幕角色都看得到"
                                : "说点什么，角色会接话；TA 们看剧情时也会自己吐槽"}
                        </div>
                    ) : null}
                    {chat.map(msg => (
                        <div key={msg.id} className={`watch-msg${msg.role === "user" ? " is-user" : ""}`}>
                            {msg.role === "character" ? (
                                msg.avatar
                                    ? <img src={msg.avatar} alt="" className="watch-msg-avatar" />
                                    : <span className="watch-msg-avatar watch-msg-avatar-fallback" style={{ background: charColor(msg.characterId || msg.name) }}>{msg.name.slice(0, 1)}</span>
                            ) : null}
                            <div className="watch-msg-body">
                                {msg.role === "character" ? <div className="watch-msg-name" style={{ color: charColor(msg.characterId || msg.name) }}>{msg.name}</div> : null}
                                <div className="watch-msg-bubble">{msg.text}</div>
                            </div>
                        </div>
                    ))}
                    {generating ? (
                        <div className="watch-typing">
                            <LoaderCircle size={13} className="watch-spin" /> 角色正在输入…
                        </div>
                    ) : null}
                </div>

                <form
                    className="watch-input-bar"
                    onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                >
                    <input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder={invitedChars.length > 0 ? "边看边聊…" : "发个弹幕 / 说点什么"}
                        maxLength={300}
                    />
                    <button type="submit" className="watch-send" disabled={!chatInput.trim()} aria-label="发送">
                        <SendHorizontal size={17} strokeWidth={1.8} />
                    </button>
                </form>

                {inviteOpen ? (
                    <div className="watch-sheet-mask" onClick={() => setInviteOpen(false)}>
                        <div className="watch-sheet" onClick={(e) => e.stopPropagation()}>
                            <div className="watch-sheet-head">
                                <span>邀请角色一起看</span>
                                <button type="button" className="watch-icon-btn" onClick={() => setInviteOpen(false)} aria-label="关闭">
                                    <X size={16} strokeWidth={1.8} />
                                </button>
                            </div>
                            <div className="watch-sheet-list">
                                {characters.length === 0 ? (
                                    <div className="watch-chat-empty">还没有角色，先去「角色」App 创建一个吧</div>
                                ) : characters.map(c => {
                                    const checked = invitedIds.includes(c.id);
                                    return (
                                        <button
                                            key={c.id}
                                            type="button"
                                            className={`watch-invite-item${checked ? " is-checked" : ""}`}
                                            onClick={() => toggleInvite(c.id)}
                                        >
                                            {c.avatar
                                                ? <img src={c.avatar} alt="" className="watch-msg-avatar" />
                                                : <span className="watch-msg-avatar watch-msg-avatar-fallback" style={{ background: charColor(c.id) }}>{c.name.slice(0, 1)}</span>}
                                            <span className="watch-invite-name">{c.name}</span>
                                            <span className="watch-invite-check">{checked ? "已邀请" : "邀请"}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="watch-sheet-tip">被邀请的角色会根据剧情简介陪你聊天、发弹幕</div>
                        </div>
                    </div>
                ) : null}

                {toast ? <div className="watch-toast">{toast}</div> : null}
            </div>
        );
    }

    // ── 首页视图 ──
    return (
        <div className="watch-app watch-home">
            <header className="watch-header">
                <button type="button" className="watch-icon-btn" onClick={onClose} aria-label="返回桌面">
                    <ArrowLeft size={18} strokeWidth={1.8} />
                </button>
                <div className="watch-header-title">一起看</div>
            </header>

            <div className="watch-home-scroll">
                <div className="watch-hero">
                    <span className="watch-hero-icon"><Tv size={30} strokeWidth={1.4} /></span>
                    <div className="watch-hero-title">和 TA 一起看</div>
                    <div className="watch-hero-desc">贴上视频链接，邀请角色陪你追剧看片，边看边聊、一起刷弹幕</div>
                </div>

                <form
                    className="watch-link-box"
                    onSubmit={(e) => { e.preventDefault(); void openVideo(linkInput); }}
                >
                    <Link2 size={15} strokeWidth={1.8} className="watch-link-icon" />
                    <input
                        value={linkInput}
                        onChange={(e) => setLinkInput(e.target.value)}
                        placeholder="粘贴 B 站 / YouTube / animeko 番剧链接…"
                        autoCapitalize="off"
                        autoCorrect="off"
                    />
                    <button type="submit" className="watch-go" disabled={parsing || !linkInput.trim()}>
                        {parsing ? <LoaderCircle size={15} className="watch-spin" /> : <Play size={15} strokeWidth={2} />}
                        {parsing ? "解析中" : "开播"}
                    </button>
                </form>
                <div className="watch-link-hint">支持 bilibili.com / b23.tv / youtube.com / youtu.be / bangumi（animeko 分享的番剧）/ mp4 直链</div>

                {videos.length > 0 ? (
                    <>
                        <div className="watch-section-title">最近一起看</div>
                        <div className="watch-history">
                            {videos.map(video => (
                                <div key={video.id} className="watch-card" onClick={() => reopenVideo(video)}>
                                    <div className="watch-card-cover">
                                        {video.cover ? <img src={video.cover} alt="" loading="lazy" /> : <Tv size={22} strokeWidth={1.4} />}
                                        <span className="watch-card-source">{WATCH_SOURCE_LABEL[video.source]}</span>
                                    </div>
                                    <div className="watch-card-body">
                                        <div className="watch-card-title">{video.title}</div>
                                        {video.owner ? <div className="watch-card-owner">{video.owner}</div> : null}
                                    </div>
                                    <button
                                        type="button"
                                        className="watch-card-del"
                                        aria-label="删除"
                                        onClick={(e) => { e.stopPropagation(); handleDeleteVideo(video.id); }}
                                    >
                                        <Trash2 size={14} strokeWidth={1.8} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </>
                ) : null}
            </div>

            {toast ? <div className="watch-toast">{toast}</div> : null}
        </div>
    );
}
