import type { InterviewLiveSnapshot, InterviewMessage, InterviewOptions } from "./interview-magazine-types";
import { normalizeInterviewOptions } from "./interview-magazine-options";

type Guest = { id: string; name: string };
export type InterviewLiveDependencies = {
  opening: (signal: AbortSignal, options: InterviewOptions, userAsGuest: boolean) => Promise<{ intro: string; question: string; targetCharacterId?: string }>;
  question: (target: "user" | "character", transcript: InterviewMessage[], signal: AbortSignal, options: InterviewOptions, userAsGuest: boolean) => Promise<{ question: string; targetCharacterId?: string }>;
  answer: (input: { characterId: string; question: string; transcript: InterviewMessage[]; round: number; phase: "answer" | "reaction" | "discussion";
    signal: AbortSignal; options: InterviewOptions; userAsGuest: boolean; onDelta: (delta: string) => void }) => Promise<string>;
};

export function isInterviewLiveBusy(state: InterviewLiveSnapshot): boolean {
  return ["opening", "answering", "reacting", "discussing"].includes(state.phase);
}

export function initialInterviewLiveState(options: InterviewOptions, seed?: InterviewLiveSnapshot): InterviewLiveSnapshot {
  const state: InterviewLiveSnapshot = seed ? { ...seed, messages: seed.messages.map(message => ({ ...message,
    ...(message.status === "streaming" ? { status: "stopped" as const } : {}),
  })) } : { messages: [], phase: "idle", round: 0, userAsGuest: options.participation === "guest", question: "" };
  return isInterviewLiveBusy(state) ? { ...state, phase: "stopped" } : state;
}

