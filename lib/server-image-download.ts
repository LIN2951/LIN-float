import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as externalFetch } from "undici";

export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 198 && (b === 18 || b === 19));
  }
  // Only globally routed IPv6; excludes loopback, mapped IPv4 and local networks.
  return isIP(address) === 6 && /^[23]/i.test(address) && !address.toLowerCase().startsWith("2001:db8:");
}

/** Read an already generated image. Never accepts credentials or generates images. */
export async function downloadGeneratedImage(rawUrl: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("图片地址必须是公开的 HTTP/HTTPS 地址");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new Error("不允许读取本机或内网图片地址");
    const selected = addresses.find(item => item.family === 4) || addresses[0];
    // Pin the validated address so DNS rebinding cannot bypass the network check.
    const dispatcher = new Agent({ connect: { lookup(_host, options, callback) {
      if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
      else callback(null, selected.address, selected.family);
    } } });
    try {
      const response = await externalFetch(url, { method: "GET", redirect: "manual", signal, dispatcher });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("图片重定向地址缺失");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`图片下载 HTTP ${response.status}`);
      }
      const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!mimeType.startsWith("image/") && mimeType !== "application/octet-stream") {
        await response.body?.cancel();
        throw new Error("图片地址没有返回图片内容");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("图片内容为空");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 50 * 1024 * 1024) throw new Error("图片超过 50MB 下载限制");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!size) throw new Error("图片内容为空");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { bytes, mimeType: mimeType === "application/octet-stream" ? "image/png" : mimeType };
    } finally { await dispatcher.close(); }
  }
  throw new Error("图片地址重定向次数过多");
}
