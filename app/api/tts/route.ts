// app/api/tts/route.ts
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text, voiceId, model } = (await req.json()) as {
      text?: string;
      voiceId?: string;
      model?: string;
    };

    const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
    const ELEVEN_VOICE_ID =
      voiceId || process.env.ELEVENLABS_VOICE_ID || ""; // define nas Variáveis do Railway
    const ELEVEN_MODEL =
      model ||
      process.env.ELEVENLABS_MODEL || // opcional; se não existir, usamos um seguro
      "eleven_turbo_v2_5"; // bom para PT; alternativa: "eleven_multilingual_v2"

    if (!ELEVEN_API_KEY) {
      return new Response("Missing ELEVENLABS_API_KEY", { status: 500 });
    }
    if (!ELEVEN_VOICE_ID) {
      return new Response("Missing ELEVENLABS_VOICE_ID", { status: 500 });
    }
    const prompt = (text || "").trim();
    if (!prompt) {
      return new Response("Missing text", { status: 400 });
    }

    // Proteção simples contra textos gigantes
    const truncated =
      prompt.length > 1200 ? prompt.slice(0, 1200) + "…" : prompt;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      ELEVEN_VOICE_ID
    )}`;

    const body = {
      text: truncated,
      model_id: ELEVEN_MODEL,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true,
      },
      // Se usares o plano novo, podes omitir "optimize_streaming_latency"
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      return new Response(
        `TTS error: ${r.status} ${errTxt || r.statusText}`,
        { status: 502 }
      );
    }

    const ab = await r.arrayBuffer();

    return new Response(ab, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    return new Response(
      `TTS error: ${(err?.message as string) || String(err)}`,
      { status: 502 }
    );
  }
}
