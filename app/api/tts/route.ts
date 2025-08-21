// app/api/tts/route.ts
import { NextRequest } from "next/server";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID!;
// Opcional: força um modelo; bom para PT:
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

// latência baixa para streaming; 4 é equilibrado
const STREAM_LATENCY = 4;

export async function POST(req: NextRequest) {
  try {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return new Response("ELEVENLABS_API_KEY/VOICE_ID em falta", {
        status: 500,
      });
    }

    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return new Response("Campo 'text' inválido", { status: 400 });
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=${STREAM_LATENCY}`;

    const elRes = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        // afinações suaves e naturais; ajusta ao teu gosto:
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.6,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    });

    if (!elRes.ok) {
      const errTxt = await elRes.text();
      return new Response(`TTS error: ${elRes.status} ${errTxt}`, {
        status: 502,
      });
    }

    // devolve áudio diretamente ao browser
    const audioBuf = Buffer.from(await elRes.arrayBuffer());
    return new Response(audioBuf, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    return new Response(`Erro no /api/tts: ${err?.message || String(err)}`, {
      status: 500,
    });
  }
}
