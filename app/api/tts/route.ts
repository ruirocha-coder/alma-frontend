// app/api/tts/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // <- usa a tua
  const MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_turbo_v2_5"; // seguro p/ planos pagos

  if (!KEY) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY em falta" }, { status: 500 });
  }
  if (!VOICE_ID) {
    return NextResponse.json({ error: "ELEVENLABS_VOICE_ID em falta" }, { status: 500 });
  }

  let text = "";
  try {
    const body = await req.json();
    text = (body?.text || "").toString();
  } catch {}
  if (!text) {
    return NextResponse.json({ error: "Campo 'text' vazio" }, { status: 400 });
  }

  try {
    // endpoint padrão (não-streaming) a devolver MP3
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": KEY,
        "Content-Type": "application/json",
        // Aceitar áudio garante que a ElevenLabs responde com binário se tudo ok
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL, // mantém explícito
        // podes pôr "voice_settings" aqui se precisares (stability, similarity, etc.)
      }),
      // evitar quaisquer caches intermédios
      cache: "no-store",
    });

    if (!upstream.ok) {
      const msg = await upstream.text().catch(() => "");
      // devolvemos a mensagem original da ElevenLabs para debugging
      return NextResponse.json(
        { error: `TTS ${upstream.status}`, details: safeSlice(msg, 2000) },
        { status: upstream.status }
      );
    }

    // Pass-through do binário (mp3)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Falha no TTS", details: e?.message || String(e) },
      { status: 502 }
    );
  }
}

function safeSlice(s: string, n: number) {
  try {
    return (s || "").slice(0, n);
  } catch {
    return "";
  }
}
