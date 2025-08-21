// app/api/stt/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs"; // força Node (não Edge), mais seguro para multipart

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof Blob)) {
      return new Response(JSON.stringify({ transcript: "", error: "Nenhum ficheiro recebido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ transcript: "", error: "DEEPGRAM_API_KEY não definida" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // O MediaRecorder do browser está a enviar audio/webm;codecs=opus
    const arrayBuffer = await file.arrayBuffer();

    const dg = await fetch("https://api.deepgram.com/v1/listen?model=nova-2-general&language=pt", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/webm", // importante para evitar 400 "unsupported data"
      },
      body: Buffer.from(arrayBuffer),
    });

    if (!dg.ok) {
      const errTxt = await dg.text();
      return new Response(
        JSON.stringify({
          transcript: "",
          error: `Deepgram ${dg.status}: ${errTxt}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await dg.json();
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim?.() || "";

    return new Response(JSON.stringify({ transcript, error: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ transcript: "", error: e?.message || String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
