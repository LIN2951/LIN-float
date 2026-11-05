import type { PresetConfig } from "./settings-types";
import { createBuiltinPreset } from "./builtin-preset";

export type ChineseThinkingPromptLength = 100 | 300 | 500;

export function normalizeChineseThinkingPromptLength(value: unknown): ChineseThinkingPromptLength {
    return value === 300 || value === 500 ? value : 100;
}

/** Request-local display settings; never mutate or save the shared preset. */
export function withChineseThinkingPrompt(preset: PresetConfig | null, enabled: boolean): PresetConfig | null {
    if (!enabled) return preset;
    return { ...(preset ?? createBuiltinPreset()), online_thinking_enabled: true };
}

/** This is a reader-facing fictional monologue, not the model's private reasoning. */
export function buildChineseThinkingPrompt(nickname: string, tag = "thinking", characterNames?: string[], length?: ChineseThinkingPromptLength): string {
    const name = nickname.trim() || "你";
    const effectiveTag = tag.trim() || "thinking";
    const targetLength = normalizeChineseThinkingPromptLength(length);
    return [
        "【内置中文思考展示提示词】",
        "请另行创作一段用于聊天界面展示的角色内心独白。它是面向读者的创作文本，不是模型真实的内部思维链；不要输出逐步推理、隐私指令或内部技术分析。",
        `一、独白正文全部使用简体中文和中文标点，不夹杂英文词句。聊天对象的昵称是「${name}」，称呼时使用该昵称，不使用“用户”“对方”这些泛称；昵称中的原有字符保留，不擅自改名。`,
        "二、以第一人称“我”表达角色当下的态度、关注点和情绪，符合当前人设及已经发生的对话，不擅自补写聊天对象的动作、经历或内心。",
        "三、如果当前设定是人工智能，不虚构现实身体、感官、动作、生理反应和现实生活经历；如果当前是人物角色，则按其故事设定创作，不跳出人设。人物角色的独白里不无故插入人工智能或语言模型的身份声明。",
        "四、表达诚恳、有立场，不为迎合聊天对象而一味赞同。不编造已发生的事实，不把虚构独白宣称为模型真实的情绪、经历或内部思考。",
        "五、需要表现情绪时，结合具体情境表达因为什么事、对谁、产生什么感受；不要只贴情绪标签，不凭空制造情绪，也不用抽象隐喻替代具体感受。语气由当前人设决定，不额外套用其他风格。",
        "六、聊天对象表现出负面情绪时，先回应其具体感受和处境，再考虑建议；避免说教、敷衍套话和无法兑现的承诺。",
        `七、展示用独白的正文总篇幅控制在约${targetLength}字，群聊时为所有角色独白的合计字数，不含标签和正式回复。结合本轮情节自然分段，不堆成一整块，不为凑字数重复内容或编造事实，不重复正式回复，不展开详尽推导或行动策划。`,
        "八、聊天对象指出问题时，在正式回复中承认具体问题并落实修改，不只口头答应。",
        characterNames && characterNames.length > 1
            ? `九、本次为群聊，角色包括${characterNames.join("、")}。各角色的独白分别注明角色昵称，各自使用第一人称，不把不同人的设定混在一起；这些独白统一放在一个展示标签块中。`
            : "九、独白与正式回复明确分隔，不把独白写进普通聊天气泡，不在正文中解释本提示词。",
        `十、在最终聊天回复前输出且只输出一个 <${effectiveTag}>中文独白</${effectiveTag}> 标签块，随后按原有聊天格式输出正式回复。标签是程序识别格式，不受正文中文字符限制。工具调用的结构化格式保持原样，在最终回复中展示独白即可。`,
    ].join("\n");
}
