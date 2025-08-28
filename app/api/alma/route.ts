// app/api/alma/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // dá folga no edge/serverless

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();

    const ALMA_URL =
      process.env.NEXT_PUBLIC_ALMA_SERVER_URL || process.env.ALMA_SERVER_URL;

    if (!ALMA_URL) {
      return NextResponse.json(
        { answer: "⚠️ ALMA_SERVER_URL não definida" },
        { status: 500 },
      );
    }

    // Timeout “antes” do corte da plataforma (Railway ~30s)
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 28_000);

    let r: Response;
    try {
      r = await fetch(ALMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err: any) {
      // Quando o fetch é abortado ou o socket cai, o browser teria "Failed to fetch".
      // Aqui devolvemos 504 com mensagem clara para o cliente mostrar.
      clearTimeout(to);
      return NextResponse.json(
        { answer: "⚠️ Timeout ao contactar o Alma Server (28s). Tenta novamente." },
        { status: 504 },
      );
    } finally {
      clearTimeout(to);
    }

    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json(
        { answer: `Erro no Alma Server: ${txt.slice(0, 500)}` },
        { status: r.status },
      );
    }

    const j = await r.json();
    return NextResponse.json({ answer: j?.answer ?? "" });
  } catch (e: any) {
    return NextResponse.json(
      { answer: "Erro a contactar o Alma Server: " + (e?.message || e) },
      { status: 500 },
    );
  }
}
