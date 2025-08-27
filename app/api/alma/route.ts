// app/api/alma/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs"; // precisamos de streaming no Node runtime

const GROK_API_KEY = process.env.GROK_API_KEY || "";
const GROK_MODEL = process.env.GROK_MODEL || "grok-beta";
const ALMA_SYSTEM = process.env.ALMA_SYSTEM || "";

function buildMessages(question: string) {
  const msgs: any[] = [];
  if (ALMA_SYSTEM) {
    msgs.push({ role: "system", content: ALMA_SYSTEM });
  }
  msgs.push({ role: "user", content: question });
  return msgs;
}

// --- MODO SEM STREAMING: devolve { answer }
async function handleNoStream(question: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20s máx

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: buildMessages(question),
      stream: false,
    }),
    signal: ctrl.signal,
  });

  clearTimeout(timer);

  if (!r.ok) {
    const txt = await r.text();
    return new Response(txt, { status: r.status });
  }

  const j = await r.json();
  const answer =
    j?.choices?.[0]?.message?.content ??
    j?.choices?.[0]?.text ??
    "";

  return Response.json({ answer: answer || "" });
}

// --- MODO STREAMING: proxy SSE do Grok para o cliente
async function handleStream(question: string) {
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: buildMessages(question),
      stream: true,
    }),
  });

  if (!r.ok || !r.body) {
    const txt = await r.text();
    return new Response(txt, { status: r.status });
  }

  // Proxy direto do SSE (Grok é OpenAI-compatível)
  const readable = new ReadableStream({
    start(controller) {
      const reader = r.body!.getReader();
      const enc = new TextEncoder();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // passa tal e qual
            controller.enqueue(value);
          }
        } catch (e: any) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`));
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // CORS, se precisares:
      // "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    if (!GROK_API_KEY) {
      return new Response("⚠️ GROK_API_KEY não definido.", { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const wantStream =
      searchParams.get("stream") === "1" ||
      req.headers.get("accept")?.includes("text/event-stream");

    const { question } = await req.json();

    if (!question || typeof question !== "string") {
      return new Response("Missing 'question' string in body.", { status: 400 });
    }

    if (wantStream) {
      return await handleStream(question);
    }
    return await handleNoStream(question);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return new Response("Timeout ao falar com o Grok (20s).", { status: 504 });
    }
    return new Response("Erro no /api/alma: " + (e?.message || e), { status: 500 });
  }
}
