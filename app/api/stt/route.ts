// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Deepgram REST endpoint (pronto a receber ficheiros curtos)
const DG_URL = "https://api.deepgram.com/v1/listen";

export async function POST(req: NextRequest) {
  if (!DEEPGRAM_API_KEY) {
    return NextResponse.json(
      { error: "Falta DEEPGRAM_API_KEY" },
      { status: 500 }
    );
  }

  try {
    // Recebe multipart/form-data com {file, mime?, lang?}
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const clientMime =
      (form.get("mime") as string | null) ||
      (file ? file.type : null) ||
      "audio/webm";
    const lang = (form.get("lang") as string | null) || "pt-PT";

    if (!file) {
      return NextResponse.json({ error: "Sem ficheiro de áudio." }, { status: 400 });
    }

    // Rejeita áudios demasiado curtos (< 350ms) — muitas vezes vêm vazios
    // (Não há timestamp aqui, mas ficheiros sub-2KB tendem a ser vazios/silenciosos)
    if (file.size < 2000) {
      return NextResponse.json(
        { text: "", note: "very_short" },
        { status: 200 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // Query params úteis: smart_format (pontuação), language (se souberes), detect_language
    const qs = new URLSearchParams({
      smart_format: "true",
      punctuate: "true",
      // Se queres auto-detetar, comenta a linha abaixo e ativa detect_language
      language: lang,
      // detect_language: "true",
    });

    // MUITO IMPORTANTE: enviar para a Deepgram com o MESMO Content-Type do ficheiro
    const dgRes = await fetch(`${DG_URL}?${qs.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": clientMime, // "audio/webm" ou "audio/mp4" (iPad/Safari)
      },
      body: buf,
    });

    const dgText = await dgRes.text();

    if (!dgRes.ok) {
      // Devolve erro bruto da DG para conseguirmos ver a causa
      return NextResponse.json(
        { error: "Deepgram erro", detail: dgText },
        { status: 502 }
      );
    }

    let dg;
    try {
      dg = JSON.parse(dgText);
    } catch {
      return NextResponse.json(
        { error: "Deepgram resposta inválida", raw: dgText },
        { status: 502 }
      );
    }

    // Normaliza extração do transcript
    const alt =
      dg?.results?.channels?.[0]?.alternatives?.[0] ||
      dg?.results?.alternatives?.[0] ||
      null;

    const transcript: string = alt?.transcript || "";

    return NextResponse.json({ text: transcript }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Falha no STT", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
