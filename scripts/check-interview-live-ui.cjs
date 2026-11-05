const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { window } = require("linkedom").parseHTML('<html><body><div id="root"></div></body></html>');
global.window = window; global.document = window.document; global.HTMLElement = window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.fetch = () => { throw new Error("UI regression must not call real APIs"); };
const root = path.resolve(__dirname, "..");
const drafts = new Map(), calls = [];
const memoryWrites = [], writtenRoles = new Map();
let pendingAnswers = null;
const engine = {
  generateHostOpening: async (...args) => { calls.push({ type: "opening", args }); return { intro: "开场", question: "第一问" }; },
  generateHostQuestion: async input => { calls.push({ type: "question", ...input }); return { question: "请你回答" }; },
  generateCharacterInterviewAnswer: async input => {
    calls.push({ type: "answer", ...input }); input.onDelta("保留流式片段");
    if (pendingAnswers) return new Promise(resolve => pendingAnswers.push({ input, resolve }));
    return `${input.characterId}的${input.phase}回复`;
  },
};
const originalLoad = Module._load;
Module._load = function(request, parent, ...rest) {
  if (request === "@/lib/interview-magazine-engine") return engine;
  if (request === "@/lib/interview-magazine-storage") return { saveInterviewDraft: draft => { drafts.set(draft.id, JSON.parse(JSON.stringify(draft))); return [...drafts.values()]; } };
  if (request === "@/lib/interview-magazine-memory-write") return {
    interviewIssueParticipants: issue => issue.characterIds.map((id, index) => ({ id, name: issue.characterNames[index] })),
    getInterviewMemoryRecipients: issue => writtenRoles.get(issue.id) || [],
    writeInterviewIssueMemory: (issue, ids, summary) => {
      memoryWrites.push({ ids, summary }); writtenRoles.set(issue.id, ids);
      return { ...issue, article: { ...issue.article, memorySummary: summary }, memoryWrittenCharacterIds: ids };
    },
  };
  return originalLoad.call(this, request, parent, ...rest);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, parent, ...rest);
};
for (const extension of [".ts", ".tsx"]) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);

