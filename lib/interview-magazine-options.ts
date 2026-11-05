import type { InterviewOptions } from "./interview-magazine-types";

export const DEFAULT_INTERVIEW_OPTIONS: InterviewOptions = {
  readRecentMemory: true,
  participation: "guest", flow: "turns", sceneInstructions: "", discussion: false, questionAsHost: true,
};

export function normalizeInterviewOptions(value?: Partial<InterviewOptions>): InterviewOptions {
  return {
    readRecentMemory: value?.readRecentMemory !== false,
    participation: ["guest", "spectator", "backstage", "host", "flexible"].includes(value?.participation || "") ? value!.participation! : "guest",
    flow: value?.flow === "all" || value?.flow === "all_user" ? value.flow : "turns",
    sceneInstructions: typeof value?.sceneInstructions === "string" ? value.sceneInstructions.slice(0, 6000) : "",
    discussion: value?.discussion === true, questionAsHost: value?.questionAsHost !== false,
  };
}

export function interviewParticipationPrompt(input?: Partial<InterviewOptions>, userName = "共同受访者", userAsGuest?: boolean): string {
  const options = normalizeInterviewOptions(input);
  const present = userAsGuest ?? options.participation === "guest";
  const identity = options.participation === "host"
    ? `${userName}本人担任主持人，其公开提问不是受访回答。`
    : options.participation === "backstage"
      ? `${userName}在幕后提供问题，由主持人代问；不要透露幕后来源。${present ? "现在其已明确选择出场，可作为受访者接受提问。" : "不把其写成现场受访者。"}`
      : options.participation === "flexible" ? `${userName}可以在主持、旁观与受访之间切换，以本轮状态和实录为准。` : "";
  return ["【本轮参与方式，优先于默认共同受访者描述】", identity,
    present ? `${userName}目前作为受访者出场。只向其提问并等待真实输入，禁止代写其回答、动作或反应。`
      : `${userName}目前不作为受访者。不要自动向其提问，不要编造其出场、回答、动作或反应。`,
    options.flow !== "turns" ? "采访方式为全员回答：采访嘉宾时面向全体，每位嘉宾独立回答；向用户提问或整理成刊时，按当前任务执行。" : "采访嘉宾时按顺序采访一位嘉宾，其他阶段按当前任务执行。",
    "场景要求属于创作指导，不是任何参与者的公开台词；只有实录中实际出现的发言和情节才算已发生。",
    options.sceneInstructions ? `【场景要求】\n${options.sceneInstructions}` : "",
  ].filter(Boolean).join("\n");
}
