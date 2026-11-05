const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("fake-indexeddb/auto");
const { window } = require("linkedom").parseHTML('<html><body><div class="phone-shell"><div id="root"></div></div></body></html>');
Object.assign(global, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node,
  CustomEvent: window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => { throw Error("Tests must never call real APIs"); } });
const root = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, parent, ...rest);
};
for (const extension of [".ts", ".tsx"]) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);
const mocks = new Map();
const originalLoad = Module._load;
Module._load = function(request, parent, ...rest) {
  const resolved = Module._resolveFilename(request, parent);
  if (mocks.has(resolved)) return mocks.get(resolved);
  return originalLoad.call(this, request, parent, ...rest);
};
const mock = (name, value) => mocks.set(path.join(root, name), value);

async function main() {
  const React = require("react"), { act } = React, { createRoot } = require("react-dom/client");
  const container = document.getElementById("root");
  let renderer = createRoot(container);
  const render = async element => act(async () => { renderer.render(element); });
  const unmount = async () => { await act(async () => renderer.unmount()); renderer = createRoot(container); };
  const click = async element => { assert.ok(element, "Expected button"); await act(async () => element.dispatchEvent(new window.Event("click", { bubbles: true }))); };
  const props = element => element[Object.keys(element).find(key => key.startsWith("__reactProps$"))];
  const change = async (element, value) => act(async () => props(element).onChange({ target: { value } }));
  const button = text => [...container.querySelectorAll("button")].find(element => element.textContent === text);
  const back = () => container.querySelector('button[aria-label="返回"]');
  const kv = require(path.join(root, "lib/kv-db.ts"));
  const draftStore = require(path.join(root, "lib/story-input-draft.ts"));
  const { useStoryInputDraft } = require(path.join(root, "components/story/use-story-input-draft.ts"));
  function Composer({ id }) {
    const { draft, setDraft, flush } = useStoryInputDraft(id);
    return React.createElement("div", null, React.createElement("textarea", { value: draft, onBlur: flush, onChange: event => setDraft(event.target.value) }),
      React.createElement("button", { onClick: () => setDraft("") }, "发送"));
  }
  const composer = id => React.createElement(Composer, { key: id, id });
  await render(composer("main"));
  const text = "  还没有发出的中文\n第二段🌙  ";
  await change(container.querySelector("textarea"), text);
  await act(async () => { window.dispatchEvent(new window.Event("resize")); });
  assert.equal(draftStore.loadStoryInputDraft("main"), text, "Closing keyboard saves exact text");
  await unmount(); await render(composer("main"));
  assert.equal(props(container.querySelector("textarea")).value, text, "Reopening restores unsent text");
  await change(container.querySelector("textarea"), "退出前的最后一个字");
  await render(composer("branch"));
  assert.equal(draftStore.loadStoryInputDraft("main"), "退出前的最后一个字", "Unmount flushes the latest keystroke");
  assert.equal(props(container.querySelector("textarea")).value, "", "Branches have independent drafts");
  await change(container.querySelector("textarea"), "分线草稿");
  await act(async () => props(container.querySelector("textarea")).onBlur());
  assert.equal(draftStore.loadStoryInputDraft("branch"), "分线草稿");
  await render(composer("main")); await click(button("发送"));
  assert.equal(draftStore.loadStoryInputDraft("main"), "", "Send clears disk immediately");
  await unmount(); await render(composer("main")); assert.equal(props(container.querySelector("textarea")).value, "");
  await change(container.querySelector("textarea"), "自动防丢草稿");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 380)); });
  assert.equal(draftStore.loadStoryInputDraft("main"), "自动防丢草稿");
  await change(container.querySelector("textarea"), "后台前保存");
  await act(async () => { window.dispatchEvent(new window.Event("pagehide")); });
  assert.equal(draftStore.loadStoryInputDraft("main"), "后台前保存");
  await unmount();

  window.visualViewport = document.createElement("div");
  await render(composer("viewport-keyboard")); await change(container.querySelector("textarea"), "视觉视口收键盘");
  await act(async () => window.visualViewport.dispatchEvent(new window.Event("resize")));
  assert.equal(draftStore.loadStoryInputDraft("viewport-keyboard"), "视觉视口收键盘");
  await unmount();

  const character = { id: "char-a", name: "角色原名", avatar: "/avatar.png", wechatID: "wx123", persona: "", createdAt: "", updatedAt: "" };
  let scope = { chatAccountId: null, userIdentityId: null, worldId: null };
  const identity = { id: "identity", name: "简初", avatarUrl: "/user.png" };
  let sessions = [{ id: "main-session", contactId: character.id, alias: "主号备注" }, { id: "alt-session", contactId: character.id, chatAccountId: "alt", alias: "小号备注" }];
  let posts = Array.from({ length: 13 }, (_, index) => ({ id: `post-${index}`, authorType: "character", authorId: character.id,
    content: `角色动态${index}`, createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), likes: [], visibility: [], ...(index === 12 ? { photoUrl: "asset://photo" } : {}) }));
  posts.push({ id: "other", authorType: "character", authorId: "char-b", content: "别人的动态", createdAt: "2026-06-01" },
    { id: "user", authorType: "user", authorId: character.id, content: "用户动态", createdAt: "2026-06-01" });
  let createdSessions = 0, requestedComments = 0, published = 0;
  const chatStore = { loadChatContacts: () => [{ id: "contact", characterId: character.id, addedAt: "" }], loadChatSessions: () => sessions,
    createOrGetSession: id => { createdSessions++; return sessions.find(session => session.contactId === id && (session.chatAccountId || null) === scope.chatAccountId); },
    resolveChatCharacterAvatar: char => char?.avatar || "", hydrateChatStorage: async () => {}, markChatSessionRead() {}, setActiveChatSessionId() {},
    loadChatMessages: () => [], pushChatMessage() {} };
  mock("lib/chat-storage.ts", chatStore);
  mock("lib/character-storage.ts", { loadCharacters: () => [character] });
  mock("lib/chat-scope-storage.ts", { CHAT_SCOPE_UPDATED_EVENT: "scope-updated", loadChatScope: () => scope,
    resolveChatScopeUserIdentity: () => identity, characterMatchesChatScope: () => true,
    resolveChatAccountUserIdentity: () => identity, sessionMatchesChatScope: session => (session.chatAccountId || null) === scope.chatAccountId });
  mock("lib/character-world-storage.ts", { loadCharacterWorldGroups: () => [{ id: "world", name: "冬日世界", memberIds: [character.id] }] });
  mock("lib/settings-storage.ts", { USER_IDENTITIES_UPDATED_EVENT: "identity-updated", loadUserIdentities: () => [identity] });
  let generatedSignatures = 0, generatedCovers = 0, failProfileGeneration = false;
  mock("lib/character-moments-generation.ts", {
    generateCharacterMomentText: async (_id, kind) => { if (failProfileGeneration) throw Error("模拟生成失败"); if (kind === "signature") { generatedSignatures++; return "新的角色签名"; } return "冬夜的城市街景"; },
    generateCharacterMomentCover: async () => { generatedCovers++; return { blob: new Blob(["generated"], { type: "image/png" }) }; },
  });
  mock("lib/moments-storage.ts", { getAllPosts: () => posts, loadMomentPosts: () => posts, getUnreadMomentsNotifications: () => [], saveMomentsLastSeen() {},
    deleteMomentPost: id => { posts = posts.filter(post => post.id !== id); }, addMomentComment: value => { requestedComments++; return value; } });
  mock("lib/moments-engine.ts", { onUserComment() {}, MOMENT_PHOTO_GENERATION_FAILED_EVENT: "photo-failed" });
  let savedCover = 0;
  mock("lib/chat-asset-storage.ts", { getChatImageFromIndexedDB: async id => `data:image/png;base64,${id}`, saveChatImageToIndexedDB: async () => `cover-${++savedCover}` });
  mock("components/chat/moment-post-card.tsx", { MomentPostCard: ({ post, onOpenCommentComposer }) => React.createElement("article", { "data-moment-post-id": post.id }, post.content,
    React.createElement("button", { onClick: () => onOpenCommentComposer(post) }, "评论")) });
  mock("components/chat/moments-compose.tsx", { MomentsCompose: () => { published++; return null; } });
  mock("components/chat/generated-image-error-dialog.tsx", { GeneratedImageErrorDialog: () => null });
  const mascotSettings = { chatEnabled: false };
  mock("lib/mascot-settings.ts", { DEFAULT_MASCOT_AVATAR: "", subscribeMascotSettings: () => () => {}, getMascotSettingsSnapshot: () => mascotSettings,
    resolveMascotImageRef: async () => "", updateMascotSettings() {} });
  mock("lib/chat-alt-account-storage.ts", { findChatAltAccount: () => scope.chatAccountId ? { id: "alt", friendCharacterIds: [character.id], createdAt: "" } : undefined, addChatAltAccountFriend() {} });
  mock("lib/friend-request-storage.ts", { getPendingFriendRequests: () => [], clearRequestsForCharacter() {}, updateFriendRequestStatus() {}, dispatchFriendRequestUpdated() {} });
  mock("lib/friend-request-engine.ts", { PENDING_REPLY_PREFIX: "pending", handleAcceptFriendRequest: async () => sessions[0], triggerRejectReaction: async () => {} });
  const profiles = require(path.join(root, "lib/character-moments-profile.ts"));
  profiles.saveCharacterMomentsProfile(character.id, { signature: "角色的个性签名", coverAssetId: "character-cover" });
  kv.kvSet("moments_signature", "用户签名");
  const { ContactProfilePage } = require(path.join(root, "components/chat/contact-profile-page.tsx"));
  let backCount = 0, messageCount = 0, calls = [];
  const profile = () => React.createElement(ContactProfilePage, { character, onBack: () => backCount++, onMessage: () => messageCount++, onCall: type => calls.push(type) });
  await render(profile());
  assert.match(container.textContent, /主号备注/); assert.match(container.textContent, /角色原名/);
  assert.match(container.textContent, /wx123/); assert.match(container.textContent, /冬日世界/);
  assert.ok(!container.textContent.includes("朋友资料")); assert.equal(createdSessions, 0, "Viewing profile does not create a chat or call API");
  await click(button("发消息")); assert.equal(messageCount, 1);
  await click(button("音视频通话")); await click(button("语音通话")); await click(button("视频通话")); assert.deepEqual(calls, ["voice", "video"]);
  await click(container.querySelector(".contact-profile-moments"));
  assert.equal(container.querySelectorAll("[data-moment-post-id]").length, 10, "Personal timeline paginates without dropping old posts");
  assert.ok(!container.textContent.includes("别人的动态")); assert.ok(!container.textContent.includes("用户动态"));
  assert.match(container.textContent, /角色的个性签名/); assert.ok(!container.textContent.includes("用户签名"));
  await click(button("刷新签名"));
  assert.equal(generatedSignatures, 1); assert.equal(profiles.loadCharacterMomentsProfile(character.id).signature, "角色的个性签名", "Preview never replaces signature automatically");
  await click(button("应用签名")); assert.equal(profiles.loadCharacterMomentsProfile(character.id).signature, "新的角色签名");
  failProfileGeneration = true; await click(button("刷新签名"));
  assert.equal(profiles.loadCharacterMomentsProfile(character.id).signature, "新的角色签名"); assert.ok(container.textContent.includes("模拟生成失败")); failProfileGeneration = false;
  await click(button("更换角色朋友圈封面") || container.querySelector('[aria-label="更换角色朋友圈封面"]'));
  await click(button("根据角色设定构思封面"));
  assert.equal(props(container.querySelector('[aria-label="角色封面画面描述"]')).value, "冬夜的城市街景");
  const savedURLCreate = URL.createObjectURL, savedURLRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:generated-cover"; URL.revokeObjectURL = () => {};
  await click(button("生成封面图片")); assert.equal(generatedCovers, 1);
  assert.equal(profiles.loadCharacterMomentsProfile(character.id).coverAssetId, "character-cover", "Generated cover awaits Apply");
  await click(button("应用封面")); assert.equal(profiles.loadCharacterMomentsProfile(character.id).coverAssetId, "cover-1");
  URL.createObjectURL = savedURLCreate; URL.revokeObjectURL = savedURLRevoke;
  assert.ok(!container.querySelector('[aria-label="发布朋友圈"]'), "Personal timeline cannot publish as another character");
  assert.match(container.querySelector('img[alt="朋友圈封面"]').getAttribute("src"), /cover-1/);
  await click(button("查看更多动态")); assert.equal(container.querySelectorAll("[data-moment-post-id]").length, 13);
  assert.equal(container.querySelectorAll("[data-moment-post-id]")[0].getAttribute("data-moment-post-id"), "post-12");
  await click(button("新的角色签名"));
  const signatureInput = container.querySelector('[aria-label="角色朋友圈个性签名"]');
  await act(async () => props(signatureInput).onBlur({ target: { value: "修改后的角色签名" } }));
  assert.equal(profiles.loadCharacterMomentsProfile(character.id).signature, "修改后的角色签名"); assert.equal(kv.kvGet("moments_signature"), "用户签名");
  // Exercise cover upload and its actual per-character storage target without networking.
  const createElement = document.createElement.bind(document);
  document.createElement = name => { const element = createElement(name); if (name === "canvas") {
    element.getContext = () => ({ drawImage() {} }); element.toBlob = callback => callback(new Blob(["image"], { type: "image/jpeg" }));
  } return element; };
  global.Image = class { width = 100; height = 100; set src(value) { queueMicrotask(() => this.onload()); } };
  const oldCreateURL = URL.createObjectURL, oldRevokeURL = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
  await act(async () => props(container.querySelector('input[type="file"]')).onChange({ target: { files: [{}], value: "" } }));
  assert.equal(profiles.loadCharacterMomentsProfile(character.id).coverAssetId, "cover-2");
  assert.equal(profiles.loadCharacterMomentsProfile("char-b").coverAssetId, undefined);
  URL.createObjectURL = oldCreateURL; URL.revokeObjectURL = oldRevokeURL; document.createElement = createElement;
  await click([...container.querySelectorAll("button")].find(element => element.textContent === "评论"));
  const comment = container.querySelector(".feed-comment-modal-input"); await change(comment, "评论内容"); await click(button("发送"));
  assert.equal(requestedComments, 1, "Existing comments remain available");
  posts.push({ ...posts[0], id: "new-post", content: "新发的角色动态", createdAt: "2026-11-04" });
  await act(async () => window.dispatchEvent(new CustomEvent("moments-updated")));
  assert.ok(container.textContent.includes("新发的角色动态"));
  await click(back()); assert.ok(container.querySelector(".contact-profile-page"));
  await click(back()); assert.equal(backCount, 1); assert.equal(published, 0);
  scope = { ...scope, chatAccountId: "alt" }; await render(profile()); assert.match(container.querySelector("h1").textContent, /小号备注/);
  assert.ok(!container.querySelector("h1").textContent.includes("主号备注")); await unmount();

  // Real contacts list -> profile; share-picker still selects immediately.
  scope = { ...scope, chatAccountId: null };
  const { ChatContactsList } = require(path.join(root, "components/chat/chat-contacts-list.tsx"));
  let selected = [], subpage = false;
  const list = selectForShare => React.createElement(ChatContactsList, { onCloseApp() {}, onSelectMascot() {}, selectForShare,
    onSelectSession: session => selected.push(session), onSubpageChange: open => { subpage = open; } });
  await render(list(false));
  await click([...container.querySelectorAll(".minimal-list-item")].find(element => element.textContent.includes(character.name)));
  assert.ok(container.querySelector(".contact-profile-page")); assert.equal(selected.length, 0); assert.equal(subpage, true);
  await click(back()); assert.equal(subpage, false);
  await render(list(true));
  await click([...container.querySelectorAll(".minimal-list-item")].find(element => element.textContent.includes(character.name)));
  assert.equal(selected[0].id, "main-session"); assert.equal(container.querySelector(".contact-profile-page"), null);
  await unmount();

  // Full app navigation delivers call type to the selected account's chat, including a cached room.
  mock("components/chat/chat-message-list.tsx", { ChatMessageList: () => React.createElement("div", null, "消息列表") });
  mock("components/chat/mascot-chat-room.tsx", { MascotChatRoom: () => null });
  mock("components/chat/user-profile-panel.tsx", { UserProfilePanel: () => null });
  mock("lib/mascot-events.ts", { notifyMascotPageContext() {} });
  mock("lib/chat-session-merge.ts", { CHAT_SESSIONS_MERGED_EVENT: "merged" });
  const deliveredCalls = [];
  mock("components/chat/chat-room.tsx", { ChatRoom: ({ session, contactCallRequest, onContactCallHandled, onBack }) => {
    const last = React.useRef(null);
    React.useEffect(() => {
      if (contactCallRequest && last.current !== contactCallRequest.id) {
        last.current = contactCallRequest.id; deliveredCalls.push({ sessionId: session.id, type: contactCallRequest.type }); onContactCallHandled();
      }
    }, [contactCallRequest, onContactCallHandled, session.id]);
    return React.createElement("button", { onClick: onBack }, "退出测试聊天");
  } });
  const { PhoneChatApp } = require(path.join(root, "components/chat/phone-chat-app.tsx"));
  await render(React.createElement(PhoneChatApp, { onClose() {} }));
  const openCard = async () => {
    await click(button("联系人"));
    await click([...container.querySelectorAll(".minimal-list-item")].find(element => element.textContent.includes(character.name)));
  };
  await openCard();
  assert.equal(container.querySelector(".chat-tab-bar").style.display, "none");
  assert.ok(container.querySelector(".chat-app").hasAttribute("data-tabbar-hidden"));
  await click(container.querySelector(".contact-profile-moments")); await click(back());
  assert.equal(container.querySelector(".chat-tab-bar").style.display, "none", "Returning from moments keeps card navigation isolated");
  await click(button("音视频通话")); await click(button("语音通话"));
  assert.deepEqual(deliveredCalls, [{ sessionId: "main-session", type: "voice" }]);
  await click(button("退出测试聊天")); await openCard(); await click(button("音视频通话")); await click(button("视频通话"));
  assert.deepEqual(deliveredCalls.at(-1), { sessionId: "main-session", type: "video" });
  await act(async () => { scope = { ...scope, chatAccountId: "alt" }; window.dispatchEvent(new CustomEvent("scope-updated", { detail: scope })); });
  await openCard(); await click(button("音视频通话")); await click(button("语音通话"));
  assert.deepEqual(deliveredCalls.at(-1), { sessionId: "alt-session", type: "voice" });
  await unmount();

  // Global feed avatar opens this identity's own timeline; back preserves the original DOM and scroll.
  scope = { ...scope, chatAccountId: null };
  posts.push({ id: "own", authorType: "user", authorId: "user", userIdentityId: identity.id, content: "主身份自己的朋友圈", createdAt: "2026-11-05" },
    { id: "alt-own", authorType: "user", authorId: "user", chatAccountId: "alt", content: "小号自己的朋友圈", createdAt: "2026-11-05" },
    { id: "other-persona", authorType: "user", authorId: "user", userIdentityId: "another-identity", content: "另一个用户身份的朋友圈", createdAt: "2026-11-05" });
  const { MomentsFeed } = require(path.join(root, "components/chat/moments-feed.tsx"));
  await render(React.createElement(MomentsFeed, { onCloseApp() {} }));
  const originalBody = container.querySelector(".moments-feed-page .page-body"); originalBody.scrollTop = 190;
  await click(container.querySelector('[aria-label="打开我的个人朋友圈"]'));
  const personal = container.querySelector(".contact-moments-page");
  assert.ok(personal.textContent.includes("主身份自己的朋友圈"));
  assert.ok(!personal.textContent.includes("角色动态")); assert.ok(!personal.textContent.includes("小号自己的朋友圈"));
  assert.ok(!personal.textContent.includes("另一个用户身份的朋友圈"));
  await click(personal.querySelector('[aria-label="返回"]')); assert.equal(originalBody.scrollTop, 190);
  await unmount();

  // Fresh cache proves drafts and profile edits reach persistent IndexedDB.
  const Dexie = require("dexie").default, disk = new Dexie("AiPhoneKvDB"); disk.version(1).stores({ entries: "key" });
  assert.ok(await disk.table("entries").get("ai_phone_story_input_draft_v1_main"));
  for (const file of ["lib/kv-db.ts", "lib/story-input-draft.ts", "lib/character-moments-profile.ts"]) delete require.cache[require.resolve(path.join(root, file))];
  const fresh = require(path.join(root, "lib/kv-db.ts")); await fresh.hydrateKvDb();
  assert.equal(require(path.join(root, "lib/story-input-draft.ts")).loadStoryInputDraft("main"), "后台前保存");
  assert.equal(require(path.join(root, "lib/story-input-draft.ts")).loadStoryInputDraft("branch"), "分线草稿");
  assert.equal(require(path.join(root, "lib/character-moments-profile.ts")).loadCharacterMomentsProfile(character.id).signature, "修改后的角色签名");
  console.log("✅ 剧情草稿：收键盘/失焦/退出/切分线/重载恢复与发送清空；联系人名片、账号备注、个人动态分页/更新/封面/签名/评论、消息与通话入口回归通过，无真实 API 调用");
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
