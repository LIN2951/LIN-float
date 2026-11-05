import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequestPreferStream, sendLLMStreamRequest, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { STORY_PARSER_VERSION } from "./story-parser";
import { loadStoryMessages, replaceStoryMessages, resolveActiveStorySchemes, type StoryCharacterSettings, type StoryGlobalSettings, type StoryMessage } from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { formatPromptTimestamp } from "./prompt-time";

const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary,story_status,story_theater";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking,story_theater";
const STORY_VOICE_FORMAT_PROMPT = `# 剧情正文格式
请使用与“独家特调”一致的正文语义格式：
- 「对白」：仅包裹角色真正说出口的人声；每次说话分别包裹，不要在括号内重复角色名。
- *心声*：包裹角色没有说出口的内心想法。
- 【场景】：单独一行，用于地点、时间或场景过场。
- ~强调~：只强调需要突出的短语。
- “……”：只用于物品、动作、环境等非人声发出的声音，不作为角色对白。
- 对白标点唯一格式：无论用户或历史消息里的对话使用什么标点形式（“”、""、『』、''等），你输出的角色对白一律使用「」，不要模仿用户的标点。
旁白、动作以及用户的话不得写进「」；不要解释这些格式，也不要输出额外的语音清单。`;

function buildStoryBodyFormatPrompt(settings?: StoryCharacterSettings): string {
  let prompt = STORY_VOICE_FORMAT_PROMPT;
  if (settings?.innerThoughtGenerationEnabled === true) {
    prompt = prompt.replace("- *心声*：包裹角色没有说出口的内心想法。",
      "- *心声*：请结合在场角色的人设、经历和当前情境，自然补充适量未说出口的心理描写，用单个星号包裹为 *心声内容*。只描写角色，不替用户编造心理或决定；按剧情需要适量使用，保留正常的旁白、动作和对白。");
  }
  if (settings?.emphasisGenerationEnabled === true) {
    prompt = prompt.replace("- ~强调~：只强调需要突出的短语。",
      "- **重点**：请结合当前剧情，适量选出重要的情绪、动作或句子，用双星号包裹为 **重点内容**。避免整段加粗，避免反复强调同一句话。");
  }
  return prompt;
}

export type StoryGenerationOptions = {
  sessionFoldTags?: string;
  sessionContextExcludedTags?: string;
  settings?: StoryCharacterSettings;
  globalSettings?: StoryGlobalSettings;
  floatingChatContext?: string;
  /** 多人剧情角色列表；第一个角色仍作为 API、预设和语音绑定的主角色。 */
  participantIds?: string[];
  storyMemory?: {
    independent?: boolean;
    inheritRecentMemory?: boolean;
    startedAt?: string;
  };
  /** 仅本次重试生效的隐藏额外要求，不写入剧情消息。 */
  retryInstruction?: string;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
};

function selectStoryPresetPrompts(preset: PresetConfig | null, selectedIds?: string[]): PresetConfig | null {
  if (!preset || selectedIds === undefined) return preset;
  const allowed = new Set(selectedIds);
  return {
    ...preset,
    prompts: preset.prompts.map((prompt) => prompt.marker ? prompt : { ...prompt, enabled: prompt.enabled && allowed.has(prompt.identifier) }),
    prompt_order: preset.prompt_order,
  };
}

