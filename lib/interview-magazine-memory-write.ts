import type { InterviewIssue } from "./interview-magazine-types";
import { loadInterviewMagazineProjectionEntries, recordInterviewMagazineProjectionEvent } from "./interview-magazine-memory";
import { loadInterviewIssues, saveInterviewIssue } from "./interview-magazine-storage";
import { incrementEventCounter } from "./memory-storage";
import { normalizeUserNameToMacro } from "./user-macro";

export function interviewIssueParticipants(issue: InterviewIssue): { id: string; name: string }[] {
  if (issue.guestSnapshots?.length) return issue.guestSnapshots.map(guest => ({ id: guest.characterId, name: guest.characterName }));
  return [...new Set(issue.characterIds?.length ? issue.characterIds : [issue.characterId])]
    .filter(Boolean).map((id, index) => ({ id, name: issue.characterNames?.[index] || (index === 0 ? issue.characterName : id) }));
}

export function getInterviewMemoryRecipients(issue: InterviewIssue): string[] {
  return interviewIssueParticipants(issue).filter(guest => loadInterviewMagazineProjectionEntries(guest.id).some(entry => entry.issueId === issue.id)).map(guest => guest.id);
}

/** Explicit local write only; reading a memory or composing an issue never calls this. */
export function writeInterviewIssueMemory(issue: InterviewIssue, selected: string[], summary: string): InterviewIssue {
  const current = loadInterviewIssues().find(item => item.id === issue.id) || issue;
  const guests = interviewIssueParticipants(current);
  const ids = [...new Set(selected)];
  if (!ids.length) throw new Error("请选择要写入记忆的角色");
  if (ids.some(id => !guests.some(guest => guest.id === id))) throw new Error("只能写入本次受访角色的记忆");
  const content = summary.trim();
  if (!content) throw new Error("记忆摘要不能为空");
  if (content.length > 1800) throw new Error("记忆摘要不能超过1800字");
  const previous = getInterviewMemoryRecipients(current);
  const userAnswered = current.transcript.some(message => message.role === "user" && message.kind !== "question");
  const userHosted = current.transcript.some(message => message.role === "user" && message.kind === "question");
  const entry = recordInterviewMagazineProjectionEvent({
    issueId: current.id, issueNumber: current.issueNumber, title: current.article.title, theme: current.theme,
    characterIds: guests.map(guest => guest.id), characterNames: guests.map(guest => guest.name), recipientCharacterIds: ids,
    userName: current.userName, userRole: current.options ? userAnswered ? "guest" : userHosted ? "host" : "observer" : undefined,
    summary: content, timestamp: current.createdAt,
  });
  if (!entry) throw new Error("访谈记忆写入失败");
  for (const id of ids) if (!previous.includes(id)) incrementEventCounter(id);
  const next: InterviewIssue = { ...current, article: { ...current.article, memorySummary: normalizeUserNameToMacro(content, current.userName) },
    memoryWrittenCharacterIds: [...new Set([...previous, ...ids])], updatedAt: new Date().toISOString() };
  saveInterviewIssue(next);
  return next;
}
