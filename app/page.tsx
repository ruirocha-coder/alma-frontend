"use client";

import React, { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant" | "system"; content: string };

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "system", content: "🎧 Carrega em “Ativar micro”. Depois mantém “Hold para falar”." },
  ]);
  const [input, setInput] = useState("");
  const [isHolding, setIsHolding] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  // refs de gravação
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  function addMsg(m: Msg) {
    setMessages((prev) => [...prev, m]);
  }

  // 1) Pedir permissão ANTES do hold
  async function ensureMicReady() {
    if (micReady && streamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicReady(true);
      addMsg({ role: "system", content: "🎙️ Micro pronto. Mantém “Hold para falar” para gravar." });
      return true;
    } catch (e) {
      console.error("Permissão de micro negada:", e);
      addMsg({
        role: "system",
        content: "⚠️ Preciso de acesso ao micro para ouvir-te. Verifica as permissões do browser.",
      });
      return false;
    }
  }

  // 2) Iniciar/Parar gravação de forma robusta
  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;

    chunksRef.current = [];

    // Escolher um mime suportado (iOS/Safari nem sempre suporta webm/opus)
    let mime = "audio/webm;codecs=opus";
    if (!("MediaRecorder" in window) || !MediaRecorder.isTypeSupported(mime)) {
      mime = "audio/mp4"; // fallback razoável para iOS
    }

    const rec = new MediaRecorder(stream, { mimeType: mime });
    mediaRecRef.current = rec;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    rec.onstop = async () => {
      try {
        const blob = new Blob(chunksRef.current, { type: mime });
        console.log("Blob gravado:", blob.type, blob.size);
        if (blob.size === 0) {
          addMsg({
            role: "system",
            content:
              "⚠️ Não recebi áudio (o pop-up de permissão pode ter interrompido). Tenta novamente.",
          });
          return;
        }

        // enviar para STT
        const fd = new FormData();
        // ⚠️ Se o teu backend espera "file" em vez de "audio", muda aqui:
        fd.append("audio", blob, mime.includes("webm") ? "audio.webm" : "audio.mp4");

        const sttRes = await fetch("/api/stt", { method: "POST", body: fd });
        const sttJson = await sttRes.json().catch(() => ({} as any));

        if (!sttRes.ok || !sttJson?.transcript) {
          console.error("Falha STT:", sttJson);
          addMsg({ role: "system", content: "⚠️ Falha na transcrição" });
          return;
        }

        const transcript: string = String(sttJson.transcript);
        addMsg({ role: "user", content: transcript });

        // perguntar à Alma
        const almaRes = await fetch("/api/alma", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: transcript }),
        });
        const almaJson = await almaRes.json().catch(() => ({} as any));
        const answer = almaJson?.answer || "Desculpa, não consegui responder agora.";
        addMsg({ role: "assistant", content: answer });

        // TTS da resposta
        await speak(answer);
      } catch (err) {
        console.error("Erro no fluxo de áudio:", err);
        addMsg({ role: "system", content: "⚠️ Erro ao processar o áudio." });
      }
    };

    rec.start(100); // recolha de chunks periódica
  }

  function stopRecording() {
    const rec = mediaRecRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    }
  }

  // 3) Handlers do HOLD robustos (iOS perde pointerup no pop-up de permissão)
  async function onHoldDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();

    // se ainda sem permissão, pede já. NÃO grava neste “hold”.
    if (!micReady) {
      const ok = await ensureMicReady();
      if (!ok) return;
      // informa UI: pronto a ouvir no próximo hold
      return;
    }

    setIsHolding(true);
    startRecording();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  }

  function onHoldUp(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (!isHolding) return;
    setIsHolding(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    stopRecording();
  }

  function onHoldCancel() {
    if (!isHolding) return;
    setIsHolding(false);
    stopRecording();
  }

  // Texto → Alma → TTS
  async function sendText() {
    const q = input.trim();
    if (!q) return;
    setInput("");
    addMsg({ role: "user", content: q });
    setIsBusy(true);
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const j = await r.json().catch(() => ({}));
      const answer = j?.answer || "Desculpa, não consegui responder agora.";
      addMsg({ role: "assistant", content: answer });

      await speak(answer);
    } catch (e) {
      console.error(e);
      addMsg({ role: "system", content: "⚠️ Erro a contactar a Alma." });
    } finally {
      setIsBusy(false);
    }
  }

  // TTS helper
  async function speak(text: string) {
    try {
      const tts = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!tts.ok) {
        const errTxt = await tts.text();
        console.warn("TTS falhou:", errTxt);
        return;
      }
      const abuf = await tts.arrayBuffer();
      const audioBlob = new Blob([abuf], { type: "audio/mpeg" });
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audio.play().catch((e) => console.error("Falha a tocar TTS:", e));
    } catch (e) {
      console.error("Erro no TTS:", e);
    }
  }

  // auto-scroll do histórico
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col items-center p-4">
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <h1 className="text-xl font-semibold">🎭 Alma — Voz & Texto</h1>

        {/* Controlo do micro */}
        <div className="flex gap-2 items-center">
          <button
            onClick={ensureMicReady}
            className={`px-3 py-2 rounded ${
              micReady ? "bg-emerald-600" : "bg-zinc-700"
            }`}
            disabled={micReady}
            aria-pressed={micReady}
          >
            {micReady ? "🎤 Micro pronto" : "Ativar micro"}
          </button>

          <button
            onPointerDown={onHoldDown}
            onPointerUp={onHoldUp}
            onPointerCancel={onHoldCancel}
            onBlur={onHoldCancel}
            disabled={!micReady}
            className={`px-4 py-2 rounded ${
              isHolding ? "bg-red-600" : micReady ? "bg-blue-600" : "bg-gray-600"
            }`}
          >
            {isHolding ? "A gravar…" : "Hold para falar"}
          </button>
        </div>

        {/* Histórico */}
        <div className="bg-zinc-900 rounded-lg p-3 max-h-[48vh] overflow-auto space-y-2 border border-zinc-800">
          {messages.map((m, i) => (
            <div key={i} className="text-sm whitespace-pre-wrap">
              <span
                className={
                  m.role === "user"
                    ? "text-sky-400"
                    : m.role === "assistant"
                    ? "text-emerald-400"
                    : "text-amber-400"
                }
              >
                {m.role === "user" ? "Tu" : m.role === "assistant" ? "Alma" : "Info"}
              </span>
              <span className="text-zinc-400">: </span>
              <span className="text-zinc-100">{m.content}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input de texto */}
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendText();
              }
            }}
            placeholder="Escreve aqui e carrega Enter…"
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 outline-none"
          />
          <button
            onClick={sendText}
            disabled={isBusy || !input.trim()}
            className={`px-4 py-2 rounded ${
              isBusy ? "bg-zinc-700" : "bg-emerald-600"
            }`}
          >
            Enviar
          </button>
        </div>

        <p className="text-xs text-zinc-500">
          Dica: no iOS/Safari, permite o micro primeiro. Depois mantém “Hold para falar”.
        </p>
      </div>
    </main>
  );
}
