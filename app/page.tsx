"use client";

import React, { useEffect, useRef, useState } from "react";

// -- Tipos simples de mensagens
type Msg = { role: "user" | "alma"; text: string };

// --------- UTIL: tocar TTS da resposta ---------
async function playTTS(text: string) {
  const t = (text || "").trim();
  if (!t) return;

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: t }),
  });

  if (!r.ok) {
    // Não quebrar o fluxo se TTS falhar — só loga
    console.error("TTS falhou:", await r.text());
    return;
  }

  const blob = await r.blob(); // esperamos audio/mpeg
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  try {
    await audio.play();
  } catch (e) {
    // iOS/Chrome podem bloquear 1ª reprodução sem gesto
    console.warn("Autoplay bloqueado; o áudio tocará após um clique.", e);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// -------------- Página ----------------
export default function Page() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isHolding, setIsHolding] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // scroll simples p/ o fim quando novas msgs chegam
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  // --------- Enviar texto para a Alma ---------
  async function sendText(question: string) {
    const q = question.trim();
    if (!q) return;

    setIsSending(true);
    setMsgs((m) => [...m, { role: "user", text: q }]);

    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      const j = await r.json();
      const answer = (j?.answer ?? "").toString();

      setMsgs((m) => [...m, { role: "alma", text: answer }]);

      // 🚀 NOVO: dar VOZ à resposta da Alma
      await playTTS(answer);
    } catch (e: any) {
      const msg = "⚠️ Erro a contactar a Alma.";
      setMsgs((m) => [...m, { role: "alma", text: msg }]);
      console.error(msg, e);
    } finally {
      setIsSending(false);
    }
  }

  // --------- Gravação (HOLD) → STT → /api/alma ---------
  async function startHold() {
    // gesto do utilizador: pedido de micro
    setIsHolding(true);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      const mime =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

      const rec = new MediaRecorder(stream, { mimeType: mime });
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.start(100); // pequenos chunks
    } catch (err) {
      console.error("Permissão de micro negada ou indisponível:", err);
      setIsHolding(false);
    }
  }

  async function stopHold() {
    setIsHolding(false);

    const rec = mediaRecorderRef.current;
    if (!rec) return;

    // parar e esperar pelos últimos chunks
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });

    // largar tracks do micro
    try {
      (rec.stream.getTracks() || []).forEach((t) => t.stop());
    } catch {}

    const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
    chunksRef.current = [];

    // mandar p/ STT (exactamente como já tinhas)
    try {
      const fd = new FormData();
      fd.append("audio", blob, "speech.webm");

      // se o teu /api/stt aceita lang, podes enviar:
      // fd.append("lang", "pt-PT");

      const sttRes = await fetch("/api/stt", {
        method: "POST",
        body: fd,
      });

      const sttJson = await sttRes.json();
      const transcript = (sttJson?.transcript || "").toString().trim();

      if (!transcript) {
        setMsgs((m) => [
          ...m,
          { role: "alma", text: "⚠️ Falha na transcrição" },
        ]);
        return;
      }

      // mostrar o que o user disse
      setMsgs((m) => [...m, { role: "user", text: transcript }]);

      // perguntar à Alma
      await sendText(transcript);
    } catch (err) {
      setMsgs((m) => [
        ...m,
        { role: "alma", text: "⚠️ Não consegui transcrever. Tenta outra vez." },
      ]);
      console.error("Erro no STT:", err);
    }
  }

  // ---------- UI mínima (input + hold + lista de msgs) ----------
  return (
    <div className="min-h-dvh w-full max-w-2xl mx-auto p-4 flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Alma — voz & texto</h1>

      <div className="flex-1 overflow-y-auto rounded border p-3 bg-white/5">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={`mb-2 ${
              m.role === "user" ? "text-blue-300" : "text-emerald-300"
            }`}
          >
            <strong>{m.role === "user" ? "Tu" : "Alma"}:</strong> {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (isSending) return;
          const v = input;
          setInput("");
          await sendText(v);
        }}
      >
        <input
          type="text"
          className="flex-1 rounded border px-3 py-2 text-black"
          placeholder="Escreve para a Alma…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="submit"
          disabled={isSending}
          className="rounded bg-emerald-600 text-white px-4 py-2 disabled:opacity-50"
        >
          {isSending ? "…" : "Enviar"}
        </button>
      </form>

      <div className="flex items-center gap-3">
        <button
          onMouseDown={startHold}
          onMouseUp={stopHold}
          onMouseLeave={() => isHolding && stopHold()}
          onTouchStart={startHold}
          onTouchEnd={stopHold}
          className={`rounded px-4 py-2 text-white ${
            isHolding ? "bg-red-600" : "bg-blue-600"
          }`}
        >
          {isHolding ? "A gravar… (largar p/ enviar)" : "Manter premido p/ falar"}
        </button>
        <span className="text-sm opacity-70">
          Dica: mantém premido, fala, e larga para enviar.
        </span>
      </div>
    </div>
  );
}
