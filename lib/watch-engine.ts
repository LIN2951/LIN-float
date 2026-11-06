// lib/watch-engine.ts — 「一起看」角色陪看引擎：角色聊天回复 + 角色弹幕
"use client";

import { sendLLMRequest } from "./chat-engine";
import type { LLMMessage } from "./llm-prompt-assembler";
import type { Character } from "./character-types";
import { loadBindingConfig, resolveBinding, resolveUserIdentity, loadApiConfigs, loadPresets } from "./settings-storage";
import type { WatchChatMsg, WatchVideoItem } from "./watch-storage";

export type WatchMeta = {
    ok: boolean;
    source?: WatchVideoItem["source"];
    title?: string;
    desc?: string;
    cover?: string;
    owner?: string;
    embedUrl?: string;
    directUrl?: string;
    error?: string;
};

/** 通过服务端路由解析链接元数据（标题/简介/封面/可嵌入地址） */
export async function fetchWatchMeta(url: string): Promise<WatchMeta> {
    try {
        const res = await fetch(`/api/watch/meta?url=${encodeURIComponent(url)}`, { cache: "no-store" });
        const data = (await res.json()) as WatchMeta;
        return data;
    } catch {
        return { ok: false, error: "网络请求失败，请稍后重试" };
    }
}

function resolveWatchLlm(characterId?: string) {
    const binding = loadBindingConfig();
    const slot = resolveBinding(binding, characterId, "watch");
    const apiConfigs = loadApiConfigs();
    const api = apiConfigs.find(c => c.id === slot.apiConfigId)
        ?? apiConfigs.find(c => c.id === binding.globalDefaults.apiConfigId)
        ?? null;
    const preset = loadPresets().find(p => p.id === slot.presetId) ?? null;
    return { api, preset };
}

function userDisplayName(characterId?: string): string {
    try {
        return resolveUserIdentity(characterId, "watch")?.name?.trim() || "我";
    } catch {
        return "我";
    }
}

function buildVideoContext(video: WatchVideoItem): string {
    const parts = [
        `视频标题：《${video.title}》`,
        video.owner ? `作者/来源：${video.owner}` : "",
        video.desc ? `剧情/简介：${video.desc.slice(0, 900)}` : "（没有更多简介，就根据标题自然发挥，不要编造具体剧集细节）",
    ];
    return parts.filter(Boolean).join("\n");
}

function buildSystemPrompt(char: Character, video: WatchVideoItem, others: Character[], userName: string): string {
    const persona = [char.persona, char.personality].filter(Boolean).join("\n");
    const otherNames = others.map(o => o.name).join("、");
    return [
        `你是${char.name}。${persona ? `\n${persona}` : ""}`,
        ``,
        `现在你和${userName}${otherNames ? `、${otherNames}` : ""}一起窝在「一起看」房间里看同一个视频，边看边聊。`,
        buildVideoContext(video),
        ``,
        `要求：`,
        `1. 用微信聊天一样的口吻，像真人发消息，1~2 句以内，绝对不要长篇大论。`,
        `2. 以${char.name}的性格对画面/剧情/弹幕氛围发表真实反应，可以吐槽、花痴、科普、接梗。`,
        `3. 你是在“看”这个视频：可以谈论标题和简介里的内容，但不要声称看到了简介之外的实际画面细节。`,
        `4. 只输出 JSON，格式：{"reply":"聊天内容","danmaku":"一条不超过20字的弹幕，不想发就空字符串"}。不要输出任何其他文字。`,
    ].join("\n");
}

export type WatchReply = { reply: string; danmaku: string };

function parseWatchReply(raw: string): WatchReply {
    const text = raw.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            const obj = JSON.parse(match[0]) as { reply?: unknown; danmaku?: unknown };
            return {
                reply: typeof obj.reply === "string" ? obj.reply.trim() : "",
                danmaku: typeof obj.danmaku === "string" ? obj.danmaku.trim().slice(0, 24) : "",
            };
        } catch { /* fallthrough */ }
    }
    return { reply: text.replace(/^["'{]+|["'}]+$/g, "").slice(0, 300), danmaku: "" };
}

function buildHistoryMessages(
    video: WatchVideoItem,
    char: Character,
    chat: WatchChatMsg[],
    others: Character[],
    userName: string,
): LLMMessage[] {
    const charNameOf = new Map<string, string>([[char.id, char.name], ...others.map(o => [o.id, o.name] as const)]);
    const recent = chat.slice(-14);
    return recent.map((msg): LLMMessage => {
        if (msg.role === "character" && msg.characterId === char.id) {
            return { role: "assistant", content: msg.text } as LLMMessage;
        }
        const speaker = msg.role === "user" ? userName : (msg.characterId ? charNameOf.get(msg.characterId) : null) ?? msg.name;
        return { role: "user", content: `${speaker}：${msg.text}` } as LLMMessage;
    });
}

/**
 * 让一位被邀请的角色基于房间上下文发言（含可选弹幕）。
 * trigger：用户刚说的话；为空 = 剧情氛围主动发言。
 */
export async function generateWatchReply(params: {
    character: Character;
    others: Character[];
    video: WatchVideoItem;
    chat: WatchChatMsg[];
    trigger?: string;
}): Promise<WatchReply> {
    const { character, others, video, chat, trigger } = params;
    const { api, preset } = resolveWatchLlm(character.id);
    if (!api) throw new Error("请先在「设置 → API」里配置聊天模型，角色才能陪你看片");
    const userName = userDisplayName(character.id);

    const messages: LLMMessage[] = [
        { role: "system", content: buildSystemPrompt(character, video, others, userName) } as LLMMessage,
        ...buildHistoryMessages(video, character, chat, others, userName),
        {
            role: "user",
            content: trigger
                ? `${userName}刚说：「${trigger}」。接话吧。`
                : "剧情继续往前播了一点，随口发一句你现在的反应（吐槽/感叹/科普都行）。",
        } as LLMMessage,
    ];

    const raw = await sendLLMRequest(api, preset, messages, [], {
        characterName: character.name,
        userName,
    }, { appId: "watch", skipOutputRegex: true });

    return parseWatchReply(raw);
}
