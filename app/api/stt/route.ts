// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Deepgram: modelo e opções afinadas para PT
const DG_ENDPOINT =
  "https://api.deepgram.com/v1/listen?model=nova-2-general&language=pt-PT&smart_format=true&punctuate=true&diarize=false";

export async function POST(req: NextRequest) {
  try {
    if (!DEEPGRAM_API_KEY) {
      return NextResponse.json(
        { transcript: "", error: "DEEPGRAM_API_KEY em falta" },
        { status: 500 }
      );
    }

    // Recebe o áudio bruto do browser (MediaRecorder -> webm/opus)
    const audioBuf = Buffer.from(await req.arrayBuffer());

    const dgRes = await fetch(DG_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        // tenta primeiro webm/opus; Deepgram detecta bem
        "Content-Type": "audio/webm",
        "Accept": "application/json",
      },
      body: audioBuf,
    });

    if (!dgRes.ok) {
      const txt = await dgRes.text();
      return NextResponse.json(
        { transcript: "", error: `Deepgram ${dgRes.status}: ${txt}` },
        { status: 502 }
      );
    }

    const json = await dgRes.json();
    // caminho típico do transcript
    const transcript =
      json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return NextResponse.json({ transcript });
  } catch (err: any) {
    return NextResponse.json(
      { transcript: "", error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
