"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { getNativeTimelineEntryKey, loadNativeTimelineAsync, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { MEMORY_SCAN_SOURCES, memorySource, scanShortMemory, type MemoryCandidate } from "@/lib/short-term-memory-repair";
import { importShortMemories, persistShortMemoryChanges, restoreNativeTimelineEntries } from "@/lib/short-term-memory-records";
import { MEMORY_PASTE_EXAMPLES, parseChatMemoryFile, parseMemoryPaste, type ManualMemorySource } from "@/lib/short-term-memory-import";

export function MemoryRepairDialog({ characterId, characterName, scope, current, onClose, onImported }: {
  characterId: string; characterName: string; scope: "short" | "shared"; current: NativeTimelineEntry[]; onClose: () => void; onImported: () => void;
}) {
  const [sources, setSources] = useState(new Set(["chat", "group", "moments", "story", "vn"]));
  const [candidates, setCandidates] = useState<MemoryCandidate[] | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState({ scanned: 0, skipped: 0 });
  const [manualOpen, setManualOpen] = useState(false), [source, setSource] = useState<ManualMemorySource>("chat"), [text, setText] = useState("");
  const controller = useRef<AbortController | null>(null), fileRef = useRef<HTMLInputElement>(null);
  const mode = useRef<"scan" | "manual">("scan");
  useEffect(() => () => controller.current?.abort(), []);
  const begin = () => { controller.current?.abort(); const run = new AbortController(); controller.current = run; setBusy(true); setNotice(""); return run; };
  const scan = async () => {
    const run = begin(); setCandidates(null); setSelected(new Set());
    try {
      const result = await scanShortMemory(characterId, scope, [...sources], current, run.signal);
      if (run.signal.aborted) return;
      mode.current = "scan"; setCandidates(result.candidates); setStats(result); setLimit(30);
    } catch (error) { if (!run.signal.aborted) setNotice(error instanceof Error ? error.message : "扫描失败"); }
    finally { if (controller.current === run) setBusy(false); }
  };
  const preview = async (content: string, kind: ManualMemorySource) => {
    const run = begin(); setCandidates(null); setSelected(new Set());
    try {
      const entries = kind === "chat" ? parseChatMemoryFile(content, scope, characterName) : parseMemoryPaste(content, kind, scope, characterId);
      if (!entries.length) throw Error("没有可导入的消息");
      const existing = new Set((await loadNativeTimelineAsync(characterId, { includeDeleted: true, signal: run.signal })).map(getNativeTimelineEntryKey));
      const unique = new Map(entries.map(entry => [getNativeTimelineEntryKey(entry), entry]));
      if (run.signal.aborted) return;
      mode.current = "manual";
      setCandidates([...unique.values()].map(entry => ({ entry, status: existing.has(getNativeTimelineEntryKey(entry)) ? "overwrite" : "new" })));
      setStats({ scanned: entries.length, skipped: entries.length - unique.size }); setSelected(new Set()); setLimit(30);
    } catch (error) { if (!run.signal.aborted) setNotice(error instanceof Error ? error.message : "格式无法识别"); }
    finally { if (controller.current === run) setBusy(false); }
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { setNotice("文件超过 50 MB，请拆分导出后导入"); return; }
    const run = begin(); setCandidates(null); setSelected(new Set());
    try { const content = await file.text(); if (!run.signal.aborted) await preview(content, "chat"); }
    catch (error) { if (!run.signal.aborted) setNotice(error instanceof Error ? error.message : "文件读取失败"); }
    finally { if (controller.current === run) setBusy(false); }
  };
  const importSelected = async () => {
    const entries = candidates?.filter(item => selected.has(getNativeTimelineEntryKey(item.entry))).map(item => item.entry) || [];
    if (!entries.length) return;
    setBusy(true); setSaving(true); setNotice("");
    try {
      if (mode.current === "manual") importShortMemories(characterId, entries);
      else {
        const missing = candidates?.filter(item => item.status === "missing" && selected.has(getNativeTimelineEntryKey(item.entry))).map(item => item.entry) || [];
        if (missing.length) importShortMemories(characterId, missing);
        restoreNativeTimelineEntries(characterId, entries);
      }
      await persistShortMemoryChanges(characterId);
      onImported(); onClose();
    } catch (error) { setNotice(`本机保存尚未完成，请重试：${error instanceof Error ? error.message : "数据库写入失败"}`); }
    finally { setBusy(false); setSaving(false); }
  };
  const status = { deleted: "已删除", missing: "未在当前记忆列表中", new: "新增", overwrite: "覆盖已有记忆" };
  const allSelected = !!candidates?.length && selected.size === candidates.length;
  return createPortal(<div className="modal-overlay memory-repair-overlay" role="dialog" aria-modal="true" aria-label="扫描遗漏／误删记忆">
    <section className="modal-dialog memory-repair-dialog">
      <header><div><strong>扫描遗漏／误删记忆</strong><small>{characterName} · {scope === "shared" ? "共享事件" : "短期记忆"}</small></div><button type="button" aria-label="关闭记忆扫描" disabled={saving} onClick={onClose}><X size={20} /></button></header>
      <main>
        <p>选择来源，从本机已保存的记录核对。剧情主线、分线一起扫描；其他 APP 仅扫描已保存的记忆事件。日记本次不扫描。</p>
        <div className="memory-repair-actions"><button type="button" disabled={busy} onClick={() => setSources(new Set(MEMORY_SCAN_SOURCES.map(([id]) => id)))}>全选来源</button><button type="button" disabled={busy} onClick={() => setSources(new Set())}>取消来源全选</button></div>
        <div className="memory-repair-sources">{MEMORY_SCAN_SOURCES.map(([id, name]) => <label key={id}><input type="checkbox" disabled={busy} checked={sources.has(id)} onChange={event => setSources(previous => { const next = new Set(previous); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />{name}</label>)}</div>
        <button type="button" className="ui-btn ui-btn-action" disabled={busy || !sources.size} onClick={() => void scan()}>开始扫描</button>
        {busy && <div role="status">{saving ? "正在保存所选记忆…" : <>正在读取、核对本机记录… <button type="button" onClick={() => { controller.current?.abort(); setBusy(false); setNotice("已停止，本次没有导入任何记忆。"); }}>停止</button></>}</div>}
        <details open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}><summary>手动增加记忆</summary>
          <label>来源<select aria-label="手动记忆来源" value={source} disabled={busy} onChange={event => { setSource(event.target.value as ManualMemorySource); setText(""); }}>
            <option value="chat">聊天记录文件</option><option value="moments">朋友圈粘贴</option><option value="story">剧情粘贴</option><option value="vn">漫卷粘贴</option><option disabled>查手机、小红书及其他 APP（待开放）</option>
          </select></label>
          {source === "chat" ? <><p>使用现有 Float 聊天记录 JSON 格式，按原记录编号覆盖重复项、新增缺少项。这里只补充角色记忆。</p><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ""; }} /><button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>选择聊天记录文件</button></>
            : <><p>每条填写原时间和昵称，多条用单独一行 --- 分开。可填“编号”以便后续覆盖同一记录；缺少时间无法导入。</p><pre>{MEMORY_PASTE_EXAMPLES[source]}</pre><textarea aria-label="粘贴记忆内容" rows={7} value={text} disabled={busy} onChange={event => setText(event.target.value)} /><button type="button" disabled={busy || !text.trim()} onClick={() => void preview(text, source)}>预览待导入内容</button></>}
        </details>
        {notice && <p role="status">{notice}</p>}
        {candidates && <section className="memory-repair-results"><h3>{mode.current === "scan" ? "扫描结果" : "导入预览"}</h3><p>已核对 {stats.scanned} 条，过滤已有／重复 {stats.skipped} 条，待选 {candidates.length} 条。</p>
          <button type="button" disabled={busy || !candidates.length} onClick={() => setSelected(allSelected ? new Set() : new Set(candidates.map(item => getNativeTimelineEntryKey(item.entry))))}>{allSelected ? "取消全选结果" : "全选本次全部结果"}</button>
          {!candidates.length && <p>本次范围内没有发现可恢复的遗漏或已删除记录。未保存过的事件、原记录已彻底删除的内容不在可恢复范围内。</p>}
          {candidates.slice(0, limit).map(({ entry, status: state }) => { const key = getNativeTimelineEntryKey(entry); return <article key={key}><label><input type="checkbox" checked={selected.has(key)} disabled={busy} aria-label={`选择记忆 ${entry.id}`} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(key); else next.delete(key); return next; })} /><span>{status[state]} · {entry.customAppLabel || MEMORY_SCAN_SOURCES.find(([id]) => id === memorySource(entry))?.[1] || "记忆"}</span></label>
            <small>{new Date(entry.timestamp).toLocaleString()} {entry.userNickname || entry.groupName} {entry.sourceLabel}</small><details><summary>{entry.content.slice(0, 120)}{entry.content.length > 120 ? "…" : ""}</summary><p>{entry.content}</p></details></article>; })}
          {limit < candidates.length && <button type="button" onClick={() => setLimit(value => value + 30)}>加载更多结果</button>}
        </section>}
      </main>
      <footer><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="button" disabled={busy || !selected.size} onClick={importSelected}>导入选中项（{selected.size}）</button></footer>
    </section>
  </div>, document.querySelector(".phone-shell") || document.body);
}
