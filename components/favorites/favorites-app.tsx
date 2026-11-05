"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  Download,
  Upload,
  Image as ImageIcon,
  MessageCircle,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { ChatPageHeader } from "@/components/chat/chat-page-header";
import {
  deleteFavoriteItems,
  FAVORITES_UPDATED_EVENT,
  listFavoriteItems,
  type FavoriteEntry,
  type FavoriteItem,
} from "@/lib/favorites-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { isMediaStoreRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { createBackupBlob, importBackupBlob } from "@/lib/data-management/backup";
import { downloadFile } from "@/lib/download-utils";
import type { FavoriteExportEntity } from "@/lib/favorites-transfer";

type FavoritesTab = "chat" | "story" | "recent";

type EntitySummary = {
  key: string;
  id: string;
  type: FavoriteItem["entityType"];
  name: string;
  participantNames: string[];
  count: number;
  latestAt: string;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function matchesText(item: FavoriteItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    item.entityName,
    item.containerName,
    item.title,
    item.preview,
    item.participantNames.join(" "),
    item.tags.join(" "),
    item.entries.map(entry => `${entry.senderName} ${entry.content} ${entry.imageDescription || ""}`).join(" "),
  ].join(" ").toLowerCase().includes(needle);
}

function categoryMatches(item: FavoriteItem, tab: FavoritesTab): boolean {
  if (tab === "recent") return true;
  return item.category === tab;
}

function FavoriteImage({ entry }: { entry: FavoriteEntry }) {
  const src = useFavoriteMediaUrl(entry.mediaUrl);

  if (!src) {
    return entry.imageDescription ? <p className="favorites-image-description">{entry.imageDescription}</p> : null;
  }
  return <img className="favorites-entry-image" src={src} alt={entry.imageDescription || "收藏图片"} />;
}

