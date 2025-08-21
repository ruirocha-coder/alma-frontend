// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const data = await req.formData();
    const file = data.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const r = await fetch("https://api.deepgram.com/v1/listen", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/wav", // vamos usar WAV por simplicidade
      },
      body: buffer,
    });

    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json({ error: "Deepgram error: " + txt }, { status: 502 });
    }

    const j = await r.json();
    return NextResponse.json({ text: j.results.channels[0].alternatives[0].transcript });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || e }, { status: 500 });
  }
}
