// End-to-end archive round trip against IndexedDB, without real network or paid APIs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
require("fake-indexeddb/auto");
const root = path.resolve(__dirname, "..");
const memoryStorage = new Map();
global.localStorage = { getItem: key => memoryStorage.get(key) ?? null, setItem: (key, value) => memoryStorage.set(key, value), removeItem: key => memoryStorage.delete(key),
  key: index => [...memoryStorage.keys()][index] ?? null, get length() { return memoryStorage.size; } };
global.window = Object.assign(new EventTarget(), { localStorage, location: { origin: "https://test.invalid" } });
global.FileReader = class {
  readAsArrayBuffer(blob) { this.read(blob, false); }
  readAsDataURL(blob) { this.read(blob, true); }
  read(blob, dataUrl) {
    blob.arrayBuffer().then(bytes => {
      this.result = dataUrl ? `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}` : bytes;
      this.onload?.({ target: this }); this.onloadend?.({ target: this });
    }).catch(error => { this.error = error; this.onerror?.(error); });
  }
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, parent, ...rest);
};
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, filename);

function open(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(name, store, rows, clear = false) {
  const db = await open(name);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    if (clear) tx.objectStore(store).clear();
    rows.forEach(row => tx.objectStore(store).put(row));
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function read(name, store) {
  const db = await open(name);
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); return rows;
}
async function main() {
  const { storeMediaBlob, deleteMediaRef } = require(path.join(root, "lib/media-cache-storage.ts"));
  const backup = require(path.join(root, "lib/data-management/backup.ts"));
  const JSZip = require("jszip");
  const wav = new Blob([Buffer.from("RIFF"), new Uint8Array(2500), Buffer.from("WAVE")], { type: "audio/wav" });
  const png = new Blob([Buffer.from("89504e470d0a1a0a", "hex"), new Uint8Array(2200)], { type: "image/png" });
  const audioRef = await storeMediaBlob(wav, wav.type, "audio");
  const imageRef = await storeMediaBlob(png, png.type, "image");
  const imageDataUrl = `data:image/png;base64,${Buffer.from(await png.arrayBuffer()).toString("base64")}`;
  (await open("ai_phone_theme_db_v1", 2, db => db.createObjectStore("assets", { keyPath: "id" }))).close();
  await write("ai_phone_theme_db_v1", "assets", [{ id: "asset-one", dataUrl: imageDataUrl }]);
  (await open("AiPhoneFavoritesDB", 10, db => {
    const store = db.createObjectStore("items", { keyPath: "id" });
    store.createIndex("createdAt", "createdAt");
  })).close();
  const now = new Date().toISOString();
  const item = (id, entityId, entry, extra = {}) => ({ id, category: "chat", kind: "message", scopeKey: "main::default", scopeLabel: "主号",
    chatAccountId: null, userIdentityId: null, entityType: "character", entityId, entityName: entityId, participantIds: [entityId], participantNames: [entityId],
    containerId: `session-${id}`, containerName: "会话", sourceItemIds: [id], sourceCreatedAt: now, createdAt: now, updatedAt: now, title: id, preview: "内容", tags: ["收藏"],
    entries: [{ id, role: "assistant", senderName: entityId, content: "原文", createdAt: now, ...entry }], ...extra });
  const items = [
    item("a-voice", "甲", { mediaType: "audio", mediaUrl: audioRef, mediaData: { voiceDuration: 4 } }),
    item("a-story", "甲", { mediaType: "image", mediaUrl: "asset://asset-one" }, { category: "story", scopeKey: "alt::one", chatAccountId: "alt" }),
    item("a-group", "group-one", { mediaType: "image", mediaUrl: "https://expired.invalid/image", mediaData: { imageGenerationMediaRef: imageRef } }, { entityType: "group", participantIds: ["甲", "乙"], participantNames: ["甲", "乙"] }),
    item("b-only", "乙", { mediaType: "image", mediaUrl: "https://media.invalid/image.png" }),
    item("a-video", "甲", { mediaType: "media_file", mediaUrl: "https://media.invalid/clip.mp4", mediaData: { fileType: "video" } }),
    item("a-rich", "甲", { content: `<img src="${imageRef}">` }, { category: "story" }),
    item("a-remote-voice", "甲", { mediaType: "audio", mediaUrl: "https://media.invalid/voice.wav" }),
  ];
  await write("AiPhoneFavoritesDB", "items", items);
  const requests = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith("data:")) return realFetch(url);
    requests.push([url, options?.method || "GET"]);
    if (url === "https://media.invalid/image.png") throw new Error("Mock CORS");
    if (url === "/api/image-generation/download") return new Response(png);
    if (url === "https://media.invalid/voice.wav") return new Response(wav);
    if (url === "https://media.invalid/clip.mp4") return new Response(new Blob(["video"], { type: "video/mp4" }));
    throw new Error(`Unexpected network: ${url}`);
  };

  const all = await backup.createBackupBlob(["favorites"]);
  assert.equal(all.manifest.totalRecords, items.length);
  assert.deepEqual(all.manifest.modules.map(module => module.id), ["favorites"]);
  const archive = await JSZip.loadAsync(all.blob);
  const encoded = JSON.parse(await archive.file("modules/favorites/000.json").async("string"));
  assert.ok(Object.keys(archive.files).some(name => name.startsWith("media/")));
  assert.ok(!JSON.stringify(encoded).includes("media-store://"));
  assert.ok(!JSON.stringify(encoded).includes("asset://"));
  assert.ok(!requests.some(([url]) => String(url).includes("expired.invalid")), "Use the cached generated original");
  const single = await backup.createBackupBlob(["favorites"], { favoriteEntity: { id: "甲", type: "character" } });
  assert.equal(single.manifest.totalRecords, items.length - 1, "Includes both categories, alt accounts and shared group collections");
  const group = await backup.createBackupBlob(["favorites"], { favoriteEntity: { id: "group-one", type: "group" } });
  assert.equal(group.manifest.totalRecords, 1);

  // Restore on an empty device: original caches are intentionally absent.
  await deleteMediaRef(audioRef); await deleteMediaRef(imageRef);
  await write("ai_phone_theme_db_v1", "assets", [], true);
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("AiPhoneFavoritesDB");
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
  const restored = await backup.importBackupBlob(all.blob, ["favorites"]);
  assert.equal(restored.added, items.length); assert.deepEqual(restored.errors, []);
  const rows = await read("AiPhoneFavoritesDB", "items");
  const freshDb = await open("AiPhoneFavoritesDB");
  assert.ok(freshDb.transaction("items").objectStore("items").indexNames.contains("createdAt"));
  freshDb.close();
  for (const id of ["a-voice", "a-remote-voice"]) {
    const entry = rows.find(row => row.id === id).entries[0];
    assert.match(entry.mediaUrl, /^data:audio\/wav;base64,/);
    assert.deepEqual(Buffer.from(await (await realFetch(entry.mediaUrl)).arrayBuffer()), Buffer.from(await wav.arrayBuffer()));
  }
  for (const id of ["a-story", "a-group", "b-only"]) {
    const entry = rows.find(row => row.id === id).entries[0];
    assert.match(entry.mediaUrl, /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(await (await realFetch(entry.mediaUrl)).arrayBuffer()), Buffer.from(await png.arrayBuffer()));
  }
  assert.match(rows.find(row => row.id === "a-rich").entries[0].content, /src="data:image\/png;base64,/);
  assert.match(rows.find(row => row.id === "a-video").entries[0].mediaUrl, /^data:video\/mp4;base64,/);
  assert.equal(rows.find(row => row.id === "a-story").chatAccountId, "alt");
  assert.equal((await backup.importBackupBlob(all.blob, ["favorites"])).skipped, items.length);
  assert.equal((await backup.importBackupBlob(all.blob, ["favorites"], { overwrite: true })).overwritten, items.length);

  // An old social archive still imports through the favorites-only entry point.
  encoded.moduleId = "social";
  archive.file("modules/favorites/000.json", JSON.stringify(encoded));
  const legacy = await archive.generateAsync({ type: "blob" });
  assert.equal((await backup.importBackupBlob(legacy, ["favorites"], { overwrite: true })).overwritten, items.length);
  // Tampered media must not write empty placeholders as if restoration succeeded.
  const corrupt = await JSZip.loadAsync(all.blob);
  for (const name of Object.keys(corrupt.files)) if (name.startsWith("media/") && name.endsWith(".bin")) corrupt.remove(name);
  const broken = await corrupt.generateAsync({ type: "blob" });
  await write("AiPhoneFavoritesDB", "items", [], true);
  const damaged = await backup.importBackupBlob(broken, ["favorites"]);
  assert.ok(damaged.errors.length > 0);
  assert.ok(!(await read("AiPhoneFavoritesDB", "items")).some(row => row.id === "a-voice"));

  const foreignSource = await JSZip.loadAsync(all.blob);
  foreignSource.file("modules/favorites/000.json", JSON.stringify({ moduleId: "favorites", sources: [{ type: "kv", records: [{ key: "must-not-import", value: "changed" }] }] }));
  const rejected = await backup.importBackupBlob(await foreignSource.generateAsync({ type: "blob" }), ["favorites"]);
  assert.ok(rejected.errors.length);
  assert.equal(rejected.added, 0, "The Favorites app must never import unrelated settings");

  const missing = item("missing", "甲", { mediaType: "audio", mediaUrl: audioRef });
  await write("AiPhoneFavoritesDB", "items", [missing], true);
  await assert.rejects(backup.createBackupBlob(["favorites"]), /已停止导出/);
  const light = await backup.createBackupBlob(["favorites"], { excludeMedia: true });
  assert.equal(light.manifest.mediaExcluded, true);
  // Excluding favorites must not touch their broken refs or pull their database in via social.
  const social = await backup.buildBackupEnvelope(["social"]);
  assert.ok(!JSON.stringify(social).includes("AiPhoneFavoritesDB"));

  const settings = require(path.join(root, "lib/floating-phone-settings.ts"));
  assert.equal(settings.loadFloatingPhoneScale(), 1);
  settings.saveFloatingPhoneScale(0.87);
  delete require.cache[require.resolve(path.join(root, "lib/floating-phone-settings.ts"))];
  assert.equal(require(path.join(root, "lib/floating-phone-settings.ts")).loadFloatingPhoneScale(), 0.87);
  assert.equal(settings.saveFloatingPhoneScale(0.01), 0.8);
  assert.equal(settings.saveFloatingPhoneScale(2), 1);
  assert.equal(settings.normalizeFloatingPhoneScale(NaN), 1);
  assert.ok(requests.every(([url, method]) => method === "GET" || url === "/api/image-generation/download"));
  console.log("✅ 收藏 ZIP/IndexedDB 往返通过：全部/角色/群组、跨账号分类、原缓存清空后语音图片视频可恢复、重复导入、旧版兼容、损坏媒体拦截、模块排除与窗口尺寸记忆；未调用生成 API");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