function buildStorySettingsPrompt(
  settings: StoryCharacterSettings | undefined,
  userName: string,
  globalSettings?: StoryGlobalSettings,
  now = new Date(),
): string {
  const effective = settings || {};
  // 字数收敛到 50–10000：用户存 0/负数按 50 生效，超过 10000 按 10000 生效
  const minChars = Math.max(50, Math.min(10000, effective.minChars ?? 800));
  const maxChars = Math.max(minChars, Math.min(10000, effective.maxChars ?? 1500));
  const perspective = effective.userPerspective === "third"
    ? "使用第三人称“TA”称呼用户"
    : effective.userPerspective === "username"
      ? `使用用户名“${userName}”称呼用户`
      : "使用第二人称“你”称呼用户";
  // 方案定义统一存于公用仓库，角色设置只带“启用哪一个”的 id
  const { proseStyle, status, theater } = resolveActiveStorySchemes(effective);
  const proseRequirement = proseStyle?.prompt?.trim()
    ? `采用【${proseStyle.name}】文风：${proseStyle.prompt.trim()}`
    : (effective.proseStylePrompt?.trim() || effective.proseStyle?.trim() || "自然、连贯地推进剧情");
  return [
    "# 最高优先级：本轮剧情输出要求",
    `1. 人称：${perspective}。`,
    `2. 文风：${proseRequirement}`,
    `3. 字数：正文以 ${minChars}—${maxChars} 字为目标；不得为了凑字数重复内容。`,
    globalSettings?.timeAware !== false ? `4. 时间感知：当前时间为 ${formatPromptTimestamp(now.toISOString()) || now.toLocaleString()}，请正确理解时间先后、间隔和昼夜，不要虚构冲突时间。` : "",
    "输出前请静默检查人称、文风和字数是否全部满足，不要展示检查过程。",
    // 新建方案 prompt 留空时不注入（避免出现“文风方案【xxx】：”这样的空行）
    effective.extraPrompt?.trim() ? `额外要求：${effective.extraPrompt.trim()}` : "",
    ...(effective.customPromptEntries || []).filter((item) => item.enabled && item.content.trim()).map((item) => `专属条目【${item.name || "未命名"}】：${item.content.trim()}`),
    effective.statusGenerationEnabled !== false ? (status?.prompt?.trim() || "") : "",
    effective.theaterGenerationEnabled !== false ? (theater?.prompt?.trim() || "") : "",
  ].filter(Boolean).join("\n");
}

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  const tags = Array.from(new Set((excludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS).split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
  return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.contextRole || message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
  };
}

