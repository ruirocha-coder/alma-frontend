// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
    if (!DEEPGRAM_API_KEY) {
      return NextResponse.json(
        { transcript: "", error: "Falta DEEPGRAM_API_KEY" },
        { status: 500 }
      );
    }

    // Usa o Content-Type que veio do browser (mantém o container correto)
    const contentType = req.headers.get("content-type") || "audio/webm";

    // Encaminha o corpo bruto diretamente para o Deepgram
    const dg = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true&language=pt",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": contentType,
        },
        body: req.body, // stream direto
        // Importante: não toques no corpo — deixa o stream passar
      }
    );

    if (!dg.ok) {
      const txt = await dg.text();
      return NextResponse.json(
        {
          transcript: "",
          error: `Deepgram ${dg.status}: ${txt}`,
        },
        { status: dg.status }
      );
    }

    const json = await dg.json();
    // Forma típica do payload da nova-2:
    const transcript =
      json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return NextResponse.json({ transcript }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { transcript: "", error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
