// app/api/alma/route.ts


// app/api/alma/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();
    const ALMA_URL =
      process.env.NEXT_PUBLIC_ALMA_SERVER_URL || process.env.ALMA_SERVER_URL;

    if (!ALMA_URL) {
      return NextResponse.json(
        { answer: "⚠️ ALMA_SERVER_URL não definida" },
        { status: 500 }
      );
    }

    const r = await fetch(ALMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json(
        { answer: `Erro no Alma Server: ${txt.slice(0, 500)}` },
        { status: r.status }
      );
    }

    const j = await r.json();
    return NextResponse.json({ answer: j?.answer ?? "" });
  } catch (e: any) {
    return NextResponse.json(
      { answer: "Erro a contactar o Alma Server: " + (e?.message || e) },
      { status: 500 }
    );
  }
}
