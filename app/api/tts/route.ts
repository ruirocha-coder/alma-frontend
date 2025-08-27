// app/api/tts/route.ts
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic"; // sem cache
export const runtime = "nodejs";        // garante Node (binário)

export async function POST(req: NextRequest) {
  try {
    const { text, voiceId: bodyVoiceId } = (await req.json()) || {};
    const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
    const ENV_VOICE = process.env.ELEVENLABS_VOICE_ID || "";
    const voiceId = (bodyVoiceId || ENV_VOICE || "").trim();

    if (!ELEVEN_API_KEY) {
      return new Response("ELEVENLABS_API_KEY em falta", { status: 500 });
    }
    if (!voiceId) {
      return new Response("VOICE_ID em falta (env ELEVENLABS_VOICE_ID ou body.voiceId)", {
        status: 400,
      });
    }
    if (!text || typeof text !== "string") {
      return new Response("Campo 'text' vazio", { status: 400 });
    }

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        voiceId
      )}/stream?optimize_streaming_latency=3&output_format=mp3_22050`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "User-Agent": "alma-frontend/1.0",
      },
      body: JSON.stringify({
        text,
        // podes trocar de modelo se quiseres
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
      cache: "no-store",
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      // Log no server para veres em Railway > Logs
      console.error("[/api/tts] ElevenLabs ERROR", {
        status: r.status,
        statusText: r.statusText,
        body: errTxt?.slice(0, 2000),
      });
      // devolvemos a mensagem real para o frontend mostrar
      return new Response(errTxt || `Upstream error ${r.status}`, { status: r.status });
    }

    const ab = await r.arrayBuffer();
    return new Response(ab, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    console.error("[/api/tts] exception", e);
    return new Response(`TTS exception: ${e?.message || e}`, { status: 500 });
  }
}
