import type { UserIdentity } from "@/components/settings/user-identity";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const CHAT_ALT_ACCOUNTS_KEY = "ai_phone_chat_alt_accounts_v1";
export const CHAT_ALT_ACCOUNTS_UPDATED_EVENT = "chat-alt-accounts-updated";

registerKvMigration(CHAT_ALT_ACCOUNTS_KEY);

export type ChatAltAccount = {
    id: string;
    /** 界面收纳归属，不继承该身份的人设。 */
    userIdentityId: string;
    nickname: string;
    gender: string;
    age: string;
    signature: string;
    avatarUrl?: string;
    deletedAt?: string;
    /** 该小号自己的好友集合。主号通讯录不会被修改。 */
    friendCharacterIds: string[];
    createdAt: string;
    updatedAt: string;
};

function normalizeAccount(value: Partial<ChatAltAccount>): ChatAltAccount | null {
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const userIdentityId = typeof value.userIdentityId === "string" ? value.userIdentityId.trim() : "";
    if (!id || !userIdentityId) return null;
    const now = new Date().toISOString();
    return {
        id,
        userIdentityId,
        nickname: typeof value.nickname === "string" && value.nickname.trim() ? value.nickname.trim() : "未命名小号",
        gender: typeof value.gender === "string" ? value.gender.trim() : "",
        age: typeof value.age === "string" ? value.age.trim() : "",
        signature: typeof value.signature === "string" ? value.signature.trim() : "",
        avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : undefined,
        deletedAt: typeof value.deletedAt === "string" ? value.deletedAt : undefined,
        friendCharacterIds: Array.from(new Set(Array.isArray(value.friendCharacterIds)
            ? value.friendCharacterIds.filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => item.trim())
            : [])),
        createdAt: typeof value.createdAt === "string" && value.createdAt ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : now,
    };
}

export function loadChatAltAccounts(): ChatAltAccount[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(CHAT_ALT_ACCOUNTS_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.map(item => normalizeAccount(item as Partial<ChatAltAccount>)).filter((item): item is ChatAltAccount => Boolean(item));
    } catch {
        return [];
    }
}

export function saveChatAltAccounts(accounts: ChatAltAccount[]): void {
    if (typeof window === "undefined") return;
    const normalized = accounts.map(item => normalizeAccount(item)).filter((item): item is ChatAltAccount => Boolean(item));
    kvSet(CHAT_ALT_ACCOUNTS_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(CHAT_ALT_ACCOUNTS_UPDATED_EVENT));
}

export function createChatAltAccount(input: Pick<ChatAltAccount, "userIdentityId" | "nickname" | "gender" | "age" | "signature">): ChatAltAccount {
    const now = new Date().toISOString();
    const account: ChatAltAccount = {
        id: `chat-alt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userIdentityId: input.userIdentityId,
        nickname: input.nickname.trim() || "未命名小号",
        gender: input.gender.trim(),
        age: input.age.trim(),
        signature: input.signature.trim(),
        friendCharacterIds: [],
        createdAt: now,
        updatedAt: now,
    };
    saveChatAltAccounts([...loadChatAltAccounts(), account]);
    return account;
}

export function findChatAltAccount(accountId?: string | null): ChatAltAccount | null {
    if (!accountId) return null;
    return loadChatAltAccounts().find(item => item.id === accountId) || null;
}

export function updateChatAltAccount(accountId: string, patch: Partial<Pick<ChatAltAccount, "userIdentityId" | "nickname" | "gender" | "age" | "signature" | "avatarUrl">>): void {
    saveChatAltAccounts(loadChatAltAccounts().map(account => account.id === accountId
        ? { ...account, ...patch, updatedAt: new Date().toISOString() } : account));
}

/** 保留身份资料供历史记忆解析，删除后不再显示为可切换账号。 */
export function deleteChatAltAccount(accountId: string): void {
    saveChatAltAccounts(loadChatAltAccounts().map(account => account.id === accountId
        ? { ...account, deletedAt: new Date().toISOString() } : account));
}

export function addChatAltAccountFriend(accountId: string, characterId: string): void {
    const accounts = loadChatAltAccounts();
    const index = accounts.findIndex(item => item.id === accountId);
    if (index < 0 || accounts[index].friendCharacterIds.includes(characterId)) return;
    accounts[index] = {
        ...accounts[index],
        friendCharacterIds: [...accounts[index].friendCharacterIds, characterId],
        updatedAt: new Date().toISOString(),
    };
    saveChatAltAccounts(accounts);
}

export function removeChatAltAccountFriend(accountId: string, characterId: string): void {
    const accounts = loadChatAltAccounts();
    const index = accounts.findIndex(item => item.id === accountId);
    if (index < 0) return;
    accounts[index] = {
        ...accounts[index],
        friendCharacterIds: accounts[index].friendCharacterIds.filter(item => item !== characterId),
        updatedAt: new Date().toISOString(),
    };
    saveChatAltAccounts(accounts);
}

/** 使用独立资料，模型只接收昵称与填写的人设。 */
export function resolveChatAltAccountIdentity(accountId?: string | null): UserIdentity | null {
    const account = findChatAltAccount(accountId);
    if (!account) return null;
    return {
        id: `chat-alt-identity:${account.id}`,
        name: account.nickname,
        avatarUrl: account.avatarUrl,
        gender: account.gender || "未填写",
        age: account.age || "未填写",
        bio: account.signature,
        occupation: "",
        customSettings: "",
    };
}
