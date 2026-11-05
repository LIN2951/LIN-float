const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function load(file, deps = {}, globals = {}) {
  const module = { exports: {} };
  const fallback = new Proxy({}, { get: () => () => [] });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: name => deps[name] || fallback,
    AbortController, console, Error, Date, setTimeout, clearTimeout, ...globals });
  return module.exports;
}
const options = load("lib/interview-magazine-options.ts");
const { InterviewLiveController, initialInterviewLiveState } = load("lib/interview-magazine-live.ts", { "./interview-magazine-options": options });
const guests = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }];
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function scenario(input, override = {}) {
  const calls = [];
  const deps = {
    opening: async (signal, opts, present) => { calls.push({ type: "opening", signal, opts, present }); return { intro: "开场", question: "第一问", targetCharacterId: "b" }; },
    question: async (target, transcript, signal, opts, present) => { calls.push({ type: "question", target, transcript, signal, opts, present }); return { question: target === "user" ? "请你回答" : "下一问", targetCharacterId: "a" }; },
    answer: async input => { calls.push({ type: "answer", ...input }); input.onDelta("片段"); return `${input.characterId}-${input.phase}`; },
    ...override,
  };
  const live = new InterviewLiveController(guests, options.normalizeInterviewOptions(input), deps, () => {});
  return { live, calls };
}

