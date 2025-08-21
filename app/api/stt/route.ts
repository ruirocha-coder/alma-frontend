import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
    if (!DEEPGRAM_API_KEY) {
      return NextResponse.json(
        { transcript: "", error: "Falta DEEPGRAM_API_KEY" },
        { status: 500 }
      );
    }

    // 1) Recebe o FormData do browser (audio + mime)
    const form = await req.formData();
    const file = form.get("audio") as File | null;
    const mimeFromForm = (form.get("mime") as string) || "";

    if (!file) {
      return NextResponse.json(
        { transcript: "", error: "Sem ficheiro 'audio' no form-data" },
        { status: 400 }
      );
    }

    // 2) Extrai bytes e MIME
    const mime =
      mimeFromForm ||
      (file.type && typeof file.type === "string" ? file.type : "") ||
      "audio/webm";

    const buf = Buffer.from(await file.arrayBuffer());

    if (!buf.length) {
      return NextResponse.json(
        { transcript: "", error: "Áudio vazio" },
        { status: 400 }
      );
    }

    // 3) Envia BINÁRIO CRU para a Deepgram
    //    Ajusta a língua se precisares (pt, pt-BR, etc.)
    const url =
      "https://api.deepgram.com/v1/listen?smart_format=true&language=pt";
    const dg = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": mime, // ex: audio/webm;codecs=opus OU audio/mp4
      },
      body: buf,
    });

    const text = await dg.text();

    if (!dg.ok) {
      return NextResponse.json(
        { transcript: "", error: `Deepgram ${dg.status}: ${text}` },
        { status: dg.status }
      );
    }

    const json = JSON.parse(text);
    const transcript =
      json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return NextResponse.json({ text: transcript });
  } catch (e: any) {
    return NextResponse.json(
      { transcript: "", error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
