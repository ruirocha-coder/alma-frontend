export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text, voiceId, model } = (await req.json()) as {
      text?: string; voiceId?: string; model?: string;
    };

    const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
    const ELEVEN_VOICE_ID = voiceId || process.env.ELEVENLABS_VOICE_ID || "";
    const ELEVEN_MODEL = model || process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

    if (!ELEVEN_API_KEY) return new Response("TTS error: ELEVENLABS_API_KEY missing", { status: 500 });
    if (!ELEVEN_VOICE_ID) return new Response("TTS error: ELEVENLABS_VOICE_ID missing", { status: 500 });

    const prompt = (text || "").trim();
    if (!prompt) return new Response("TTS error: missing text", { status: 400 });

    const truncated = prompt.length > 1200 ? prompt.slice(0, 1200) + "…" : prompt;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: truncated,
        model_id: ELEVEN_MODEL,
        output_format: "mp3_44100_128",
      }),
    });

    if (!r.ok) {
      const textErr = await r.text().catch(() => "");
      console.error("[/api/tts] ElevenLabs error:", r.status, textErr);
      return new Response(`TTS error upstream: ${r.status} ${textErr}`, { status: 502 });
    }

    const ab = await r.arrayBuffer();
    return new Response(ab, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    console.error("[/api/tts] handler error:", err);
    return new Response(`TTS error handler: ${(err?.message as string) || String(err)}`, { status: 502 });
  }
}