async function main() {
  // All answers start together; wait for the slowest before addressing the user.
  const pending = [];
  const group = scenario({ flow: "all_user" }, { answer: input => { const d = deferred(); pending.push({ input, ...d }); input.onDelta(input.characterId); return d.promise; } });
  const first = group.live.start(); await tick();
  assert.equal(pending.length, 2);
  await group.live.nextQuestion();
  assert.equal(pending.length, 2, "Repeated clicks must not create a second concurrent round");
  assert.equal(group.live.state.messages.filter(m => m.status === "streaming").length, 2);
  assert.equal(pending[0].input.transcript, pending[1].input.transcript, "Parallel answers see one consistent completed transcript");
  assert.equal(group.calls.filter(c => c.target === "user").length, 0);
  pending[1].resolve("乙的答案"); await tick();
  assert.equal(group.live.state.phase, "answering");
  pending[0].resolve("甲的答案"); await first;
  assert.equal(group.live.state.phase, "awaiting_user");
  assert.equal(group.live.state.messages.filter(m => m.role === "user").length, 0, "Never fabricate the user's answer");
  const reply = group.live.submitUser("我的真实回答"); await tick();
  await group.live.submitUser("重复点击不发送");
  assert.equal(pending.length, 4);
  assert.equal(group.live.state.messages.filter(message => message.role === "user").length, 1);
  for (const entry of pending.slice(2)) {
    assert.equal(entry.input.phase, "reaction");
    assert.ok(entry.input.transcript.some(m => m.content === "我的真实回答"));
    assert.ok(entry.input.transcript.some(m => m.content === "乙的答案"));
    entry.resolve("回应了真实回答");
  }
  await reply;
  assert.equal(group.live.state.phase, "idle");
  assert.equal(group.live.state.round, 1);

  const spectator = scenario({ participation: "spectator", flow: "all_user" });
  await spectator.live.start();
  assert.equal(spectator.live.state.phase, "idle");
  assert.equal(spectator.calls.filter(c => c.target === "user").length, 0);
  assert.equal(spectator.calls.filter(c => c.type === "answer").length, 2);
  await spectator.live.nextQuestion();
  assert.equal(spectator.live.state.round, 2);
  assert.equal(spectator.live.state.phase, "idle", "One click produces one round, never an automatic loop");
  await spectator.live.askUser();
  assert.equal(spectator.live.state.phase, "awaiting_user");
  spectator.live.setPresence(false);
  assert.equal(spectator.live.state.phase, "idle");

  const backstage = scenario({ participation: "backstage", flow: "all" });
  await backstage.live.start();
  assert.equal(backstage.calls.filter(c => c.type === "answer").length, 0);
  await backstage.live.manualQuestion("幕后写的问题", "简初");
  assert.ok(backstage.live.state.messages.some(m => m.kind === "question" && m.content === "幕后写的问题" && m.role === "host"));
  assert.ok(!backstage.live.state.messages.some(m => m.role === "user"));
  const host = scenario({ participation: "host", flow: "all" });
  await host.live.start();
  assert.equal(host.calls.length, 0, "Real hosting must wait for a manual question");
  await host.live.manualQuestion("我本人问的问题", "简初");
  assert.equal(host.live.state.messages[0].role, "user");
  assert.equal(host.live.state.messages[0].kind, "question");

  const flexible = scenario({ participation: "flexible", flow: "all", questionAsHost: false });
  await flexible.live.start(); await flexible.live.manualQuestion("先幕后代问", "简初");
  flexible.live.updateOptions({ ...flexible.live.options, questionAsHost: true });
  await flexible.live.manualQuestion("再本人提问", "简初");
  assert.ok(flexible.live.state.messages.some(m => m.content === "先幕后代问" && m.role === "host"));
  assert.ok(flexible.live.state.messages.some(m => m.content === "再本人提问" && m.role === "user"));

  const discussion = scenario({ participation: "spectator", flow: "all", discussion: true, sceneInstructions: "表达不同观点" });
  await discussion.live.start();
  const talk = discussion.calls.filter(c => c.phase === "discussion");
  assert.equal(talk.length, 2);
  assert.ok(talk[0].transcript.some(m => m.content === "b-answer"));
  assert.ok(talk[1].transcript.some(m => m.content === "a-discussion"), "Discussion must read preceding actual discussion, not parallel guesses");
  assert.equal(talk[1].options.sceneInstructions, "表达不同观点");

  // A non-cooperative provider may emit late chunks after abort: never append them.
  const late = [];
  const stopped = scenario({ flow: "all_user" }, { answer: input => { const d = deferred(); late.push({ input, ...d }); input.onDelta("保留片段"); return d.promise; } });
  const old = stopped.live.start(); await tick();
  stopped.live.stop();
  assert.ok(late.every(entry => entry.input.signal.aborted));
  const snapshot = JSON.stringify(stopped.live.state);
  for (const entry of late) { entry.input.onDelta("迟到内容"); entry.resolve("迟到结果"); }
  await old;
  assert.equal(JSON.stringify(stopped.live.state), snapshot);
  assert.equal(stopped.calls.filter(c => c.target === "user").length, 0);
  assert.ok(stopped.live.state.messages.some(m => m.content === "保留片段" && m.status === "stopped"));
  const restored = initialInterviewLiveState(stopped.live.options, JSON.parse(snapshot));
  assert.equal(restored.phase, "stopped");
  const restoredController = new InterviewLiveController(guests, stopped.live.options, { opening() { throw new Error("Must not restart paid work on restore"); } }, () => {}, restored);
  await restoredController.start();

  const queued = [];
  const cameo = scenario({ participation: "spectator", flow: "all" }, { answer: input => { const d = deferred(); queued.push({ input, ...d }); return d.promise; } });
  const round = cameo.live.start(); await tick();
  await cameo.live.askUser();
  assert.equal(cameo.calls.filter(c => c.target === "user").length, 0);
  assert.equal(cameo.live.state.askUserAfterRound, true);
  queued.forEach(entry => entry.resolve("完成")); await round;
  assert.equal(cameo.live.state.phase, "awaiting_user");

  const opening = deferred();
  const abortOpening = scenario({}, { opening: () => opening.promise });
  const openingRun = abortOpening.live.start(); abortOpening.live.stop();
  opening.resolve({ intro: "过期", question: "过期" }); await openingRun;
  assert.equal(abortOpening.live.state.messages.length, 0);
  const failure = scenario({ flow: "all_user" }, { answer: async input => { if (input.characterId === "b") throw new Error("模拟失败"); return "甲已完成"; } });
  await failure.live.start();
  assert.equal(failure.live.state.phase, "error");
  assert.ok(failure.live.state.messages.some(m => m.content === "甲已完成" && m.status === "complete"));
  assert.equal(failure.calls.filter(c => c.target === "user").length, 0);
  const legacy = scenario({}); await legacy.live.start();
  assert.equal(legacy.calls.find(c => c.type === "answer").characterId, "b", "A named question must be answered by that actual guest");
  await legacy.live.submitUser("回答一"); await legacy.live.submitUser("回答二"); await legacy.live.submitUser("回答三");
  assert.equal(legacy.live.state.phase, "done");
  const turnsDiscussion = scenario({ discussion: true });
  await turnsDiscussion.live.start();
  await turnsDiscussion.live.submitUser("参与讨论");
  assert.equal(turnsDiscussion.calls.filter(call => call.phase === "discussion").length, 2);
  assert.equal(turnsDiscussion.live.state.phase, "awaiting_user");

  // Exercise the real engine adapters: independent bindings, streaming and abort propagation.
  const types = load("lib/interview-magazine-types.ts");
  const sent = [], assembled = [];
  const memoryReads = [];
  const recentMemory = load("lib/interview-magazine-recent-memory.ts", {
    "./short-term-assembler": {
      loadNativeTimelineAsync: async id => { memoryReads.push(id); return [{ content: `${id}自己的最近聊天` }]; },
      prepareShortTermContext: (_id, _appId, input) => ({ recentBlocks: [{ tag: "recent_chat", content: input.timeline[0].content }] }),
    },
  });
  assert.equal(options.normalizeInterviewOptions().readRecentMemory, true);
  assert.equal(await recentMemory.buildInterviewRecentMemory(guests, "简初", false), "");
  assert.equal(memoryReads.length, 0, "Turning recent memory off must skip local reads entirely");
  const identity = { id: "u", name: "简初" };
  const engine = load("lib/interview-magazine-engine.ts", {
    "./interview-magazine-types": types, "./interview-magazine-options": options,
    "./interview-magazine-recent-memory": recentMemory,
    "./character-storage": { loadCharacters: () => guests.map(g => ({ ...g, persona: `${g.name}的人设`, tags: [] })) },
    "./settings-storage": {
      loadBindingConfig: () => ({}), loadPresets: () => guests.map(g => ({ id: `preset-${g.id}`, name: g.name })),
      loadApiConfigs: () => guests.map(g => ({ id: `api-${g.id}`, defaultModel: `model-${g.id}` })),
      resolveBinding: (_binding, id) => ({ apiConfigId: `api-${id}`, presetId: `preset-${id}` }),
      loadWorldBooks: () => [], loadRegexes: () => [], loadUserIdentities: () => [identity], resolveUserIdentity: () => identity,
    },
    "./interview-magazine-storage": { loadInterviewHostPrompt: () => "主持人规则", loadInterviewMemoryPrompt: () => "只记录事实" },
    "./macro-engine": { MacroEngine: class { expand(text) { return text; } } },
    "./user-macro": { normalizeUserNameToMacro: text => text },
    "./llm-prompt-assembler": { assemblePromptPayload: params => { assembled.push(params); return [{ role: "system", content: params.character.name }]; } },
    "./chat-engine": {
      ChatEngineError: Error,
      sendLLMStreamRequest: async (...args) => { sent.push(args); args[6].onDelta("流式片段"); return { content: "完整回复" }; },
      sendLLMRequest: async (...args) => { sent.push(args); return '{"intro":"开场","question":"请回答","body":["只描述嘉宾"],"memorySummary":"角色完成访谈"}'; },
    },
  });
  const signal = new AbortController().signal;
  let streamed = "";
  for (const guest of guests) await engine.generateCharacterInterviewAnswer({ theme: "主题", characterIds: ["a", "b"], characterId: guest.id, userIdentityId: "u",
    question: "问题", transcript: [{ role: "user", kind: "answer", content: "我的真实观点" }], round: 1, phase: "reaction",
    options: options.normalizeInterviewOptions({ participation: "host", flow: "all" }), signal, onDelta: text => { streamed += text; } });
  assert.equal(streamed, "流式片段流式片段");
  assert.equal(sent[0][0].id, "api-a"); assert.equal(sent[1][0].id, "api-b");
  assert.equal(sent[0][1].id, "preset-a"); assert.equal(sent[1][1].id, "preset-b");
  assert.equal(sent[0][5].signal, signal);
  assert.equal(assembled[0].interviewHostName, "简初");
  assert.equal(assembled[0].interviewUserAnswer, "我的真实观点");
  assert.match(sent[0][2].map(message => message.content).join("\n"), /a自己的最近聊天/);
  assert.ok(!sent[0][2].map(message => message.content).join("\n").includes("b自己的最近聊天"), "A guest reads only its own private recent memory");
  const spectatorOptions = options.normalizeInterviewOptions({ participation: "spectator", flow: "all" });
  await engine.generateHostOpening("主题", ["a", "b"], "u", { signal, options: spectatorOptions, userAsGuest: false });
  assert.equal(sent[2][5].signal, signal);
  assert.match(sent[2][2][0].content, /不要自动向其提问/);
  assert.match(sent[2][2].map(message => message.content).join("\n"), /b自己的最近聊天/);
  await engine.composeInterviewArticle({ theme: "主题", characterIds: ["a"], userIdentityId: "u", transcript: [], issueNumber: 1, options: spectatorOptions, signal });
  assert.match(sent[3][2][0].content, /不作为受访者/);
  assert.equal(sent[3][5].signal, signal);
  assert.ok(!sent[3][2].some(message => String(message.content).includes("采访背景：最近记忆")), "An issue summary uses actual interview dialogue, not unrelated background memory");
  const beforeReadOff = memoryReads.length;
  await engine.generateCharacterInterviewAnswer({ theme: "主题", characterIds: ["a"], characterId: "a", question: "问题", transcript: [], round: 1,
    options: options.normalizeInterviewOptions({ readRecentMemory: false }), onDelta() {} });
  assert.equal(memoryReads.length, beforeReadOff);
  assert.ok(!sent[4][2].map(message => message.content).join("\n").includes("采访背景：最近记忆"));
  assert.match(engine.formatInterviewTranscript([{ role: "user", kind: "question", content: "手动提问" }], "甲", "简初"), /主持人 简初/);
  assert.match(engine.formatInterviewTranscript([{ role: "character", content: "半条", status: "stopped" }], "甲", "简初"), /未完成/);
  const kv = new Map();
  const memory = load("lib/interview-magazine-memory.ts", {
    "./kv-db": { registerDynamicPrefix() {}, kvGet: key => kv.get(key) || null, kvSet: (key, value) => kv.set(key, value) },
    "./llm-prompt-assembler": { formatChatTimestamp: () => "时间" },
    "./user-macro": { normalizeUserNameToMacro: text => text, USER_NAME_MACRO: "{{user}}" },
  }, { window: {} });
  const entry = { issueId: "one", issueNumber: 1, characterIds: ["a"], characterNames: ["甲"], userName: "简初", title: "刊物", theme: "主题", summary: "甲表达了观点" };
  assert.ok(!memory.recordInterviewMagazineProjectionEvent({ ...entry, userRole: "observer" }).content.includes("与{{user}}"));
  assert.match(memory.recordInterviewMagazineProjectionEvent({ ...entry, userRole: "host" }).content, /接受了\{\{user\}\}主持/);
  assert.match(memory.recordInterviewMagazineProjectionEvent(entry).content, /与\{\{user\}\}/);
  const counters = new Map();
  let storedIssue = { id: "selective", issueNumber: 2, theme: "主题", characterIds: ["a", "b"], characterNames: ["甲", "乙"], characterId: "a", characterName: "甲",
    userName: "简初", transcript: [], article: { title: "刊物", memorySummary: "摘要" }, options: options.normalizeInterviewOptions({ participation: "spectator" }), createdAt: new Date().toISOString() };
  const writes = load("lib/interview-magazine-memory-write.ts", {
    "./interview-magazine-memory": memory,
    "./interview-magazine-storage": { loadInterviewIssues: () => [storedIssue], saveInterviewIssue: issue => { storedIssue = issue; } },
    "./memory-storage": { incrementEventCounter: id => counters.set(id, (counters.get(id) || 0) + 1) },
    "./user-macro": { normalizeUserNameToMacro: text => text },
  });
  writes.writeInterviewIssueMemory(storedIssue, ["b"], "只给乙的摘要");
  assert.ok(!memory.loadInterviewMagazineProjectionEntries("a").some(item => item.issueId === "selective"));
  assert.match(memory.loadInterviewMagazineProjectionEntries("b").find(item => item.issueId === "selective").content, /甲、乙完成/);
  assert.equal(counters.get("b"), 1);
  writes.writeInterviewIssueMemory(storedIssue, ["b"], "更新乙的摘要");
  assert.equal(counters.get("b"), 1, "Updating an issue must not increment the event count twice");
  assert.equal(memory.loadInterviewMagazineProjectionEntries("b").filter(item => item.issueId === "selective").length, 1);
  writes.writeInterviewIssueMemory(storedIssue, ["a"], "现在给甲");
  assert.match(memory.loadInterviewMagazineProjectionEntries("b").find(item => item.issueId === "selective").content, /更新乙的摘要/);
  assert.throws(() => writes.writeInterviewIssueMemory(storedIssue, ["outsider"], "不能写给旁人"), /受访角色/);
  assert.throws(() => writes.writeInterviewIssueMemory(storedIssue, [], "未选择不写入"), /请选择/);
  console.log("✅ 在场流程与记忆回归通过：并行/反应/讨论/主持切换/取消、默认读取最近记忆与关闭、角色背景隔离、摘要不混入旧记忆、选择写入与去重；无真实 API 调用");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
