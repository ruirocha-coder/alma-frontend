// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ transcript: "", error: "Nenhum ficheiro recebido" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const audioBytes = Buffer.from(arrayBuffer);

    // 👇 Força PT e desliga autodeteção de idioma
    const url =
      "https://api.deepgram.com/v1/listen" +
      "?model=nova-2" +                 // modelo atual topo
      "&language=pt" +                  // força português (usa "pt-PT" se preferires)
      "&smart_format=true" +            // vírgulas, maiúsculas, etc.
      "&punctuate=true" +
      "&diarize=false" +                // sem diarização (menos latência)
      "&detect_language=false";         // NÃO autodetectar, evita cair para EN

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY!}`,
        // Mantém coerente com o que o browser grava (webm/opus no Chrome/Brave)
        "Content-Type": "audio/webm",
      },
      body: audioBytes,
    });

    const text = await r.text();
    if (!r.ok) {
      return NextResponse.json(
        { transcript: "", error: `Deepgram ${r.status}: ${text}` },
        { status: r.status }
      );
    }

    const j = JSON.parse(text);
    const transcript =
      j.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";

    return NextResponse.json({ transcript });
  } catch (err: any) {
    return NextResponse.json(
      { transcript: "", error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
