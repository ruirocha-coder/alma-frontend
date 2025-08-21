"use client";

import { useRef, useState } from "react";

/** ======================
 *  Helpers (STT)
 *  ====================== */
function pickBestMime(): string {
  if (typeof window === "undefined") return "audio/webm";
  if (window.MediaRecorder?.isTypeSupported?.("audio/webm;codecs=opus"))
    return "audio/webm;codecs=opus";
  if (window.MediaRecorder?.isTypeSupported?.("audio/webm"))
    return "audio/webm";
  // Safari / iPad
  if (window.MediaRecorder?.isTypeSupported?.("audio/mp4")) return "audio/mp4";
  return "audio/webm";
}

async function recordAndTranscribe(lang = "pt-PT"): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickBestMime();
  const rec = new MediaRecorder(stream, { mimeType: mime });

  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  // grava ~2.5s — ajusta se quiseres frases mais longas
  const DURATION_MS = 2500;

  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.start();
    setTimeout(() => rec.stop(), DURATION_MS);
  });

  // fecha micro
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mime });
  const form = new FormData();
  form.append("file", blob, mime.startsWith("audio/mp4") ? "clip.m4a" : "clip.webm");
  form.append("mime", blob.type);
  form.append("lang", lang);

  const r = await fetch("/api/stt", { method: "POST", body: form });
  const j = await r.json();

  if (!r.ok) {
    throw new Error(j?.detail || j?.error || "STT falhou");
  }
  return j.text || "";
}

/** ======================
 *  Helpers (TTS)
 *  ====================== */
async function speakText(text: string, audioEl: HTMLAudioElement) {
  // Este /api/tts deve aceitar { text } e devolver áudio
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  // Aceita dois formatos:
  // 1) binary audio (audio/mpeg, audio/wav, etc)
  // 2) JSON { url: "https://..." }
  const ctype = r.headers.get("Content-Type") || "";

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`TTS error: ${r.status} ${err}`);
  }

  if (ctype.includes("application/json")) {
    const j = await r.json();
    if (!j?.url) throw new Error("TTS: resposta sem URL");
    audioEl.src = j.url;
  } else {
    const blob = await r.blob();
    audioEl.src = URL.createObjectURL(blob);
  }

  await audioEl.play().catch(() => {
    // Em alguns browsers pode exigir interação; o botão já conta como interação.
  });
}

/** ======================
 *  Página
 *  ====================== */
export default function Page() {
  const [you, setYou] = useState<string>("");            // texto dito por ti (via STT ou input)
  const [alma, setAlma] = useState<string>("");          // resposta da Alma
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string>("");

  const [typing, setTyping] = useState<string>("");      // input manual opcional
  const audioRef = useRef<HTMLAudioElement>(null);

  async function askAlma(question: string) {
    const r = await fetch("/api/alma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    const j = await r.json();
    if (!r.ok) {
      throw new Error(j?.answer || "Erro no /api/alma");
    }
    return j.answer || "";
  }

  async function handleVoiceFlow() {
    setErr("");
    setLoading(true);
    setAlma("");

    try {
      // 1) STT
      const said = await recordAndTranscribe("pt-PT");
      setYou(said || "(sem texto)");

      if (!said) {
        setLoading(false);
        return;
      }

      // 2) Alma (Grok via teu server)
      const response = await askAlma(said);
      setAlma(response || "");

      // 3) TTS
      if (response && audioRef.current) {
        await speakText(response, audioRef.current);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleTextFlow() {
    setErr("");
    setLoading(true);
    setAlma("");
    setYou(typing);

    try {
      if (!typing.trim()) {
        setLoading(false);
        return;
      }
      const response = await askAlma(typing.trim());
      setAlma(response || "");

      if (response && audioRef.current) {
        await speakText(response, audioRef.current);
      }
      setTyping("");
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100 p-4 flex items-center justify-center">
      <div className="w-full max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">🎤 Alma – voz & chat (STT → Alma → TTS)</h1>

        <div className="flex gap-3">
          <button
            onClick={handleVoiceFlow}
            disabled={loading}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2"
          >
            {loading ? "A processar..." : "Falar"}
          </button>

          <input
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            placeholder="ou escreve aqui e carrega em Enviar…"
            className="flex-1 rounded-md bg-zinc-800 px-3 py-2 outline-none"
          />
          <button
            onClick={handleTextFlow}
            disabled={loading}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2"
          >
            Enviar
          </button>
        </div>

        <div className="rounded-lg bg-zinc-900 p-4 space-y-3">
          <div>
            <div className="text-sm text-zinc-400">Tu disseste</div>
            <div className="mt-1 whitespace-pre-wrap">{you || "—"}</div>
          </div>

          <div className="border-t border-zinc-800 my-2" />

          <div>
            <div className="text-sm text-zinc-400">Alma</div>
            <div className="mt-1 whitespace-pre-wrap">{alma || "—"}</div>
          </div>

          <audio ref={audioRef} hidden />
        </div>

        {!!err && (
          <div className="rounded-md bg-red-600/15 text-red-300 p-3">
            Alma: {err}
          </div>
        )}

        <p className="text-xs text-zinc-500">
          Dica: se o iPad/Safari não transcrever, fala ~3s com o micro perto.
        </p>
      </div>
    </main>
  );
}
