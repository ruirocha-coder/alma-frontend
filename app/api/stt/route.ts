import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "Nenhum ficheiro recebido" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const res = await fetch("https://api.deepgram.com/v1/listen", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/wav", // 👈 WAV agora
      },
      body: buffer,
    });

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json(
        { transcript: "", error: `Deepgram ${res.status}: ${errorText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const transcript =
      data.results?.channels[0]?.alternatives[0]?.transcript || "";

    return NextResponse.json({ transcript });
  } catch (err: any) {
    return NextResponse.json(
      { transcript: "", error: err.message },
      { status: 500 }
    );
  }
}
