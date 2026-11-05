const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function load(file, dependencies = {}, extras = {}, suffix = "") {
    const module = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8") + suffix, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const fallback = new Proxy({}, { get: () => () => [] });
    vm.runInNewContext(code, { module, exports: module.exports, require: name => dependencies[name] || fallback,
        console, process: { env: {} }, setTimeout, clearTimeout, ...extras });
    return module.exports;
}

async function main() {
    const crop = load("lib/face-crop.ts");
    const rectangle = { x: 0.2, y: 0.1, width: 0.4, height: 0.7 };
    assert.equal(JSON.stringify(crop.faceCropPixels(rectangle, 1200, 1800)), JSON.stringify({ x: 240, y: 180, width: 480, height: 1260 }));
    assert.equal(JSON.stringify(crop.faceCropPixels({ x: 0.2, y: 0.1, size: 0.5 }, 1200, 1800)), JSON.stringify({ x: 240, y: 180, width: 600, height: 600 }));
    const portrait = crop.resolveFaceCrop(rectangle, 400, 600);
    assert.equal(portrait.width * 400, 160);
    assert.equal(portrait.height * 600, 420);
    const edge = crop.faceCropPixels({ x: 1, y: 1, width: 1, height: 0.8 }, 1200, 1800);
    assert.ok(edge.x >= 0 && edge.y >= 0 && edge.x + edge.width <= 1200 && edge.y + edge.height <= 1800);
    assert.ok(Number.isFinite(crop.normalizeFaceCrop({ x: NaN, y: Infinity, width: NaN, height: -2 }).width));

    // Check real settings normalization does not drop independently saved dimensions.
    const settings = load("lib/settings-storage.ts", { "./face-crop": crop }, {},
        "\nexport const testNormalize = normalizeImageGenerationSettings;");
    const restored = settings.testNormalize({ characterReferences: { char: { faceCrop: rectangle } }, userReferences: { user: { faceCrop: rectangle } } });
    assert.equal(JSON.stringify(restored.characterReferences.char.faceCrop), JSON.stringify(rectangle));
    assert.equal(JSON.stringify(restored.userReferences.user.faceCrop), JSON.stringify(rectangle));

    // Exercise the actual canvas crop sent to the image service, without calling an API.
    let drawArgs;
    const canvas = { getContext: () => ({ drawImage: (...args) => { drawArgs = args; } }), toDataURL: () => "data:image/png;base64,AA==" };
    class Image {
        naturalWidth = 1200; naturalHeight = 1800;
        set src(_value) { Promise.resolve().then(() => this.onload()); }
    }
    const service = load("lib/image-generation-service.ts", { "./face-crop": crop }, {
        Image, document: { createElement: () => canvas }, fetch() { throw new Error("No paid API calls allowed"); },
    }, "\nexport const testCrop = normalizeReferenceImageForEdit;");
    await service.testCrop("data:image/png;base64,AA==", rectangle);
    assert.equal(canvas.width, 480);
    assert.equal(canvas.height, 1260);
    assert.equal(JSON.stringify(drawArgs.slice(1)), JSON.stringify([240, 180, 480, 1260, 0, 0, 480, 1260]));

    const { floatingPhoneGeometry } = load("lib/floating-phone-geometry.ts");
    const max = floatingPhoneGeometry({ width: 500, height: 800 }, 1);
    assert.equal(max.width, 390); assert.equal(max.height, 720);
    const min = floatingPhoneGeometry({ width: 500, height: 800 }, 0);
    assert.ok(min.width >= 280 && min.height >= 420);
    assert.ok(min.width < max.width && min.height < max.height);
    for (const bounds of [{ width: 320, height: 280 }, { width: 500, height: 800 }, { width: 230, height: 200 }]) {
        for (const scale of [0.1, 0.8, 0.93, 1, 2]) {
            const frame = floatingPhoneGeometry(bounds, scale, false, { x: -1000, y: 10000 });
            assert.ok(frame.x >= 0 && frame.y >= 0);
            assert.ok(frame.x + frame.width <= bounds.width && frame.y + frame.height <= bounds.height);
        }
    }
    console.log("✅ 矩形脸部选区、旧数据兼容、保存恢复、实际画布裁剪、窗口缩放与边界回归通过");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
