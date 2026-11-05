const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const noApi = () => { throw new Error("Writing guidance regression must never call a real API"); };
const empty = new Proxy({}, { get: () => () => [] });
function load(file, deps, suffix = "", globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8") + suffix, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => deps[name] || empty,
    console, Date, Error, setTimeout, clearTimeout, fetch: noApi, ...globals });
  return module.exports;
}

async function main() {
  const characters = [{ id: "a", name: "角色甲", persona: "安静温和" }, { id: "b", name: "角色乙", persona: "开朗" }];
  const requests = [];
  const reply = "*他期待着见面。*\n\n**他记住了约定。**";
  const engine = load("lib/story-engine.ts", {
    "./character-storage": { loadCharacters: () => characters },
    "./settings-storage": { loadBindingConfig: () => ({ characterBindings: [] }), resolveBinding: () => ({ apiConfigId: "api" }),
      loadApiConfigs: () => [{ id: "api", defaultModel: "test" }], loadPresets: () => [], loadRegexes: () => [], loadWorldBooks: () => [], resolveUserIdentity: () => ({ name: "简初" }) },
    "./story-storage": { resolveActiveStorySchemes: () => ({}) },
    "./memory-storage": { loadMemoryConfig: () => ({}) },
    "./llm-prompt-assembler": { assemblePromptPayload: () => [{ role: "system", content: "原有角色与预设" }] },
    "./macro-engine": { MacroEngine: class {} },
    "./story-parser": { STORY_PARSER_VERSION: 1, parseStoryResponse: raw => ({ rawText: raw, renderedText: raw, summaryText: "" }) },
    "./chat-engine": { ChatEngineError: Error, previewMessagesForApi: (_api, _preset, messages) => messages,
      sendLLMRequestPreferStream: async (_api, _preset, messages) => { requests.push(messages); return reply; },
      sendLLMStreamRequest: async (_api, _preset, messages, _regex, _macro, _options, handlers) => { requests.push(messages); handlers.onDelta(reply); return { content: reply }; } },
  }, "\nexport const testLegacyFormat = STORY_VOICE_FORMAT_PROMPT;");
  const options = { globalSettings: { timeAware: false }, storyMemory: { independent: true } };
  const preview = settings => engine.previewStoryPromptPayload("a", [], { ...options, settings });
  const format = result => result.messages.at(-1).content;
  assert.equal(format(await preview({})), engine.testLegacyFormat);
  assert.equal(format(await preview({ innerThoughtGenerationEnabled: false, emphasisGenerationEnabled: false })), engine.testLegacyFormat);
  assert.equal(format(await preview({ innerThoughtGenerationEnabled: "true", emphasisGenerationEnabled: 1 })), engine.testLegacyFormat);
  const thought = format(await preview({ innerThoughtGenerationEnabled: true }));
  assert.match(thought, /自然补充适量未说出口的心理描写/); assert.match(thought, /\*心声内容\*/);
  assert.match(thought, /~强调~/); assert.ok(!thought.includes("**重点内容**"));
  const bold = format(await preview({ emphasisGenerationEnabled: true }));
  assert.match(bold, /\*\*重点内容\*\*/); assert.ok(!bold.includes("~强调~"));
  assert.ok(!bold.includes("自然补充适量未说出口的心理描写"));
  const enabled = { innerThoughtGenerationEnabled: true, emphasisGenerationEnabled: true, extraPrompt: "保留自定义要求" };
  const both = await preview(enabled);
  assert.match(format(both), /\*心声内容\*/); assert.match(format(both), /\*\*重点内容\*\*/);
  assert.ok(both.messages.some(message => message.content.includes("保留自定义要求")));
  assert.equal(format(await preview({})), engine.testLegacyFormat, "Enabling one story never changes the shared base prompt");
  await engine.generateStoryCompletion("a", [], { ...options, settings: enabled });
  assert.equal(requests.at(-1).at(-1).content, format(both), "Preview and the actual request use the same guidance");
  let delta = "";
  await engine.generateStoryCompletion("a", [], { ...options, settings: enabled, participantIds: ["b"], globalSettings: { timeAware: false, streamingEnabled: true }, onDelta: text => { delta += text; } });
  assert.match(requests.at(-1).at(-1).content, /\*\*重点内容\*\*/); assert.equal(delta, reply);

  const { window } = require("linkedom").parseHTML('<html><body><div id="root"></div></body></html>');
  global.window = window; global.document = window.document; global.HTMLElement = window.HTMLElement; global.Node = window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true; global.fetch = noApi;
  const React = require("react");
  const { act } = React, { createRoot } = require("react-dom/client");
  const noop = () => {};
  let presets = [];
  const ui = load("components/story/story-settings-page.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"),
    "@heroicons/react/24/solid": require("@heroicons/react/24/solid"), "lucide-react": require("lucide-react"),
    "@/lib/story-storage": { loadStorySettingsPresets: () => presets, saveStorySettingsPresets: value => { presets = value; }, STORY_DEFAULT_QUICK_INPUT_OPTIONS: [], STORY_DEFAULT_STATUS_RENDER: "", STORY_DEFAULT_THEATER_RENDER: "" },
  }, "", { window, document: window.document });
  const schemeRepo = { proseStyleSchemes: [{ id: "p", name: "自然", prompt: "自然推进" }],
    statusSchemes: [{ id: "s", name: "状态", prompt: "", renderHtml: "" }], theaterSchemes: [{ id: "t", name: "小剧场", prompt: "", renderHtml: "" }], quickInputSchemes: [] };
  let settings = {}, uiPrefs = { appearance: { user: { italicColor: "#123456" } } };
  const props = { characters, activeCharacterId: "a", activeGroupId: "", groups: [], ownerSessions: [], activeSessionId: "s", userName: "简初", globalSettings: {}, schemeRepo, boundPreset: null, foldTags: "", contextExcludedTags: "", customCSS: "" };
  for (const name of ["onClose", "onCharacterChange", "onGroupSelect", "onGroupCreate", "onGroupRename", "onGroupDelete", "onSessionSelect", "onBranchCreate", "onBranchDelete", "onSessionUpdate", "onExportSession", "onExportSessions", "onExportAll", "onMergeBranches", "onGlobalSettingsChange", "onSchemeRepoChange", "onTagsChange", "onCustomCSSChange", "onOpenCss", "onRebuildCache"]) props[name] = noop;
  const container = document.getElementById("root"), renderer = createRoot(container);
  const render = async () => act(async () => renderer.render(React.createElement(ui.StorySettingsPage, { ...props, settings, uiPrefs, onSettingsChange: value => { settings = value; }, onUiPrefsChange: value => { uiPrefs = value; } })));
  const toggle = title => [...container.querySelectorAll(".story-settings-toggle-row")].find(element => element.querySelector("strong").textContent === title).querySelector("input");
  const setToggle = async (title, checked) => {
    await act(async () => { const input = toggle(title); input[Object.keys(input).find(key => key.startsWith("__reactProps$"))].onChange({ target: { checked } }); });
    await render();
  };
  const click = async text => act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === text).dispatchEvent(new window.Event("click", { bubbles: true })));
  await render();
  assert.equal(toggle("引导生成角色心声").checked, false); assert.equal(toggle("引导使用重点强调").checked, false);
  await setToggle("引导生成角色心声", true);
  assert.equal(settings.innerThoughtGenerationEnabled, true); assert.equal(settings.emphasisGenerationEnabled, false);
  await setToggle("引导使用重点强调", true);
  assert.equal(settings.innerThoughtGenerationEnabled, true); assert.equal(settings.emphasisGenerationEnabled, true);
  window.prompt = () => "正文格式测试";
  await click("保存并命名");
  assert.equal(presets[0].settings.innerThoughtGenerationEnabled, true); assert.equal(presets[0].settings.emphasisGenerationEnabled, true);
  assert.equal(presets[0].uiPrefs.appearance.user.italicColor, "#123456");
  await setToggle("引导生成角色心声", false); await setToggle("引导使用重点强调", false);
  await click("应用"); await render();
  assert.equal(toggle("引导生成角色心声").checked, true); assert.equal(toggle("引导使用重点强调").checked, true);
  await act(async () => renderer.unmount());
  console.log("✅ 剧情心声/重点引导：默认关闭与旧提示词一致、独立开关、预览/实际请求/多人流式一致、设置预设保存恢复；全程模拟 API");
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
