// app/api/alma/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question: string = (body?.question || "").trim();
    const context: string = (body?.context || "").trim();

    const ALMA_URL =
      process.env.NEXT_PUBLIC_ALMA_SERVER_URL || process.env.ALMA_SERVER_URL;

    if (!ALMA_URL) {
      return NextResponse.json(
        { answer: "⚠️ ALMA_SERVER_URL não definida" },
        { status: 500 }
      );
    }

    // Injeta contexto de forma segura (sem quebrar o server atual)
    const qWithCtx = context
      ? `Contexto (últimas mensagens):\n${context}\n\nPergunta: ${question}`
      : question;

    const r = await fetch(ALMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // o teu alma-server espera {question}
      body: JSON.stringify({ question: qWithCtx }),
      // não deixamos pendurado: 15s máx
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
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
