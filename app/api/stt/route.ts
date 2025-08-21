// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

// Garante que corre no runtime Node (evita Edge lidar com streams)
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const DG = process.env.DEEPGRAM_API_KEY;
    if (!DG) {
      return NextResponse.json(
        { transcript: "", error: "Missing DEEPGRAM_API_KEY" },
        { status: 500 }
      );
    }

    // Tipo do áudio que veio do browser (ex.: audio/webm;codecs=opus)
    const contentType = req.headers.get("content-type") || "audio/webm";

    // Lê TUDO para memória e converte para Buffer (=> nada de duplex)
    const ab = await req.arrayBuffer();
    const audio = Buffer.from(ab);

    // Ajusta os parâmetros do modelo à tua preferência/idioma
    const url =
      "https://api.deepgram.com/v1/listen" +
      "?model=nova-2-general" +
      "&smart_format=true" +
      "&detect_language=false" +
      "&language=pt"; // pt-PT/pt-BR: Deepgram aceita "pt"

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DG}`,
        "Content-Type": contentType,
        Accept: "application/json",
        "User-Agent": "alma-frontend/1.0",
      },
      body: audio, // <- Buffer, sem streams, sem duplex
    });

    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json(
        { transcript: "", error: `Deepgram ${r.status}: ${txt}` },
        { status: 400 }
      );
    }

    const j = await r.json();
    const transcript =
      j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return NextResponse.json({ transcript });
  } catch (e: any) {
    return NextResponse.json(
      { transcript: "", error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
