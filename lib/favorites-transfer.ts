import type { FavoriteItem } from "./favorites-storage";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { isMediaStoreRef, loadMediaBlob } from "./media-cache-storage";
import { serializeMediaUrl, type MediaCollector } from "./data-management/serializers";
import type { ExportRecordTransform } from "./data-management/idb";

export type FavoriteExportEntity = { id: string; type: FavoriteItem["entityType"] };

export function isFavoriteBackupItem(value: unknown): value is FavoriteItem {
  if (!value || typeof value !== "object") return false;
  const item = value as FavoriteItem;
  return [item.id, item.entityId, item.entityName, item.scopeKey, item.scopeLabel, item.containerId, item.containerName,
    item.createdAt, item.updatedAt, item.sourceCreatedAt, item.title, item.preview].every(field => typeof field === "string")
    && (item.category === "chat" || item.category === "story")
    && (item.entityType === "character" || item.entityType === "group")
    && ["message", "bundle", "image", "moment"].includes(item.kind)
    && [item.tags, item.participantIds, item.participantNames, item.sourceItemIds].every(list => Array.isArray(list) && list.every(field => typeof field === "string"))
    && Array.isArray(item.entries) && item.entries.every(entry => entry && typeof entry.id === "string"
      && ["user", "assistant", "system"].includes(entry.role) && typeof entry.senderName === "string"
      && typeof entry.content === "string" && typeof entry.createdAt === "string"
      && (entry.mediaUrl === undefined || typeof entry.mediaUrl === "string"));
}

export function matchesFavoriteExportEntity(item: FavoriteItem, entity?: FavoriteExportEntity): boolean {
  return !entity || (item.entityType === entity.type && item.entityId === entity.id)
    || (entity.type === "character" && item.participantIds?.includes(entity.id));
}

const MEDIA_FIELD = /(?:mediaUrl|photoUrl|imageUrl|audioUrl|videoUrl|thumbnailUrl|stickerUrl|coverUrl|backgroundUrl|fileUrl|poster|src|assetId|mediaRef)$/i;
const LOCAL_REF = /^(?:media-store:\/\/|asset:\/\/|blob:)/i;

async function fetchMedia(ref: string, image: boolean): Promise<Blob> {
  const signal = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(ref, { signal, credentials: "omit" });
    if (!response.ok) throw new Error("媒体下载失败");
  } catch (error) {
    if (!image || !/^https?:\/\//i.test(ref) || signal.aborted) throw error;
    // Only download the existing image; never submit a generation request.
    response = await fetch("/api/image-generation/download", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: ref }), signal,
    });
  }
  if (!response.ok) throw new Error("媒体下载失败");
  const blob = await response.blob();
  if (!blob.size || /^(?:text\/|application\/json)/i.test(blob.type)) throw new Error("媒体文件为空或已失效");
  return blob;
}

/** Embed only media referenced by the selected favorites, independent of chat/theme databases. */
export function createFavoriteExportTransform(entity?: FavoriteExportEntity, excludeMedia = false, collector?: MediaCollector): ExportRecordTransform {
  const urls = new Map<string, unknown>();
  const resolve = async (ref: string, image: boolean, inline = false): Promise<unknown> => {
    if (!ref || ref.startsWith("data:")) return ref;
    const key = `${inline ? "inline:" : ""}${ref}`;
    if (urls.has(key)) return urls.get(key);
    let blob: Blob;
    if (isMediaStoreRef(ref)) {
      const stored = await loadMediaBlob(ref);
      if (!stored?.blob.size) throw new Error("收藏引用的本机媒体不存在");
      blob = stored.blob.slice(0, stored.blob.size, stored.mimeType || stored.blob.type);
    } else if (/^(?:https?:|blob:|\/)/i.test(ref)) {
      blob = await fetchMedia(ref, image);
    } else {
      const dataUrl = await getChatImageFromIndexedDB(ref.replace(/^asset:\/\//, ""));
      if (!dataUrl) throw new Error("收藏引用的本机素材不存在");
      const response = await fetch(dataUrl);
      blob = await response.blob();
    }
    const portable = await serializeMediaUrl(blob, inline ? undefined : collector);
    urls.set(key, portable);
    return portable;
  };

  const richText = async (text: string): Promise<string> => {
    // HTML attributes, Markdown images and CSS images can also carry local/temporary URLs.
    const pattern = /((?:\b(?:src|poster)\s*=\s*["']|!\[[^\]]*\]\(\s*|url\(\s*["']?))((?:https?:\/\/|blob:|asset:\/\/|media-store:\/\/)[^\s"'<>)]*)/gi;
    let result = "";
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      result += text.slice(offset, match.index) + match[1] + (excludeMedia ? "" : await resolve(match[2], true, true));
      offset = match.index! + match[0].length;
    }
    return offset ? result + text.slice(offset) : text;
  };

  const walk = async (value: unknown, field = "", image = false): Promise<unknown> => {
    if (typeof value === "string") {
      if (LOCAL_REF.test(value) || MEDIA_FIELD.test(field)) {
        return excludeMedia ? "" : resolve(value, image || /image|photo|poster/i.test(field));
      }
      return /content/i.test(field) ? richText(value) : value;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const child of value) out.push(await walk(child, field, image));
      return out;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) out[key] = await walk(child, key, record.mediaType === "image" || image);
      return out;
    }
    return value;
  };

  return async (value, storeName) => {
    if (storeName !== "items") return undefined;
    const item = value as FavoriteItem;
    if (!matchesFavoriteExportEntity(item, entity)) return undefined;
    try {
      // Generated images often retain a local original even if their signed URL expired.
      const entries = [];
      for (const entry of item.entries) {
        const localRef = entry.mediaType === "image" ? entry.mediaData?.imageGenerationMediaRef : undefined;
        const local = typeof localRef === "string" ? await loadMediaBlob(localRef).catch(() => null) : null;
        entries.push(local?.blob.size ? { ...entry, mediaUrl: localRef }
          : typeof localRef === "string" && entry.mediaUrl
            ? { ...entry, mediaData: { ...entry.mediaData, imageGenerationMediaRef: entry.mediaUrl } } : entry);
      }
      return await walk({ ...item, entries });
    } catch {
      throw new Error(`收藏“${item.title || "未命名"}”的媒体缺失或下载失败，已停止导出。请确认原语音、图片可以打开后重试；也可在设置中取消收藏板块或选择不含多媒体导出。`);
    }
  };
}
