// app/api/tts/route.ts
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || !text.trim()) {
      return new Response("Missing text", { status: 400 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "Rachel"; // mete o teu VOICE_ID
    const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

    if (!apiKey) {
      return new Response("ELEVENLABS_API_KEY not set", { status: 500 });
    }

    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          model_id: modelId,
          text,
          // PT-PT melhora “s”/“z” e prosódia
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
        }),
      }
    );

    if (!r.ok) {
      const errTxt = await r.text();
      return new Response(`TTS error: ${r.status} ${errTxt}`, { status: 502 });
    }

    // Stream MP3 de volta
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return new Response(`TTS exception: ${e?.message || e}`, { status: 500 });
  }
}