async function main() {
  const React = require("react"), { act } = React;
  const { createRoot } = require("react-dom/client");
  const { InterviewLiveSession, InterviewOptionsEditor } = require(path.join(root, "components/interview/interview-live-session.tsx"));
  const { InterviewMemoryPanel } = require(path.join(root, "components/interview/interview-memory-panel.tsx"));
  const { normalizeInterviewOptions } = require(path.join(root, "lib/interview-magazine-options.ts"));
  const container = document.getElementById("root");
  let renderer = createRoot(container), changedOptions, state, latestDraft, composed, backed = false;
  const label = text => [...container.querySelectorAll("input,select,textarea,button")].find(element => element.getAttribute("aria-label") === text);
  const button = text => [...container.querySelectorAll("button")].find(element => element.textContent === text);
  const click = async element => act(async () => element.dispatchEvent(new window.Event("click", { bubbles: true })));
  const change = async (element, value) => act(async () => {
    const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
    element[key].onChange({ target: { value } });
  });
  await act(async () => renderer.render(React.createElement(InterviewOptionsEditor, { options: normalizeInterviewOptions(), onChange: options => { changedOptions = options; } })));
  assert.equal(label("参与身份").querySelectorAll("option").length, 5);
  assert.equal(label("采访方式").querySelectorAll("option").length, 3);
  const readMemory = [...container.querySelectorAll("label")].find(element => element.textContent.includes("接入角色最近记忆")).querySelector("input");
  const readProps = readMemory[Object.keys(readMemory).find(name => name.startsWith("__reactProps$"))];
  assert.equal(readProps.checked, true);
  await act(async () => readProps.onChange({ target: { checked: false } }));
  assert.equal(changedOptions.readRecentMemory, false);
  await change(label("参与身份"), "backstage"); assert.equal(changedOptions.participation, "backstage");
  await change(label("采访方式"), "all_user"); assert.equal(changedOptions.flow, "all_user");
  await act(async () => renderer.unmount());
  const renderSession = async (options, seed, draftId) => {
    renderer = createRoot(container);
    await act(async () => renderer.render(React.createElement(InterviewLiveSession, {
      theme: "测试访谈", guests: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }], userIdentityId: "u", userName: "简初",
      initialOptions: normalizeInterviewOptions(options), initialState: seed, draftId,
      onChange: next => { state = next; }, onDraftSaved: draft => { latestDraft = draft; }, onBack: () => { backed = true; },
      onCompose: snapshot => { composed = snapshot; },
    })));
  };
  await renderSession({ flow: "all_user" });
  assert.ok(label("用户回答")); assert.equal(calls.filter(call => call.type === "answer").length, 2);
  assert.equal(state.phase, "awaiting_user");
  await change(label("用户回答"), "用户实际回复"); await click(label("提交回答"));
  assert.equal(state.phase, "idle");
  assert.equal(calls.filter(call => call.type === "answer" && call.phase === "reaction").length, 2);
  assert.ok(state.messages.some(message => message.role === "user" && message.content === "用户实际回复"));
  await change(label("场景要求"), "下一轮展现不同观点");
  assert.equal(latestDraft.options.sceneInstructions, "下一轮展现不同观点");
  await click(button("保留实录并成刊")); assert.equal(composed.messages.length, state.messages.length);
  await click(button("出场 · 让主持人问我"));
  await change(label("用户回答"), "尚未发送的草稿");
  await click(label("保存并返回")); assert.ok(backed);
  assert.equal(latestDraft.liveState.userInput, "尚未发送的草稿");
  await act(async () => renderer.unmount());
  const saved = [...drafts.values()].find(draft => draft.liveState.userInput === "尚未发送的草稿");
  const beforeRestore = calls.length;
  await renderSession(saved.options, saved.liveState, saved.id);
  assert.equal(calls.length, beforeRestore, "Restoring must not resubmit completed API calls");
  const restoredInput = label("用户回答");
  const restoredProps = restoredInput[Object.keys(restoredInput).find(name => name.startsWith("__reactProps$"))];
  assert.equal(restoredProps.value, "尚未发送的草稿", "Restored controlled input must retain the unsent draft");
  assert.equal(state.userInput, "尚未发送的草稿");
  await act(async () => renderer.unmount());

  pendingAnswers = [];
  await renderSession({ participation: "spectator", flow: "all" });
  assert.equal(container.querySelectorAll('[data-interview-status="streaming"]').length, 2);
  await click(button("停止本轮"));
  assert.ok(pendingAnswers.every(entry => entry.input.signal.aborted));
  assert.equal(container.querySelectorAll('[data-interview-status="stopped"]').length, 2);
  await act(async () => { pendingAnswers.forEach(entry => { entry.input.onDelta("迟到内容"); entry.resolve("迟到答案"); }); });
  assert.ok(!container.textContent.includes("迟到内容"));
  assert.ok(container.textContent.includes("保留流式片段"));
  await act(async () => renderer.unmount());

  renderer = createRoot(container);
  let memorySaved;
  const issue = { id: "memory-issue", userName: "简初", characterIds: ["a", "b"], characterNames: ["甲", "乙"], article: { memorySummary: "{{user}}谈了观点" } };
  await act(async () => renderer.render(React.createElement(InterviewMemoryPanel, { issue, onSaved: next => { memorySaved = next; } })));
  assert.equal(memoryWrites.length, 0, "Opening the article must never write a memory");
  assert.ok(button("写入所选角色最近记忆").hasAttribute("disabled"));
  const summaryInput = label("访谈记忆摘要");
  const summaryProps = summaryInput[Object.keys(summaryInput).find(name => name.startsWith("__reactProps$"))];
  assert.equal(summaryProps.value, "简初谈了观点");
  const selectedRole = label("乙");
  const selectedProps = selectedRole[Object.keys(selectedRole).find(name => name.startsWith("__reactProps$"))];
  await act(async () => selectedProps.onChange({ target: { checked: true } }));
  await change(label("访谈记忆摘要"), "手动确认的摘要");
  await click(button("写入所选角色最近记忆"));
  assert.deepEqual(memoryWrites[0], { ids: ["b"], summary: "手动确认的摘要" });
  assert.deepEqual(memorySaved.memoryWrittenCharacterIds, ["b"]);
  assert.ok(container.textContent.includes("已写入乙的最近记忆"));
  await act(async () => renderer.unmount());
  console.log("✅ 在场界面回归通过：身份/采访/流式/停止/草稿、默认接入最近记忆、摘要预览编辑与角色勾选、手动确认后才写入；无真实 API 调用");
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
