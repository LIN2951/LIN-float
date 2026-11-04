// lib/drama-storage.ts — 广播剧 / 乙女抓 App 的本地持久化。
// 只用 kv-db 存结构化 JSON（历史链接 + 文件夹），退出 / 刷新后依然保留。
// 播放本身走全局 music-context（ytEngine / <audio>），不在这里重复造轮子。
"use client";

import { registerKvMigration, kvGet, kvSet } from "./kv-db";

export type DramaCategory = "otome" | "drama" | "asmr";

export interface DramaLink {
    id: string;             // 复用 MusicTrack.id 约定：yt_/dlsite_/reddit_
    title: string;
    artist: string;
    coverUrl?: string;
    source: "youtube" | "dlsite" | "reddit";
    externalId?: string;
    canonicalUrl?: string;
    category: DramaCategory;
    folderId: string | null;
    favorite: boolean;
    addedAt: string;
}

export interface DramaFolder {
    id: string;
    name: string;
}

export const DRAMA_CATEGORY_LABELS: Record<DramaCategory, string> = {
    otome: "乙女抓",
    drama: "广播剧",
    asmr: "YouTube ASMR",
};

export const DRAMA_CATEGORY_ORDER: DramaCategory[] = ["otome", "drama", "asmr"];

const LINKS_KEY = "drama_links_v1";
const FOLDERS_KEY = "drama_folders_v1";
registerKvMigration(LINKS_KEY);
registerKvMigration(FOLDERS_KEY);

function genId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ── 链接历史 ──

export function loadDramaLinks(): DramaLink[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(LINKS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function saveDramaLinks(links: DramaLink[]): void {
    try {
        kvSet(LINKS_KEY, JSON.stringify(links));
    } catch { /* ignore */ }
}

/** 新增或「重新播放」一条链接：去重后置顶，保留最新的分类/收藏/文件夹。 */
export function upsertDramaLink(link: DramaLink): DramaLink[] {
    const links = loadDramaLinks();
    const rest = links.filter(l => l.id !== link.id);
    const next = [link, ...rest];
    saveDramaLinks(next);
    return next;
}

export function updateDramaLink(id: string, patch: Partial<DramaLink>): DramaLink[] {
    const links = loadDramaLinks();
    const next = links.map(l => (l.id === id ? { ...l, ...patch } : l));
    saveDramaLinks(next);
    return next;
}

export function removeDramaLink(id: string): DramaLink[] {
    const links = loadDramaLinks();
    const next = links.filter(l => l.id !== id);
    saveDramaLinks(next);
    return next;
}

// ── 文件夹 ──

export function loadDramaFolders(): DramaFolder[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(FOLDERS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function saveDramaFolders(folders: DramaFolder[]): void {
    try {
        kvSet(FOLDERS_KEY, JSON.stringify(folders));
    } catch { /* ignore */ }
}

export function createDramaFolder(name: string): DramaFolder[] {
    const folders = loadDramaFolders();
    const trimmed = name.trim();
    if (!trimmed) return folders;
    const folder: DramaFolder = { id: genId("fd"), name: trimmed };
    const next = [...folders, folder];
    saveDramaFolders(next);
    return next;
}

export function renameDramaFolder(id: string, name: string): DramaFolder[] {
    const folders = loadDramaFolders();
    const next = folders.map(f => (f.id === id ? { ...f, name: name.trim() || f.name } : f));
    saveDramaFolders(next);
    return next;
}

export function deleteDramaFolder(id: string): { folders: DramaFolder[]; links: DramaLink[] } {
    const folders = loadDramaFolders().filter(f => f.id !== id);
    saveDramaFolders(folders);
    return { folders, links: unassignFolder(id) };
}

function unassignFolder(folderId: string): DramaLink[] {
    const links = loadDramaLinks().map(l => (l.folderId === folderId ? { ...l, folderId: null } : l));
    saveDramaLinks(links);
    return links;
}