// app/api/stt/route.ts
import { NextResponse } from "next/server";

const DG_ENDPOINT = "https://api.deepgram.com/v1/listen";

/**
 * Notas:
 * - Aceita tanto "audio" como "file" no FormData (para compat. com vários clients)
 * - Suporta webm/opus, m4a/aac, wav (Deepgram aceita todos)
 * - Usa modelo 'nova-2' e idioma pt (podes mudar via DEEPGRAM_LANGUAGE)
 */
export async function POST(req: Request) {
  try {
    const DEBUG = process.env.STT_DEBUG === "1";
    const DG_KEY = process.env.DEEPGRAM_API_KEY;
    if (!DG_KEY) {
      return NextResponse.json(
        { transcript: "", error: "DEEPGRAM_API_KEY em falta" },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const file = (form.get("audio") || form.get("file")) as File | null;

    if (!file) {
      return NextResponse.json(
        { transcript: "", error: "Nenhum ficheiro recebido" },
        { status: 400 }
      );
    }

    // Limite defensivo de tamanho (ex.: 25MB)
    if (file.size > 25 * 1024 * 1024) {
      return NextResponse.json(
        { transcript: "", error: "Ficheiro demasiado grande (>25MB)" },
        { status: 413 }
      );
    }

    const lang = (process.env.DEEPGRAM_LANGUAGE || "pt").trim();
    const contentType =
      file.type ||
      // fallback por extensão do nome
      (file.name.endsWith(".m4a")
        ? "audio/mp4"
        : file.name.endsWith(".wav")
        ? "audio/wav"
        : "audio/webm");

    // Log útil para diagnosticar codecs/containers
    if (DEBUG) {
      console.log(
        "[/api/stt] name=%s type=%s size=%d",
        file.name,
        contentType,
        file.size
      );
    }

    // Buffer binário do áudio
    const bodyBuf = Buffer.from(await file.arrayBuffer());

    // Query params recomendados p/ Deepgram (pre-gravado)
    // - model=nova-2 (preciso & rápido)
    // - smart_format & punctuate para melhorar legibilidade
    const url = new URL(DG_ENDPOINT);
    url.searchParams.set("model", "nova-2");
    url.searchParams.set("language", lang); // ex.: "pt" (Deepgram usa "pt" p/ PT-BR/PT-PT auto)
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");

    // Timeout defensivo (10s). AbortController é suportado no runtime do Next.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);

    const r = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Token ${DG_KEY}`,
        "Content-Type": contentType,
      },
      body: bodyBuf,
      signal: controller.signal,
    }).finally(() => clearTimeout(t));

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      if (DEBUG) {
        console.error("[/api/stt] Deepgram error %d: %s", r.status, JSON.stringify(j));
      }
      return NextResponse.json(
        {
          transcript: "",
          error: `Deepgram ${r.status}: ${JSON.stringify(j)}`,
        },
        { status: 400 }
      );
    }

    // Extrai a melhor alternativa
    const transcript =
      j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    if (!transcript) {
      return NextResponse.json(
        { transcript: "", error: "Sem texto reconhecido" },
        { status: 200 }
      );
    }

    if (DEBUG) {
      console.log("[/api/stt] OK transcript:", transcript);
    }

    return NextResponse.json({ transcript }, { status: 200 });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "Timeout na requisição ao Deepgram" : e?.message || String(e);
    console.error("[/api/stt] Exception:", msg);
    return NextResponse.json({ transcript: "", error: msg }, { status: 500 });
  }
}

// (Opcional) Permitir preflight CORS se vais chamar este endpoint de outro domínio/app
export function OPTIONS() {
  return NextResponse.json(
    {},
    {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }
  );
}
