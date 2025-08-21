// app/api/tts/route.ts
import { NextRequest, NextResponse } from "next/server";

const ELEVEN_API = "https://api.elevenlabs.io/v1/text-to-speech";

export async function POST(req: NextRequest) {
  try {
    const { text, voiceId } = await req.json();
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const defaultVoice = process.env.ELEVENLABS_VOICE_ID;

    if (!apiKey) {
      return new Response("Missing ELEVENLABS_API_KEY", { status: 500 });
    }
    if (!text || !(text as string).trim()) {
      return new Response("Missing text", { status: 400 });
    }

    const vid = (voiceId || defaultVoice || "").trim();
    if (!vid) {
      return new Response("Missing ELEVENLABS_VOICE_ID", { status: 500 });
    }

    const res = await fetch(`${ELEVEN_API}/${encodeURIComponent(vid)}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        // usa um modelo rápido e barato; muda se quiseres
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      return new Response(`TTS error: ${res.status} ${errTxt}`, { status: 502 });
    }

    // Pass-through do MP3 para o browser
    return new Response(res.body, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  } catch (e: any) {
    return new Response(`TTS route error: ${e?.message || e}`, { status: 500 });
  }
}