/** Owns one abortable run. Late chunks/results cannot mutate a stopped or replaced run. */
export class InterviewLiveController {
  state: InterviewLiveSnapshot;
  options: InterviewOptions;
  private token = 0;
  private aborter: AbortController | null = null;
  private disposed = false;
  constructor(private guests: Guest[], options: InterviewOptions, private dependencies: InterviewLiveDependencies,
    private changed: (state: InterviewLiveSnapshot) => void, seed?: InterviewLiveSnapshot) {
    this.options = normalizeInterviewOptions(options);
    this.state = initialInterviewLiveState(this.options, seed);
  }
  private set(patch: Partial<InterviewLiveSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private message(role: InterviewMessage["role"], content: string, extra: Partial<InterviewMessage> = {}): InterviewMessage {
    return { id: `interview_live_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, role, content, createdAt: new Date().toISOString(), ...extra };
  }
  private append(message: InterviewMessage) { this.set({ messages: [...this.state.messages, message] }); }
  private current(token: number) { return !this.disposed && token === this.token && !this.aborter?.signal.aborted; }
  private async run(work: (token: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed || this.aborter) return;
    const token = ++this.token;
    const aborter = new AbortController();
    this.aborter = aborter;
    this.set({ error: undefined });
    try { await work(token, aborter.signal); }
    catch (error) {
      if (this.current(token)) this.set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    } finally { if (this.current(token)) this.aborter = null; }
  }
  stop(): InterviewLiveSnapshot {
    this.token++;
    const wasRunning = Boolean(this.aborter);
    this.aborter?.abort();
    this.aborter = null;
    if (wasRunning) this.set({ phase: "stopped", messages: this.state.messages.map(message => message.status === "streaming" ? { ...message, status: "stopped" } : message) });
    return this.state;
  }
  dispose() { this.stop(); this.disposed = true; }
  updateOptions(options: InterviewOptions) { if (!this.aborter) this.options = normalizeInterviewOptions(options); }
  updateDraftInput(patch: Pick<InterviewLiveSnapshot, "userInput" | "questionInput">) { if (!this.aborter) this.set(patch); }
  setPresence(present: boolean) {
    if (this.aborter) return;
    this.set({ userAsGuest: present, askUserAfterRound: false, ...(this.state.phase === "awaiting_user" && !present ? { phase: "idle" as const } : {}) });
  }
  async start(): Promise<void> {
    if (this.state.messages.length || this.state.round || this.options.participation === "host") return;
    await this.run(async (token, signal) => {
      this.set({ phase: "opening" });
      const opening = await this.dependencies.opening(signal, this.options, this.state.userAsGuest);
      if (!this.current(token)) return;
      this.append(this.message("host", opening.intro, { kind: "intro" }));
      if (this.options.participation === "backstage") { this.set({ phase: "idle" }); return; }
      this.append(this.message("host", opening.question, { kind: "question", target: "character" }));
      await this.round(opening.question, token, signal, opening.targetCharacterId);
    });
  }
  async nextQuestion(): Promise<void> {
    await this.run(async (token, signal) => {
      this.set({ phase: "opening" });
      const next = await this.dependencies.question("character", this.state.messages, signal, this.options, this.state.userAsGuest);
      if (!this.current(token)) return;
      this.append(this.message("host", next.question, { kind: "question", target: "character" }));
      await this.round(next.question, token, signal, next.targetCharacterId);
    });
  }
  async manualQuestion(text: string, userName: string): Promise<void> {
    const question = text.trim();
    if (!question || this.aborter || !["backstage", "host", "flexible"].includes(this.options.participation)) return;
    await this.run(async (token, signal) => {
      const backstage = this.options.participation === "backstage" || (this.options.participation === "flexible" && !this.options.questionAsHost);
      this.append(this.message(backstage ? "host" : "user", question, { kind: "question", speakerName: backstage ? undefined : userName, target: "character" }));
      await this.round(question, token, signal);
    });
  }
  private async round(question: string, token: number, signal: AbortSignal, targetCharacterId?: string) {
    if (!this.guests.length) throw new Error("请选择至少一位有效角色");
    const round = this.state.round + 1;
    this.set({ round, question, phase: "answering" });
    const guests = this.options.flow === "turns" ? [this.guests.find(guest => guest.id === targetCharacterId) || this.guests[(round - 1) % this.guests.length]] : this.guests;
    await this.answers(guests, "answer", token, signal);
    if (!this.current(token)) return;
    if (this.options.participation === "guest" && this.state.userAsGuest && !this.state.askUserAfterRound && this.options.flow === "turns" && round >= Math.min(6, Math.max(3, this.guests.length * 2))) {
      this.append(this.message("host", "感谢各位。本期访谈到这里告一段落。", { kind: "outro" }));
      this.set({ phase: "done" }); return;
    }
    if (this.state.askUserAfterRound || (this.state.userAsGuest && this.options.flow !== "all")) { await this.questionForUser(token, signal); return; }
    await this.discuss(token, signal);
    if (this.current(token)) {
      if (this.state.askUserAfterRound) await this.questionForUser(token, signal);
      else this.set({ phase: "idle" });
    }
  }
  async askUser(): Promise<void> {
    if (this.aborter) { this.set({ userAsGuest: true, askUserAfterRound: true }); return; }
    await this.run(async (token, signal) => {
      this.set({ userAsGuest: true });
      await this.questionForUser(token, signal);
    });
  }
  private async questionForUser(token: number, signal: AbortSignal) {
    this.set({ phase: "opening", askUserAfterRound: false });
    const next = await this.dependencies.question("user", this.state.messages, signal, this.options, true);
    if (!this.current(token)) return;
    this.append(this.message("host", next.question, { kind: "question", target: "user" }));
    this.set({ phase: "awaiting_user" });
  }
  async submitUser(text: string): Promise<void> {
    if (!text.trim() || this.state.phase !== "awaiting_user" || this.aborter) return;
    this.append(this.message("user", text.trim(), { kind: "answer" }));
    if (this.options.flow === "turns") {
      if (this.options.discussion) {
        await this.run(async (token, signal) => {
          await this.discuss(token, signal);
          if (this.current(token)) {
            if (this.state.askUserAfterRound) await this.questionForUser(token, signal);
            else this.set({ phase: "idle" });
          }
        });
        // The awaited discussion changes the phase from the earlier input guard.
        if ((this.state as InterviewLiveSnapshot).phase !== "idle") return;
      }
      await this.nextQuestion(); return;
    }
    await this.run(async (token, signal) => {
      this.set({ phase: "reacting" });
      await this.answers(this.guests, "reaction", token, signal);
      if (!this.current(token)) return;
      await this.discuss(token, signal);
      if (this.current(token)) {
        if (this.state.askUserAfterRound) await this.questionForUser(token, signal);
        else this.set({ phase: "idle" });
      }
    });
  }
  private async answers(guests: Guest[], phase: "answer" | "reaction" | "discussion", token: number, signal: AbortSignal) {
    const transcript = this.state.messages.filter(message => message.content.trim());
    const placeholders = guests.filter(Boolean).map(guest => this.message("character", "", {
      kind: phase, speakerCharacterId: guest.id, speakerName: guest.name, status: "streaming",
    }));
    this.set({ messages: [...this.state.messages, ...placeholders] });
    const failures: string[] = [];
    await Promise.all(placeholders.map(async message => {
      const update = (content: string, status: InterviewMessage["status"]) => {
        if (!this.current(token)) return;
        this.set({ messages: this.state.messages.map(entry => entry.id === message.id ? { ...entry, content, status } : entry) });
      };
      let partial = "";
      try {
        const answer = await this.dependencies.answer({ characterId: message.speakerCharacterId!, question: this.state.question,
          transcript, round: this.state.round, phase, signal, options: { ...this.options }, userAsGuest: this.state.userAsGuest,
          onDelta: delta => { if (this.current(token)) { partial += delta; update(partial, "streaming"); } },
        });
        update(answer, "complete");
      } catch (error) {
        if (!this.current(token)) return;
        update(partial, "error");
        failures.push(`${message.speakerName}：${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    if (this.current(token) && failures.length) throw new Error(`本轮部分回复失败，已保留完成及部分内容。${failures.join("；")}`);
  }
  private async discuss(token: number, signal: AbortSignal) {
    if (!this.options.discussion || !this.current(token)) return;
    this.set({ phase: "discussing" });
    // Discussion is sequential so later speakers can react to actual preceding dialogue.
    for (const guest of this.guests) {
      if (!this.current(token)) return;
      await this.answers([guest], "discussion", token, signal);
    }
  }
}
