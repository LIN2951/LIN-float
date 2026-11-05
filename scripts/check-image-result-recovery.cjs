const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const cdn = "https://cdn.example.test/result.png";
const settings = { apiKey: "test-key", baseUrl: "https://relay.example.test/v1", model: "image-model" };
const params = { settings, prompt: "test", referenceImageDataUrl: null };
const imageResponse = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function load(fetcher, saved = new Map(), proxy = "") {
  const source = fs.readFileSync(path.join(root, "lib/image-generation-service.ts"), "utf8")
    + "\nexport const directTest = generateImageDirect; export const serverTest = generateImageViaServerOrProxy;";
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  const calls = [];
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(data => {
        this.result = `data:${blob.type};base64,${Buffer.from(data).toString("base64")}`;
        this.onload();
      }).catch(error => { this.error = error; this.onerror(); });
    }
  }
  vm.runInNewContext(code, {
    module, exports: module.exports, console,
    require: name => name === "./kv-db" ? {
      kvGet: key => saved.get(key), kvSet: (key, value) => saved.set(key, value), registerKvMigration() {},
    } : name === "./sha256-stream" ? { sha256TextHex: async text => crypto.createHash("sha256").update(text).digest("hex") }
      : { throwIfAborted(signal) { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); } },
    process: { env: { NEXT_PUBLIC_IMAGE_GEN_PROXY_URL: proxy } }, crypto: crypto.webcrypto,
    TypeError, Error, DOMException, AbortController, FormData, Blob, TextEncoder, TextDecoder, FileReader, atob,
    setTimeout, clearTimeout,
    fetch: async (url, init) => { calls.push({ url, method: init?.method || "GET", body: init?.body }); return fetcher(url, init); },
  });
  return { api: module.exports, calls, saved };
}

async function main() {
  // A generated URL whose CDN denies browser reads is fetched by the download-only route.
  const recovered = load(async url => {
    if (url === cdn) throw new TypeError("Failed to fetch");
    if (url === "/api/image-generation/download") return imageResponse();
    return json({ data: [{ url: cdn, revised_prompt: "improved" }] });
  });
  assert.ok((await recovered.api.directTest(params)).b64);
  assert.equal(recovered.calls.filter(call => call.url.includes("/images/generations")).length, 1);
  assert.equal(recovered.calls.filter(call => call.url === "/api/image-generation").length, 0);
  const downloadBody = JSON.parse(recovered.calls.find(call => call.url === "/api/image-generation/download").body);
  assert.deepEqual(downloadBody, { url: cdn }, "Download recovery must never send the API key or generation prompt");

  // If downloading still fails, a refresh/retry must not submit another paid POST.
  const failed = load(async url => {
    if (url === cdn) throw new TypeError("CORS");
    if (url === "/api/image-generation/download") return json({ error: "CDN unavailable" }, 502);
    return json({ data: [{ url: cdn }] });
  });
  await assert.rejects(failed.api.directTest(params), /图片已生成，但下载失败/);
  await assert.rejects(failed.api.directTest(params), /图片已生成，但下载失败/);
  assert.equal(failed.calls.filter(call => call.url.includes("/images/generations")).length, 1);
  assert.ok(![...failed.saved.values()].join("").includes(settings.apiKey));
  const refreshed = load(async () => imageResponse(), failed.saved);
  await refreshed.api.serverTest(params);
  assert.deepEqual(refreshed.calls.map(call => call.url), [cdn], "Switching request modes must still recover the original image");

  const server = load(async url => {
    assert.equal(url, "/api/image-generation");
    return json({ b64: "AA==", mimeType: "image/png" });
  });
  assert.equal((await server.api.serverTest(params)).b64, "AA==");
  assert.equal(server.calls.length, 1, "Server mode must never probe the generation API from the browser");

  for (const stream of [false, true]) {
    const completed = load(async url => {
      if (url === "/api/image-generation") {
        const result = { generationCompleted: true, imageUrl: cdn, error: "download failed", httpStatus: 502 };
        return stream ? new Response(" \n@@RESULT@@" + JSON.stringify(result), { headers: { "content-type": "text/plain" } }) : json(result, 502);
      }
      return imageResponse();
    });
    assert.ok((await completed.api.serverTest(params)).b64);
    assert.equal(completed.calls.filter(call => call.url === "/api/image-generation").length, 1);
  }

  const b64 = load(async () => json({ data: [{ b64_json: "AA==" }] }));
  assert.equal((await b64.api.directTest(params)).b64, "AA==");
  assert.equal(b64.calls.length, 1);
  const unavailable = load(async () => { throw new TypeError("connection closed"); });
  await assert.rejects(unavailable.api.serverTest(params), /connection closed/);
  assert.equal(unavailable.calls.length, 1, "Unknown request failures must not silently resubmit generation");
  const worker = load(async () => { throw new TypeError("proxy disconnected"); }, new Map(), "https://worker.example.test");
  await assert.rejects(worker.api.serverTest(params), /上游可能已经生成/);
  assert.equal(worker.calls.length, 1, "Worker failures must not fall back to another paid request");
  assert.match(worker.calls[0].url, /^https:\/\/worker\.example\.test\//);
  // The download endpoint may read public image URLs only, including redirect targets.
  const serverModule = { exports: {} };
  let downloadCalls = 0;
  const serverCode = ts.transpileModule(fs.readFileSync(path.join(root, "lib/server-image-download.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(serverCode, {
    module: serverModule, exports: serverModule.exports, URL, Uint8Array, Error,
    require: name => name === "undici" ? {
      Agent: class { async close() {} },
      fetch: async (_url, init) => {
        downloadCalls++;
        assert.equal(init.method, "GET");
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      },
    } : name === "node:dns/promises" ? { lookup: async () => [{ address: "8.8.8.8", family: 4 }] } : require(name),
  });
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1"]) {
    assert.equal(serverModule.exports.isPublicImageAddress(address), false);
  }
  assert.equal(serverModule.exports.isPublicImageAddress("8.8.8.8"), true);
  await assert.rejects(serverModule.exports.downloadGeneratedImage("https://cdn.example.test/image", new AbortController().signal), /内网/);
  assert.equal(downloadCalls, 1, "Private redirects must be blocked before making another request");
  console.log("✅ 生图结果恢复回归通过：跨域下载、持久化重试、切换模式、心跳结果、Base64、禁止重复生成");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
