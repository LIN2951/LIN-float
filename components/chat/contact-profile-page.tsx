"use client";

import { useEffect, useState } from "react";
import { ChevronRight, MessageCircle, Phone, Video } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadChatContacts, loadChatSessions, resolveChatCharacterAvatar } from "@/lib/chat-storage";
import { loadChatScope } from "@/lib/chat-scope-storage";
import { loadCharacterWorldGroups } from "@/lib/character-world-storage";
import { getAllPosts } from "@/lib/moments-storage";
import { getCharacterMomentPosts } from "@/lib/character-moments-profile";
import { PageShell } from "@/components/ui/page-shell";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { MomentsFeed } from "./moments-feed";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";

function MomentThumbnail({ photoUrl, content }: { photoUrl?: string; content: string }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let active = true;
    setSource(undefined);
    if (photoUrl?.startsWith("asset://")) getChatImageFromIndexedDB(photoUrl.slice(8)).then(value => { if (active) setSource(value || undefined); });
    else setSource(photoUrl);
    return () => { active = false; };
  }, [photoUrl]);
  return <span>{source ? <img src={source} alt="动态图片" /> : content.slice(0, 22) || "图片动态"}</span>;
}

export function ContactProfilePage({ character, onBack, onMessage, onCall }: {
  character: Character; onBack: () => void; onMessage: () => void; onCall: (type: "voice" | "video") => void;
}) {
  const [showMoments, setShowMoments] = useState(false);
  const [showCalls, setShowCalls] = useState(false);
  const [, setVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setVersion(value => value + 1);
    window.addEventListener("moments-updated", refresh);
    return () => window.removeEventListener("moments-updated", refresh);
  }, []);
  const scope = loadChatScope();
  const session = loadChatSessions().find(item => !item.isGroup && item.contactId === character.id && (item.chatAccountId || null) === scope.chatAccountId);
  const contact = loadChatContacts().find(item => item.characterId === character.id);
  const remark = session?.alias?.trim() || (!scope.chatAccountId ? contact?.nickname?.trim() : "") || "";
  const region = loadCharacterWorldGroups().find(world => world.memberIds.includes(character.id))?.name || "默认世界";
  const avatar = resolveChatCharacterAvatar(character);
  const posts = getCharacterMomentPosts(getAllPosts(), character.id);
  // Re-read the current local records when returning from the personal timeline.
  if (showMoments) return <MomentsFeed key={character.id} profileCharacterId={character.id} onCloseApp={() => { setShowMoments(false); setVersion(value => value + 1); }} />;

  return <PageShell title="联系人" onBack={onBack} className="contact-profile-page">
    <section className="contact-profile-identity">
      <div className="contact-profile-avatar">{avatar ? <img src={avatar} alt={character.name} /> : <ChatFallbackAvatar />}</div>
      <div className="contact-profile-info">
        <h1>{remark || character.name}</h1>
        <dl>
          <div><dt>备注</dt><dd>{remark || "未设置"}</dd></div>
          <div><dt>昵称</dt><dd>{character.name}</dd></div>
          <div><dt>微信号</dt><dd>{character.wechatID || "未设置"}</dd></div>
          <div><dt>地区</dt><dd>{region}</dd></div>
        </dl>
      </div>
    </section>
    <section className="contact-profile-section">
      <button type="button" className="contact-profile-moments" onClick={() => setShowMoments(true)}>
        <span>朋友圈</span><span className="contact-profile-moment-previews">{posts.slice(0, 3).map(post => <MomentThumbnail key={post.id} content={post.content} photoUrl={post.photoUrl} />)}{!posts.length && <small>暂无动态</small>}</span><ChevronRight size={18} />
      </button>
    </section>
    <section className="contact-profile-section contact-profile-actions">
      <button type="button" onClick={onMessage}><MessageCircle size={19} />发消息</button>
      <button type="button" aria-expanded={showCalls} onClick={() => setShowCalls(value => !value)}><Video size={20} />音视频通话</button>
      {showCalls && <div className="contact-profile-call-options"><button type="button" onClick={() => onCall("voice")}><Phone size={18} />语音通话</button><button type="button" onClick={() => onCall("video")}><Video size={18} />视频通话</button></div>}
    </section>
  </PageShell>;
}
