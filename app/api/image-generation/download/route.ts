import { NextRequest, NextResponse } from "next/server";
import { downloadGeneratedImage } from "@/lib/server-image-download";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const input = await request.json().catch(() => null);
  if (typeof input?.url !== "string" || input.url.length > 16000) {
    return NextResponse.json({ error: "缺少有效图片地址" }, { status: 400 });
  }
  try {
    const { bytes, mimeType } = await downloadGeneratedImage(input.url, AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]));
    return new Response(bytes as BodyInit, { headers: { "Content-Type": mimeType, "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "原图下载失败" }, { status: 502 });
  }
}
