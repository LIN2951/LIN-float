// lib/watch-storage.ts — 「一起看」本地数据：最近片单、房间聊天、邀请的角色
"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { WatchSource } from "./watch-link";

const WATCH_STORE_KEY = "ai_phone_watch_v1";
registerKvMigration(WATCH_STORE_KEY);

export type WatchVideoItem = {
    id: string;
    url: string;
    source: WatchSource;
    title: string;
    desc?: string;
    cover?: string;
    owner?: string;
    embedUrl?: string;
    directUrl?: string;
    addedAt: number;
};

export type WatchChatMsg = {
    id: string;
    role: "user" | "character";
    characterId?: string;
    name: string;
    avatar?: string | null;
    text: string;
    at: number;
};

type WatchStore = {
    videos: WatchVideoItem[];
    chats: Record<string, WatchChatMsg[]>;
    invited: Record<string, string[]>;
    danmakuEnabled: boolean;
};

const MAX_VIDEOS = 30;
const MAX_CHAT_PER_VIDEO = 80;

function loadStore(): WatchStore {
    if (typeof window === "undefined") return { videos: [], chats: {}, invited: {}, danmakuEnabled: true };
    try {
        const raw = kvGet(WATCH_STORE_KEY);
        if (!raw) return { videos: [], chats: {}, invited: {}, danmakuEnabled: true };
        const parsed = JSON.parse(raw) as Partial<WatchStore>;
        return {
            videos: Array.isArray(parsed.videos) ? parsed.videos.filter(v => v && typeof v.id === "string").slice(0, MAX_VIDEOS) : [],
            chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats as Record<string, WatchChatMsg[]> : {},
            invited: parsed.invited && typeof parsed.invited === "object" ? parsed.invited as Record<string, string[]> : {},
            danmakuEnabled: parsed.danmakuEnabled !== false,
        };
    } catch {
        return { videos: [], chats: {}, invited: {}, danmakuEnabled: true };
    }
}

function saveStore(store: WatchStore): void {
    try { kvSet(WATCH_STORE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

export function loadWatchVideos(): WatchVideoItem[] {
    return loadStore().videos;
}

export function upsertWatchVideo(video: WatchVideoItem): WatchVideoItem[] {
    const store = loadStore();
    const rest = store.videos.filter(v => v.id !== video.id);
    store.videos = [video, ...rest].slice(0, MAX_VIDEOS);
    saveStore(store);
    return store.videos;
}

export function removeWatchVideo(id: string): WatchVideoItem[] {
    const store = loadStore();
    store.videos = store.videos.filter(v => v.id !== id);
    delete store.chats[id];
    delete store.invited[id];
    saveStore(store);
    return store.videos;
}

export function loadWatchChat(videoId: string): WatchChatMsg[] {
    return loadStore().chats[videoId] ?? [];
}

export function appendWatchChat(videoId: string, msg: WatchChatMsg): WatchChatMsg[] {
    const store = loadStore();
    const list = [...(store.chats[videoId] ?? []), msg].slice(-MAX_CHAT_PER_VIDEO);
    store.chats[videoId] = list;
    saveStore(store);
    return list;
}

export function loadWatchInvited(videoId: string): string[] {
    return loadStore().invited[videoId] ?? [];
}

export function saveWatchInvited(videoId: string, characterIds: string[]): void {
    const store = loadStore();
    store.invited[videoId] = Array.from(new Set(characterIds));
    saveStore(store);
}

export function loadWatchDanmakuEnabled(): boolean {
    return loadStore().danmakuEnabled;
}

export function saveWatchDanmakuEnabled(enabled: boolean): void {
    const store = loadStore();
    store.danmakuEnabled = enabled;
    saveStore(store);
}

export function makeWatchMsgId(): string {
    return `wm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