function resolveStoryConfigs(characterId: string): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> 绑定管理 -> 剧情 to assign one.`);
  }

  const apiConfig = loadApiConfigs().find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null;
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === characterId);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = storyOverrideRegexIds && storyOverrideRegexIds.length > 0
    ? storyOverrideRegexIds
    : activeSlot.regexIds || [];
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

function mergeParticipantWorldBooks(base: WorldBookConfig[], participantIds?: string[]): WorldBookConfig[] {
  const ids = Array.from(new Set(participantIds || [])).filter(Boolean);
  if (ids.length <= 1) return base;
  const bindings = loadBindingConfig();
  const allWorldBooks = loadWorldBooks();
  const merged = new Map(base.map((book) => [book.id, book]));
  for (const id of ids) {
    const slot = resolveBinding(bindings, id, "story");
    for (const worldBookId of slot.worldBookIds || []) {
      const book = allWorldBooks.find((item) => item.id === worldBookId);
      if (book) merged.set(book.id, book);
    }
  }
  return [...merged.values()];
}

export function getStoryRenderSignature(characterId: string): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterId);
  return {
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

export async function generateStoryCompletion(
  characterId: string,
  history: StoryMessage[],
  options?: StoryGenerationOptions,
): Promise<StoryGenerationResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset: resolvedPreset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId);
  const preset = selectStoryPresetPrompts(resolvedPreset, options?.settings?.enabledPresetPromptIds);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(
    characterId,
    history,
    preset,
    regexes,
    worldBooks,
    effectiveContextExcludedTags,
    options?.settings,
    options?.globalSettings,
    options?.floatingChatContext,
    options?.participantIds,
    options?.storyMemory,
  );
  if (options?.retryInstruction?.trim()) {
    llmMessages.push({
      role: "system",
      content: `【本次重新生成额外要求】\n${options.retryInstruction.trim()}\n只在本次重新生成中遵守；不要复述、解释或向用户展示这段隐藏要求。`,
    });
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "用户");

  let rawOutput: string;
  if (options?.globalSettings?.streamingEnabled) {
    let receivedDelta = false;
    try {
      const streamed = await sendLLMStreamRequest(apiConfig, preset, llmMessages, regexes, {
        characterName: character.name,
      }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal }, {
        onDelta: (text) => {
          receivedDelta = true;
          options.onDelta?.(text);
        },
      });
      rawOutput = streamed.content;
    } catch (error) {
      // 某些中转只是不支持 SSE：在尚未吐出任何正文时安全回退普通生成；
      // 已经吐过增量则不重试，避免一次操作生成两份互相不同的正文。
      if (receivedDelta || options.signal?.aborted) throw error;
      rawOutput = await sendLLMRequestPreferStream(apiConfig, preset, llmMessages, regexes, {
        characterName: character.name,
      }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });
    }
  } else {
    // 关闭逐字显示时仍优先使用流式传输，在后台收齐全文后一次性展示，避免 iOS 长请求超时。
    rawOutput = await sendLLMRequestPreferStream(apiConfig, preset, llmMessages, regexes, {
      characterName: character.name,
    }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });
  }

  const parsed = parseStoryResponse(rawOutput, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
  settings?: StoryCharacterSettings,
  globalSettings?: StoryGlobalSettings,
  floatingChatContext?: string,
  participantIds?: string[],
  storyMemory?: StoryGenerationOptions["storyMemory"],
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const allCharacters = loadCharacters();
  const participantCharacters = Array.from(new Set([characterId, ...(participantIds || [])]))
    .map((id) => allCharacters.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const effectiveWorldBooks = mergeParticipantWorldBooks(worldBooks, participantCharacters.map((item) => item.id));
  const isEnsemble = participantCharacters.length > 1;
  const historyMessages = history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const memConfig = loadMemoryConfig();
  const independent = Boolean(storyMemory?.independent);
  const timeAware = globalSettings?.timeAware !== false;
  const context = independent
    ? {
      recentBlocks: [],
      truncatedHistory: historyMessages,
      wbActivationContext: historyMessages.slice(-10).map((message) => message.content).join("\n"),
      unifiedRecentItems: [],
    }
    : prepareShortTermContext(characterId, "story", {
      userName: userIdentity?.name ?? "用户",
      history: historyMessages,
      afterTimestamp: storyMemory?.inheritRecentMemory === false ? storyMemory.startedAt : undefined,
      timeAware,
    });
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = context;

  let memories: Awaited<ReturnType<typeof retrieveMemoriesForPrompt>> | null = null;
  let coreMemories: Awaited<ReturnType<typeof retrieveCoreMemoriesForPrompt>> | null = null;
  if (!independent) {
    [memories, coreMemories] = await Promise.all([
      retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
      retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
    ]);
  }

  const now = new Date();

  const messages = assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks: effectiveWorldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: independent || isEnsemble ? undefined : buildCalendarScheduleMarker("character", characterId, getWeekStartIso(now)),
    currentSchedule: independent || isEnsemble ? undefined : getCurrentCalendarScheduleForPrompt("character", characterId, now),
    coreMemories: !isEnsemble && coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: !isEnsemble && memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks: isEnsemble ? [] : recentBlocks,
    unifiedRecentItems: isEnsemble ? [] : unifiedRecentItems,
    timeAware,
    characterRelations: independent || isEnsemble ? null : undefined,
    dwellingContext: independent || isEnsemble ? null : undefined,
  });
  const settingsPrompt = buildStorySettingsPrompt(settings, userIdentity?.name ?? "用户", globalSettings, now);
  if (participantCharacters.length > 1) {
    const participantContexts = await Promise.all(participantCharacters.map(async (item) => {
      const identity = resolveUserIdentity(item.id, "story");
      if (independent) {
        return { item, identity, recent: "", core: "", longTerm: "", schedule: "", relations: "" };
      }
      const localContext = item.id === characterId
        ? context
        : prepareShortTermContext(item.id, "story", {
          userName: identity?.name ?? userIdentity?.name ?? "用户",
          history: historyMessages,
          afterTimestamp: storyMemory?.inheritRecentMemory === false ? storyMemory.startedAt : undefined,
          timeAware,
        });
      const [localLongTerm, localCore] = item.id === characterId
        ? [memories, coreMemories]
        : await Promise.all([
          retrieveMemoriesForPrompt(item.id, localContext.wbActivationContext, memConfig).catch(() => null),
          retrieveCoreMemoriesForPrompt(item.id, memConfig).catch(() => null),
        ]);
      const recent = localContext.recentBlocks
        .filter((block) => Boolean(block.content.trim()))
        .map((block) => `<${block.tag}>\n${block.content.trim()}\n</${block.tag}>`)
        .join("\n");
      const schedule = [
        buildCalendarScheduleMarker("character", item.id, getWeekStartIso(now)),
        getCurrentCalendarScheduleForPrompt("character", item.id, now),
      ].filter(Boolean).join("\n");
      return {
        item,
        identity,
        recent,
        core: localCore ? formatCoreMemories(localCore) : "",
        longTerm: localLongTerm ? formatLongTermMemories(localLongTerm) : "",
        schedule,
        relations: formatCharacterRelationsForPrompt(item.id),
      };
    }));
    const roster = participantContexts.map(({ item, recent, core, longTerm, schedule, relations }, index) => [
      `## 角色 ${index + 1}：${item.name}`,
      `完整人设：${item.persona?.trim() || "（未填写）"}`,
      item.personality?.trim() ? `性格：${item.personality.trim()}` : "",
      item.briefPersona?.trim() ? `关系简介：${item.briefPersona.trim()}` : "",
      schedule ? `当前日程：\n${schedule}` : "",
      relations ? `关系网：\n${relations}` : "",
      core ? `核心记忆：\n${core}` : "",
      longTerm ? `长期记忆：\n${longTerm}` : "",
      recent ? `近期事件：\n${recent}` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
    messages.push({
      role: "system",
      content: `# 最高优先级：多人群像剧情\n这是平等的多人群像故事，不存在默认主角。API 绑定所使用的第一个角色仅是技术入口，不代表叙事中心。\n\n${roster}\n\n强制叙事规则：\n- 使用中立的第三人称旁白推进整体场景；旁白不得自称“我”。\n- “我”只能出现在某个角色真正说出口的第一人称对白中，且必须能明确判断说话者。\n- 根据现场语境，让每个在场角色都有符合人设的观察、动作、反应或对白；不要求机械轮流说话，但不得长期由一个角色垄断叙事。\n- 不得把多人合并成同一个人格，不得让第一个角色替其他人思考，也不要替用户决定心理或行动。`,
    });
  }
  if (independent) {
    messages.push({ role: "system", content: "# 独立剧情隔离规则\n本分线只使用角色基础设定、已绑定世界书和本分线内已经发生的内容。不得读取或推断角色短期记忆、核心记忆、长期记忆、日程、关系网、住宅状态、线上私聊/群聊、悬浮小手机内容或其他剧情分线。世界书属于世界设定，仍然有效。" });
  }
  if (settingsPrompt) messages.push({ role: "system", content: settingsPrompt });
  if (!independent && settings?.floatingPhoneInContext && floatingChatContext?.trim()) {
    messages.push({ role: "system", content: `# 悬浮小手机最近线上聊天\n以下记录用于衔接线上与线下剧情，不要逐字复述：\n${floatingChatContext.trim()}` });
  }
  messages.push({ role: "system", content: buildStoryBodyFormatPrompt(settings) });
  return messages;
}

export async function previewStoryPromptPayload(
  characterId: string,
  history: StoryMessage[],
  options?: Pick<StoryGenerationOptions,
    "sessionContextExcludedTags" | "settings" | "globalSettings" | "floatingChatContext" | "participantIds" | "storyMemory"
  >,
): Promise<StoryPreviewResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }
  const { apiConfig, preset: resolvedPreset, regexes, worldBooks } = resolveStoryConfigs(characterId);
  const preset = selectStoryPresetPrompts(resolvedPreset, options?.settings?.enabledPresetPromptIds);
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(
    characterId,
    history,
    preset,
    regexes,
    worldBooks,
    effectiveContextExcludedTags,
    options?.settings,
    options?.globalSettings,
    options?.floatingChatContext,
    options?.participantIds,
    options?.storyMemory,
  );
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: character.name,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

export function rebuildStorySessionRenderCache(characterId: string, sessionId: string, options?: { sessionFoldTags?: string }): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterId);
  const { regexes, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;

  const character = loadCharacters().find((c) => c.id === characterId);
  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "用户");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText || message.storySummary,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
