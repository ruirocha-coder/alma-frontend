// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge"; // mais rápido no Railway

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ transcript: "", error: "Nenhum ficheiro recebido" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const audioBytes = Buffer.from(arrayBuffer);

    const r = await fetch("https://api.deepgram.com/v1/listen", {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/webm", // 👈 importante: o browser envia webm
      },
      body: audioBytes,
    });

    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json({ transcript: "", error: "Deepgram " + r.status + ": " + txt }, { status: r.status });
    }

    const j = await r.json();
    const transcript = j.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return NextResponse.json({ transcript });
  } catch (err: any) {
    return NextResponse.json({ transcript: "", error: err.message || err }, { status: 500 });
  }
}
