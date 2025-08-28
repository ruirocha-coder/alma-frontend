// app/api/alma/route.ts
import { NextRequest, NextResponse } from "next/server";

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 35000, ...rest } = init;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

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

    // 1 tentativa (podes pôr 2 se quiseres)
    const r = await fetchWithTimeout(ALMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      timeoutMs: 35000,
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
    const aborted =
      e?.name === "AbortError" || /aborted/i.test(String(e?.message || e));
    if (aborted) {
      return NextResponse.json(
        { answer: "⚠️ Timeout ao contactar a Alma (request abortado). Tenta de novo." },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { answer: "Erro a contactar o Alma Server: " + (e?.message || e) },
      { status: 500 }
    );
  }
}
