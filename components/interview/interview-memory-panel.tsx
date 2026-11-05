"use client";

import { useState } from "react";
import type { InterviewIssue } from "@/lib/interview-magazine-types";
import { getInterviewMemoryRecipients, interviewIssueParticipants, writeInterviewIssueMemory } from "@/lib/interview-magazine-memory-write";
import { renderUserNameMacro } from "@/lib/user-macro";

export function InterviewMemoryPanel({ issue, onSaved }: { issue: InterviewIssue; onSaved: (issue: InterviewIssue) => void }) {
  const [summary, setSummary] = useState(() => renderUserNameMacro(issue.article.memorySummary || "", issue.userName || "我"));
  const [selected, setSelected] = useState<string[]>([]);
  const [written, setWritten] = useState(() => getInterviewMemoryRecipients(issue));
  const [notice, setNotice] = useState("");
  const guests = interviewIssueParticipants(issue);
  return <section className="interview-glass-panel p-5 mt-12 text-white/75">
    <h3 className="text-white text-base mb-3">本次访谈记忆</h3>
    <p className="text-xs text-white/45 leading-relaxed mb-4">成刊不会自动写入。预览或编辑摘要，再选择要写入的受访角色；这里只写最近记忆，不额外调用模型。</p>
    <textarea aria-label="访谈记忆摘要" className="interview-glass-input w-full p-3 text-sm" rows={5} maxLength={1800} value={summary} onChange={event => setSummary(event.target.value)} />
    <div className="flex flex-col gap-3 my-4" role="group" aria-label="选择记忆角色">
      {guests.map(guest => <label key={guest.id} className="flex items-center gap-2 text-sm">
        <input aria-label={guest.name} type="checkbox" checked={selected.includes(guest.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, guest.id] : previous.filter(id => id !== guest.id))} />
        {guest.name}{written.includes(guest.id) && <small className="text-white/40">已写入，可更新</small>}
      </label>)}
    </div>
    <button type="button" className="interview-primary-btn w-full" disabled={!selected.length || !summary.trim()} onClick={() => {
      try {
        const next = writeInterviewIssueMemory(issue, selected, summary);
        setWritten(getInterviewMemoryRecipients(next));
        setNotice(`已写入${guests.filter(guest => selected.includes(guest.id)).map(guest => guest.name).join("、")}的最近记忆`);
        onSaved(next);
      } catch (error) { setNotice(error instanceof Error ? error.message : "记忆写入失败"); }
    }}>写入所选角色最近记忆</button>
    <p role="status" className="text-xs text-white/50 mt-3">{notice || "不选择、不点击写入，就只保存在刊物中。再次写入仅更新勾选角色；记忆显示遵循来源设置。"}</p>
  </section>;
}
