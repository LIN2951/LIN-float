const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), ts = require("typescript");
require("fake-indexeddb/auto");
const { window } = require("linkedom").parseHTML('<html><body><div class="phone-shell"><div id="root"></div></div></body></html>');
Object.assign(global, { window, document: window.document, CustomEvent: window.CustomEvent, HTMLElement: window.HTMLElement, Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw Error("No real API calls in tests"); } });
const root = path.resolve(__dirname, ".."), originalResolve = Module._resolveFilename, originalLoad = Module._load, mocks = new Map();
Module._resolveFilename = function(name, parent, ...rest) { return originalResolve.call(this, name.startsWith("@/") ? path.join(root, name.slice(2)) : name, parent, ...rest); };
Module._load = function(name, parent, ...rest) { const resolved = Module._resolveFilename(name, parent); return mocks.has(resolved) ? mocks.get(resolved) : originalLoad.call(this, name, parent, ...rest); };
for (const extension of [".ts", ".tsx"]) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);

async function main() {
  const kv = require(path.join(root, "lib/kv-db.ts"));
  const records = require(path.join(root, "lib/short-term-memory-records.ts"));
  const { getNativeTimelineEntryKey: key } = require(path.join(root, "lib/native-timeline-key.ts"));
  const parser = require(path.join(root, "lib/short-term-memory-import.ts"));
  const native = Array.from({ length: 74 }, (_, index) => ({ id: `record-${index}`, sourceApp: "chat", sourceDetail: "direct", sessionId: "session-a",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), content: `聊天记录 ${index}`, userNickname: "简初" }));
  native.push({ id: "branch-main", sourceApp: "story", sourceDetail: "story", sessionId: "main", timestamp: "2025-01-01T00:00:00Z", content: "主线" },
    { id: "branch-alt", sourceApp: "story", sourceDetail: "story", sessionId: "branch", timestamp: "2025-01-02T00:00:00Z", content: "分线" },
    { id: "shared-post", sourceApp: "moments", postAuthorType: "user", timestamp: "2025-01-03T00:00:00Z", content: "用户朋友圈" },
    { id: "phone", sourceApp: "checkphone", timestamp: "2025-01-04T00:00:00Z", content: "已有查手机事件" },
    { id: "custom", sourceApp: "custom_app", customAppId: "app-a", timestamp: "2025-01-05T00:00:00Z", content: "自定义APP已有事件" },
    { id: "diary", sourceApp: "diary", timestamp: "2025-01-06T00:00:00Z", content: "日记本次不扫描" });
  const loadNativeTimelineAsync = async (id, options = {}) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (options.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    return records.mergeShortMemoryEntries(id, native, options.includeDeleted);
  };
  mocks.set(path.join(root, "lib/short-term-assembler.ts"), { loadNativeTimelineAsync, getNativeTimelineEntryKey: key });
  mocks.set(path.join(root, "lib/story-storage.ts"), { loadStoryProjectionEntries: () => [] });
  const repair = require(path.join(root, "lib/short-term-memory-repair.ts"));
  records.hideNativeTimelineEntries("char", native.filter(entry => entry.sourceApp !== "diary"));
  kv.kvSet("long-memory-test", "长期记忆保持原样");
  let result = await repair.scanShortMemory("char", "short", ["chat", "story", "checkphone", "custom_app"], [], new AbortController().signal);
  assert.equal(result.candidates.length, 78); assert.ok(result.candidates.every(item => item.status === "deleted"));
  assert.ok(result.candidates.some(item => item.entry.id === "branch-main") && result.candidates.some(item => item.entry.id === "branch-alt"));
  assert.ok(!result.candidates.some(item => item.entry.id === "shared-post"));
  result = await repair.scanShortMemory("char", "shared", ["moments"], [], new AbortController().signal);
  assert.deepEqual(result.candidates.map(item => item.entry.id), ["shared-post"]);
  records.restoreNativeTimelineEntries("char", [native[0]]);
  result = await repair.scanShortMemory("char", "short", ["chat"], [native[0]], new AbortController().signal);
  assert.equal(result.skipped, 1); assert.equal(result.candidates.length, 73);
  const sameText = [{ ...native[0], id: "same-a" }, { ...native[0], id: "same-b", timestamp: "2026-02-01T00:00:00Z" }];
  records.importShortMemories("different", sameText); assert.equal(records.loadManualShortMemories("different").length, 2, "Repeated wording at different events is never merged");
  const paste = "时间：2025-03-01 12:00\n编号：saved-id\n分线：雨夜\n说话人：角色\n内容：第一段\n---\n时间：2024-03-01 12:00\n分线：主线\n说话人：简初\n内容：更早的一段";
  const pasted = parser.parseMemoryPaste(paste, "story", "short", "char");
  assert.ok(pasted[0].timestamp < pasted[1].timestamp); assert.match(pasted[1].content, /雨夜/);
  records.importShortMemories("char", pasted);
  records.importShortMemories("char", parser.parseMemoryPaste(paste.replace("第一段", "更新后的同一段"), "story", "short", "char"));
  assert.equal(records.loadManualShortMemories("char").length, 2); assert.match(records.loadManualShortMemories("char").find(entry => entry.id === "saved-id").content, /更新后的同一段/);
  assert.throws(() => parser.parseMemoryPaste("发布人：简初\n内容：没有时间", "moments", "short", "char"), /时间/);
  assert.throws(() => parser.parseMemoryPaste("时间：2026-02-31\n发布人：简初\n内容：日期错误", "moments", "short", "char"), /日期/);
  const file = { type: "float-chat-records", version: 1, session: { id: "session-a", isGroup: false }, messages: [
    { id: "record-0", sessionId: "session-a", role: "user", senderName: "简初", content: "覆盖旧记录", createdAt: "2023-02-01T00:00:00Z" },
    { id: "new-record", sessionId: "session-a", role: "assistant", content: "补充新记录", createdAt: "2023-02-02T00:00:00Z" } ] };
  const imported = parser.parseChatMemoryFile(JSON.stringify(file), "short", "角色");
  records.importShortMemories("char", imported); records.importShortMemories("char", imported);
  const merged = records.mergeShortMemoryEntries("char", native);
  assert.equal(merged.filter(entry => entry.id === "record-0").length, 1); assert.equal(merged.find(entry => entry.id === "record-0").timestamp, "2023-02-01T00:00:00.000Z");
  assert.equal(merged.filter(entry => entry.id === "new-record").length, 1);
  const history = [{ id: "record-0", sessionId: "session-a", content: "旧原文", createdAt: "2026-01-01", role: "user" }];
  assert.equal(records.applyShortMemoryToChatHistory("char", history, "chat")[0].content, "覆盖旧记录");
  records.hideNativeTimelineEntries("char", imported); assert.equal(records.applyShortMemoryToChatHistory("char", history, "chat").length, 0);
  assert.equal(history[0].content, "旧原文");
  // Deletion markers must not roll off when more than the old 12000 limit are deleted.
  records.hideNativeTimelineEntries("many", Array.from({ length: 12010 }, (_, i) => ({ ...native[0], id: String(i) })));
  assert.equal(records.hiddenMemoryKeys("many").size, 12010);

  const React = require("react"), { act } = React, { createRoot } = require("react-dom/client");
  const mount = document.getElementById("root"), container = document.querySelector(".phone-shell"); let renderer = createRoot(mount);
  const { MemoryRepairDialog } = require(path.join(root, "components/memory/memory-repair-dialog.tsx"));
  let closed = 0, refreshed = 0;
  const render = async () => act(async () => { renderer.render(React.createElement(MemoryRepairDialog, { characterId: "char", characterName: "角色", scope: "short", current: [], onClose: () => closed++, onImported: () => refreshed++ })); });
  const props = element => element[Object.keys(element).find(key => key.startsWith("__reactProps$"))];
  const button = text => [...container.querySelectorAll("button")].find(element => element.textContent === text);
  const click = async element => act(async () => { assert.ok(element); await props(element).onClick(); await new Promise(resolve => setTimeout(resolve, 5)); });
  await render(); await click(button("开始扫描"));
  assert.ok(container.textContent.includes("扫描结果"));
  const visibleChecks = () => [...container.querySelectorAll('input[aria-label^="选择记忆"]')];
  assert.equal(visibleChecks().length, 30); assert.equal(visibleChecks().filter(input => input.checked).length, 0);
  const label = container.textContent.match(/待选 (\d+) 条/); assert.ok(Number(label[1]) > 30);
  await click(button("全选本次全部结果")); assert.ok(button(`导入选中项（${label[1]}）`), "Select-all includes candidates not rendered yet");
  await click(button("取消全选结果"));
  const first = visibleChecks()[0], selectedId = first.getAttribute("aria-label").replace("选择记忆 ", "");
  await act(async () => props(first).onChange({ target: { checked: true } }));
  await click(button("导入选中项（1）")); assert.equal(refreshed, 1); assert.equal(closed, 1);
  const restored = (await loadNativeTimelineAsync("char")).filter(entry => entry.id === selectedId); assert.equal(restored.length, 1);
  assert.ok(records.hiddenMemoryKeys("char").size > 50, "Unselected deleted records remain excluded");
  await act(async () => renderer.unmount()); renderer = createRoot(mount); await render();
  await act(async () => props(container.querySelector('select[aria-label="手动记忆来源"]')).onChange({ target: { value: "moments" } }));
  const textarea = container.querySelector('textarea[aria-label="粘贴记忆内容"]');
  await act(async () => props(textarea).onChange({ target: { value: "时间：2020-03-01 09:00\n发布人：简初\n内容：历史朋友圈" } }));
  await click(button("预览待导入内容")); assert.ok(container.textContent.includes("导入预览")); assert.equal(visibleChecks().length, 1);
  await click(button("全选本次全部结果")); await click(button("导入选中项（1）"));
  assert.ok(records.loadManualShortMemories("char").some(entry => entry.content.includes("历史朋友圈") && entry.timestamp.startsWith("2020-03-01")));
  assert.equal(kv.kvGet("long-memory-test"), "长期记忆保持原样");
  await act(async () => renderer.unmount());

  // Actual story storage: scanning can find saved main/branch replies that were never projected.
  const realStory = originalLoad.call(Module, path.join(root, "lib/story-storage.ts"), module);
  await realStory.hydrateStoryStorage();
  const mainStory = realStory.createOrGetStorySession("story-char");
  const branchStory = realStory.createOrGetStorySession("story-char", { branchId: "rain", branchName: "雨夜分线", inheritRecentMemory: false });
  realStory.replaceStoryMessages(mainStory.id, [{ id: "story-main-raw", sessionId: mainStory.id, role: "assistant", rawContent: "主线尚未总结的正文", createdAt: "2022-01-01T00:00:00Z" }]);
  realStory.replaceStoryMessages(branchStory.id, [{ id: "story-branch-raw", sessionId: branchStory.id, role: "assistant", rawContent: "<thinking>不应作为记忆的推理</thinking>分线尚未总结的正文", createdAt: "2021-01-01T00:00:00Z" }]);
  assert.equal(realStory.loadStoryProjectionEntries("story-char").length, 0);
  const discovered = realStory.loadStoryProjectionEntries("story-char", { includeUnmemorized: true });
  assert.equal(discovered.length, 2); assert.ok(discovered.some(entry => entry.sourceLabel === "雨夜分线"));
  assert.ok(discovered.every(entry => !entry.content.includes("不应作为记忆的推理")));
  assert.equal(realStory.loadStoryProjectionEntries("unrelated", { includeUnmemorized: true }).length, 0);

  // The generation service uses the character's Moments binding and read-only memory, with no hidden embedding call.
  const vm = require("node:vm"), generationModule = { exports: {} }, requests = [], imageRequests = [];
  const dependencies = {
    "./character-storage": { loadCharacters: () => [{ id: "char", name: "角色", persona: "冬日设定", personality: "安静" }] },
    "./character-world-storage": { loadCharacterWorldGroups: () => [{ name: "冬日世界", description: "城市", memberIds: ["char"] }] },
    "./settings-storage": { loadBindingConfig: () => ({}), resolveBinding: (_config, id, app) => { assert.equal(id, "char"); assert.equal(app, "moments"); return { apiConfigId: "role-api" }; },
      loadApiConfigs: () => [{ id: "role-api" }], resolveUserIdentity: () => ({ name: "简初" }) },
    "./api-helpers": { simpleLLMCall: async (config, messages, options) => { requests.push({ config, messages, options }); return { content: "雪落时也想起你" }; } },
    "./memory-storage": { loadMemoryEntriesByType: async (id, type) => { assert.equal(id, "char"); return [{ content: type === "core" ? "角色核心记忆" : "角色长期记忆", createdAt: "2025-01-01" }]; } },
    "./short-term-assembler": { loadNativeTimelineAsync: async () => [], prepareShortTermContext: () => ({ recentBlocks: [{ content: "角色近期记忆" }] }) },
    "./image-generation-service": { generateImageFromConfiguredApi: async params => { imageRequests.push(params); return { blob: new Blob(["image"]) }; } },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "lib/character-moments-generation.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module: generationModule, exports: generationModule.exports, require: name => dependencies[name], DOMException });
  assert.equal(await generationModule.exports.generateCharacterMomentText("char", "signature"), "雪落时也想起你");
  const request = requests[0]; assert.equal(request.config.id, "role-api");
  for (const text of ["冬日设定", "安静", "冬日世界", "角色核心记忆", "角色长期记忆", "角色近期记忆"]) assert.ok(request.messages[1].content.includes(text));
  await generationModule.exports.generateCharacterMomentText("char", "cover");
  assert.ok(!requests[1].messages[1].content.includes("角色长期记忆"), "Cover follows setting and personality without unrelated memory retrieval");
  await generationModule.exports.generateCharacterMomentCover("char", "冬夜封面");
  assert.equal(imageRequests[0].characterId, "char"); assert.equal(imageRequests[0].appId, "moments"); assert.equal(imageRequests[0].description, "冬夜封面");
  const stop = new AbortController(); stop.abort(); const before = requests.length;
  await assert.rejects(generationModule.exports.generateCharacterMomentText("char", "signature", stop.signal), /取消/); assert.equal(requests.length, before);
  console.log("✅ 记忆扫描与补充：来源/范围、主分线、稳定键去重、删除与选择恢复、跨页全选、文件覆盖新增、粘贴校验、原时间排序及长期记忆隔离通过，无 API 调用");
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