function useFavoriteMediaUrl(rawUrl?: string): string | null {
  const [src, setSrc] = useState<string | null>(() => {
    const raw = rawUrl || "";
    return /^(?:data:|https?:|blob:|\/)/i.test(raw) ? raw : null;
  });

  useEffect(() => {
    const raw = rawUrl || "";
    if (!raw) {
      setSrc(null);
      return;
    }
    if (/^(?:data:|https?:|blob:|\/)/i.test(raw)) {
      setSrc(raw);
      return;
    }
    setSrc(null);
    let cancelled = false;
    let objectUrl: string | null = null;
    const storedMedia = isMediaStoreRef(raw);
    const load = storedMedia ? loadMediaObjectUrl(raw) : getChatImageFromIndexedDB(raw.replace(/^asset:\/\//, ""));
    void load.then(value => {
      if (!value) return;
      if (cancelled) {
        if (storedMedia) URL.revokeObjectURL(value);
        return;
      }
      if (storedMedia) objectUrl = value;
      setSrc(value);
    }).catch(() => { if (!cancelled) setSrc(null); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl]);

  return src;
}

function FavoriteVideo({ entry }: { entry: FavoriteEntry }) {
  const src = useFavoriteMediaUrl(entry.mediaUrl);
  return src ? <video className="favorites-entry-image" controls preload="metadata" src={src} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} /> : <span>原视频文件已不可用</span>;
}

function FavoriteAudio({ entry }: { entry: FavoriteEntry }) {
  const src = useFavoriteMediaUrl(entry.mediaUrl);
  const label = typeof entry.mediaData?.label === "string" ? entry.mediaData.label.trim() : "";
  const duration = typeof entry.mediaData?.voiceDuration === "number" ? entry.mediaData.voiceDuration : null;

  return (
    <div className="favorites-entry-audio" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      {src ? <audio controls preload="metadata" src={src}>当前浏览器无法播放这条语音。</audio> : <span>原语音文件已不可用</span>}
      <small>{label || entry.content || "语音消息"}{duration ? ` · ${Math.ceil(duration)} 秒` : ""}</small>
    </div>
  );
}

function splitThinkingContent(content: string): { visible: string; thoughts: string[] } {
  const thoughts: string[] = [];
  const visible = content
    .replace(/<(think|thinking)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, body: string) => {
      const thought = body.trim();
      if (thought) thoughts.push(thought);
      return "\n";
    })
    .replace(/<(think|thinking)\b[^>]*>([\s\S]*)$/gi, (_match, _tag: string, body: string) => {
      const thought = body.trim();
      if (thought) thoughts.push(thought);
      return "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { visible, thoughts };
}

function FavoriteEntryView({ entry, compact = false, foldThinking = false }: { entry: FavoriteEntry; compact?: boolean; foldThinking?: boolean }) {
  const parsed = foldThinking ? splitThinkingContent(entry.content) : { visible: entry.content, thoughts: [] };
  const mediaType = entry.mediaType === "media_file" ? entry.mediaData?.fileType : entry.mediaType;
  return (
    <div className="favorites-entry" data-role={entry.role}>
      <div className="favorites-entry-meta">
        <strong>{entry.senderName}</strong>
        <span>{formatDate(entry.createdAt)}</span>
      </div>
      {parsed.visible && <p className={compact ? "favorites-entry-text is-compact" : "favorites-entry-text"}>{parsed.visible}</p>}
      {mediaType === "image" && <FavoriteImage entry={entry} />}
      {mediaType === "audio" && <FavoriteAudio entry={entry} />}
      {mediaType === "video" && <FavoriteVideo entry={entry} />}
      {mediaType === "sticker" && <FavoriteImage entry={{ ...entry, mediaUrl: typeof entry.mediaData?.stickerUrl === "string" ? entry.mediaData.stickerUrl : entry.mediaUrl }} />}
      {parsed.thoughts.length > 0 && (compact ? (
        <div className="favorites-thinking-compact">思考内容已折叠</div>
      ) : (
        <details className="favorites-thinking">
          <summary><span>思考内容</span><ChevronRight size={14} /></summary>
          <div>{parsed.thoughts.map((thought, index) => <p key={index}>{thought}</p>)}</div>
        </details>
      ))}
    </div>
  );
}

export function FavoritesApp({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<FavoritesTab>("recent");
  const [query, setQuery] = useState("");
  const [scopeKey, setScopeKey] = useState<string>("all");
  const [selectedEntity, setSelectedEntity] = useState<EntitySummary | null>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<FavoriteItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dataOpen, setDataOpen] = useState(false);
  const [exportCharacterId, setExportCharacterId] = useState("");
  const [overwriteImport, setOverwriteImport] = useState(false);
  const [transferBusy, setTransferBusy] = useState("");
  const [transferStatus, setTransferStatus] = useState("");
  const transferLock = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStarted = useRef(false);

  const refresh = useCallback(async () => {
    setItems(await listFavoriteItems());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(FAVORITES_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(FAVORITES_UPDATED_EVENT, refresh);
  }, [refresh]);

  const exportCharacters = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of items) {
      if (item.entityType === "character") names.set(item.entityId, item.entityName);
      item.participantIds.forEach((id, index) => {
        if (!names.has(id)) names.set(id, item.participantNames[index] || id);
      });
    }
    return Array.from(names, ([id, name]) => ({ id, name }));
  }, [items]);

  const exportFavorites = async (entity?: FavoriteExportEntity, name = "全部") => {
    if (transferLock.current) return;
    transferLock.current = true;
    setTransferBusy("导出中…");
    setTransferStatus("");
    try {
      const result = await createBackupBlob(["favorites"], { favoriteEntity: entity });
      if (result.warnings.length) throw new Error(result.warnings.join("；"));
      if (!result.manifest.totalRecords) throw new Error("没有可导出的收藏");
      const safeName = name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
      await downloadFile(result.blob, `收藏-${safeName}-${Date.now()}.zip`);
      setTransferStatus(`已导出 ${result.manifest.totalRecords} 项收藏，包含语音、图片等媒体。`);
    } catch (error) {
      setTransferStatus(error instanceof Error ? error.message : "导出失败，请重试");
    } finally {
      transferLock.current = false;
      setTransferBusy("");
    }
  };

  const importFavorites = async (file: File) => {
    if (transferLock.current) return;
    transferLock.current = true;
    setTransferBusy("导入中…");
    setTransferStatus("");
    try {
      const result = await importBackupBlob(file, ["favorites"], { overwrite: overwriteImport });
      await refresh();
      setDetailItem(null);
      setTransferStatus(!result.added && !result.skipped && !result.overwritten && !result.errors.length ? "文件中没有可导入的收藏。"
        : `导入完成：新增 ${result.added} 项，跳过 ${result.skipped} 项，覆盖 ${result.overwritten} 项。${result.errors.length ? `有 ${result.errors.length} 处失败：${result.errors.slice(0, 2).join("；")}` : ""}`);
      window.dispatchEvent(new CustomEvent(FAVORITES_UPDATED_EVENT));
    } catch (error) {
      setTransferStatus(error instanceof Error ? error.message : "导入失败，请重试");
    } finally {
      transferLock.current = false;
      setTransferBusy("");
    }
  };

  const scopeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) map.set(item.scopeKey, item.scopeLabel);
    return Array.from(map, ([key, label]) => ({ key, label }));
  }, [items]);

  const scopeItems = useMemo(() => items.filter(item => scopeKey === "all" || item.scopeKey === scopeKey), [items, scopeKey]);
  const availableTags = useMemo(() => Array.from(new Set(scopeItems.flatMap(item => item.tags))).sort((a, b) => a.localeCompare(b, "zh-CN")), [scopeItems]);

  const filteredItems = useMemo(() => {
    return scopeItems.filter(item => {
      if (!categoryMatches(item, tab)) return false;
      if (!matchesText(item, query)) return false;
      if (selectedTags.size && !Array.from(selectedTags).every(tag => item.tags.includes(tag))) return false;
      if (selectedEntity) {
        if (item.entityId === selectedEntity.id) return true;
        if (selectedEntity.type === "character" && item.participantIds.includes(selectedEntity.id)) return true;
        return false;
      }
      return true;
    });
  }, [query, scopeItems, selectedEntity, selectedTags, tab]);

  const entities = useMemo(() => {
    const map = new Map<string, EntitySummary>();
    for (const item of scopeItems) {
      if (!categoryMatches(item, tab) || !matchesText(item, query)) continue;
      if (selectedTags.size && !Array.from(selectedTags).every(tag => item.tags.includes(tag))) continue;
      const key = `${item.entityType}:${item.entityId}`;
      const current = map.get(key);
      if (current) {
        current.count += 1;
        if (item.createdAt > current.latestAt) current.latestAt = item.createdAt;
      } else {
        map.set(key, {
          key,
          id: item.entityId,
          type: item.entityType,
          name: item.entityName,
          participantNames: item.participantNames,
          count: 1,
          latestAt: item.createdAt,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }, [query, scopeItems, selectedTags, tab]);

  const toggleTag = (tag: string) => {
    setSelectedTags(previous => {
      const next = new Set(previous);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const enterSelection = (id: string) => {
    setSelectedIds(previous => new Set(previous).add(id));
  };

  const handleCardPointerDown = (event: React.PointerEvent, id: string) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    longPressStarted.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressStarted.current = true;
      enterSelection(id);
      longPressTimer.current = null;
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const handleCardClick = (item: FavoriteItem) => {
    if (longPressStarted.current) {
      longPressStarted.current = false;
      return;
    }
    if (selectedIds.size) {
      setSelectedIds(previous => {
        const next = new Set(previous);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      return;
    }
    setDetailItem(item);
  };

  const removeSelected = async () => {
    await deleteFavoriteItems(Array.from(selectedIds));
    setSelectedIds(new Set());
    await refresh();
  };

  const goBack = () => {
    if (selectedIds.size) {
      setSelectedIds(new Set());
      return;
    }
    if (selectedEntity) {
      setSelectedEntity(null);
      setQuery("");
      return;
    }
    onClose();
  };

  return (
    <section className="favorites-app">
      <ChatPageHeader
        title={selectedIds.size ? `已选 ${selectedIds.size} 项` : selectedEntity?.name || "收藏"}
        left={<button className="page-header-btn" type="button" onClick={goBack} aria-label="返回"><ChevronLeft size={23} /></button>}
        right={selectedIds.size
          ? <button className="page-header-btn favorites-delete-head" type="button" onClick={() => void removeSelected()} aria-label="删除所选"><Trash2 size={19} /></button>
          : <div className="flex items-center gap-1">
              <button className="page-header-btn" type="button" onClick={() => setDataOpen(true)} aria-label="收藏导入导出"><Download size={19} /></button>
              <button className="page-header-btn" type="button" onClick={() => setFilterOpen(previous => !previous)} aria-label="筛选"><Filter size={19} /></button>
            </div>}
      />

      <input ref={importInput} type="file" accept=".zip,application/zip" className="hidden" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void importFavorites(file);
      }} />

      <div className="favorites-toolbar">
        <label className="favorites-search">
          <Search size={16} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={selectedEntity ? `搜索${selectedEntity.name}的收藏` : "搜索角色、群组或收藏内容"}
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清空"><X size={14} /></button>}
        </label>
        {scopeOptions.length > 1 && (
          <select className="favorites-scope-select" value={scopeKey} onChange={event => { setScopeKey(event.target.value); setSelectedEntity(null); }}>
            <option value="all">全部用户与账号</option>
            {scopeOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        )}
        {selectedTags.size > 0 && (
          <div className="favorites-active-tags">
            {Array.from(selectedTags).map(tag => <button type="button" key={tag} onClick={() => toggleTag(tag)}>{tag}<X size={11} /></button>)}
          </div>
        )}
      </div>

      {filterOpen && (
        <div className="favorites-filter-panel">
          <div><strong>按标签筛选</strong><button type="button" onClick={() => setSelectedTags(new Set())}>清空</button></div>
          <div className="favorites-filter-tags">
            {availableTags.length ? availableTags.map(tag => (
              <button type="button" key={tag} data-active={selectedTags.has(tag) ? "1" : "0"} onClick={() => toggleTag(tag)}>
                {selectedTags.has(tag) && <Check size={12} />}{tag}
              </button>
            )) : <span>还没有可筛选的标签</span>}
          </div>
        </div>
      )}

      <main className="favorites-main">
        {loading ? (
          <div className="favorites-empty">正在读取收藏…</div>
        ) : !selectedEntity ? (
          entities.length ? <div className="favorites-entity-list">
            {entities.map(entity => (
              <button type="button" className="favorites-entity-card" key={entity.key} onClick={() => { setSelectedEntity(entity); setQuery(""); }}>
                <span className="favorites-entity-icon">{entity.type === "group" ? <Users size={20} /> : <Bookmark size={20} />}</span>
                <span className="favorites-entity-copy">
                  <strong>{entity.name}</strong>
                  <small>{entity.type === "group" && entity.participantNames.length ? entity.participantNames.join("、") : `${entity.count} 项收藏`}</small>
                </span>
                <span className="favorites-entity-count">{entity.count}</span>
              </button>
            ))}
          </div> : <div className="favorites-empty"><Bookmark size={34} /><strong>还没有收藏</strong><span>长按聊天或剧情消息即可收藏</span></div>
        ) : filteredItems.length ? (
          <div className="favorites-card-list">
            {filteredItems.map(item => {
              const selected = selectedIds.has(item.id);
              const previewEntries = item.entries.slice(0, item.kind === "bundle" ? 2 : 1);
              return (
                <article
                  key={item.id}
                  className="favorites-card"
                  data-selected={selected ? "1" : "0"}
                  onPointerDown={event => handleCardPointerDown(event, item.id)}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onClick={() => handleCardClick(item)}
                >
                  {selected && <span className="favorites-card-check"><Check size={13} /></span>}
                  <header><div><strong>{item.title}</strong><small>{item.containerName}</small></div><time>{formatDate(item.sourceCreatedAt)}</time></header>
                  <div className="favorites-card-entries">
                    {previewEntries.map(entry => <FavoriteEntryView key={entry.id} entry={entry} compact foldThinking={item.category === "story"} />)}
                  </div>
                  {item.entries.length > previewEntries.length && <button className="favorites-expand-note" type="button">展开全部 {item.entries.length} 条</button>}
                  <footer>{item.tags.map(tag => <span key={tag}>{tag}</span>)}</footer>
                </article>
              );
            })}
          </div>
        ) : <div className="favorites-empty"><Search size={32} /><strong>没有找到内容</strong><span>可以调整搜索词或标签筛选</span></div>}
      </main>

      <nav className="favorites-tabs" aria-label="收藏分类">
        <button type="button" data-active={tab === "chat" ? "1" : "0"} onClick={() => { setTab("chat"); setSelectedEntity(null); }}><MessageCircle size={18} /><span>聊天室</span></button>
        <button type="button" data-active={tab === "story" ? "1" : "0"} onClick={() => { setTab("story"); setSelectedEntity(null); }}><Bookmark size={18} /><span>剧情</span></button>
        <button type="button" data-active={tab === "recent" ? "1" : "0"} onClick={() => { setTab("recent"); setSelectedEntity(null); }}><ImageIcon size={18} /><span>最近收藏</span></button>
      </nav>

      {dataOpen && (
        <div className="favorites-detail-backdrop" onClick={() => { if (!transferBusy) setDataOpen(false); }}>
          <section className="favorites-detail" role="dialog" aria-modal="true" aria-label="收藏导入导出" onClick={event => event.stopPropagation()}>
            <header><strong>收藏导入导出</strong><button type="button" disabled={Boolean(transferBusy)} onClick={() => setDataOpen(false)} aria-label="关闭"><X size={19} /></button></header>
            <div className="favorites-detail-body flex flex-col gap-3">
              <p className="menu-desc">导出包含聊天、剧情、动态收藏及语音、图片，不受搜索、标签、账号筛选影响。</p>
              <button type="button" className="ui-btn ui-btn-primary" disabled={Boolean(transferBusy) || loading} onClick={() => void exportFavorites()}><Download size={16} />导出全部收藏</button>
              {selectedEntity && <button type="button" className="ui-btn ui-btn-ghost" disabled={Boolean(transferBusy)} onClick={() => void exportFavorites({ id: selectedEntity.id, type: selectedEntity.type }, selectedEntity.name)}>导出{selectedEntity.name}的全部收藏</button>}
              <label className="flex flex-col gap-2"><span className="menu-label">单个角色</span>
                <select className="ui-input" value={exportCharacterId} disabled={Boolean(transferBusy)} onChange={event => setExportCharacterId(event.target.value)}>
                  <option value="">选择角色</option>
                  {exportCharacters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                </select>
              </label>
              <button type="button" className="ui-btn ui-btn-ghost" disabled={Boolean(transferBusy) || !exportCharacterId} onClick={() => void exportFavorites({ id: exportCharacterId, type: "character" }, exportCharacters.find(character => character.id === exportCharacterId)?.name)}>导出所选角色全部收藏</button>
              <label className="flex items-center gap-2 menu-desc"><input type="checkbox" checked={overwriteImport} disabled={Boolean(transferBusy)} onChange={event => setOverwriteImport(event.target.checked)} />导入时覆盖已存在的收藏</label>
              <button type="button" className="ui-btn ui-btn-ghost" disabled={Boolean(transferBusy)} onClick={() => importInput.current?.click()}><Upload size={16} />导入收藏文件</button>
              <p className="menu-desc" role="status">{transferBusy || transferStatus}</p>
            </div>
          </section>
        </div>
      )}

      {detailItem && (
        <div className="favorites-detail-backdrop" onClick={() => setDetailItem(null)}>
          <section className="favorites-detail" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
            <header>
              <div><strong>{detailItem.title}</strong><span>{detailItem.entityName} · {formatDate(detailItem.sourceCreatedAt)}</span></div>
              <button type="button" onClick={() => setDetailItem(null)} aria-label="关闭"><X size={19} /></button>
            </header>
            <div className="favorites-detail-tags">{detailItem.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
            <div className="favorites-detail-body">
              {detailItem.entries.map(entry => <FavoriteEntryView key={entry.id} entry={entry} foldThinking={detailItem.category === "story"} />)}
            </div>
            <footer>
              <span>收藏于 {formatDate(detailItem.createdAt)}</span>
              <button type="button" onClick={async () => { await deleteFavoriteItems([detailItem.id]); setDetailItem(null); await refresh(); }}><Trash2 size={15} />删除</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
