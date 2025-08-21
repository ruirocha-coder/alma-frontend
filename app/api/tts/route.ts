// app/api/tts/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { text } = await req.json();

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    // Opcional: escolhe o que quiseres no .env (estes funcionam bem)
    const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";

    if (!apiKey || !voiceId) {
      return NextResponse.json(
        { error: "Falta ELEVENLABS_API_KEY ou ELEVENLABS_VOICE_ID" },
        { status: 500 }
      );
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=4&output_format=mp3_44100_128`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        // Ajusta se quiseres: deixa simples
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      return new NextResponse(`TTS error: ${r.status} ${errTxt}`, {
        status: 502,
      });
    }

    // Passa o áudio tal como vem (streaming)
    const body = r.body!;
    return new Response(body as any, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return new NextResponse(`TTS exception: ${e?.message || e}`, {
      status: 500,
    });
  }
}
