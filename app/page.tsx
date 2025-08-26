"use client";

import React, { useEffect, useRef, useState } from "react";

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");

  // --- refs
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria o <audio> de TTS
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;
  }, []);

  async function requestMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto ✅");
    } catch {
      setStatus("⚠️ Permissão do micro negada");
    }
  }

  // --- STREAMING STT
  function startStreaming() {
    if (!isArmed) return requestMic();

    const url = process.env.NEXT_PUBLIC_STT_WS_URL;
    if (!url) {
      setStatus("⚠️ STT_WS_URL não definido");
      return;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("🎙️ Streaming ativo");
      setIsStreaming(true);

      const mr = new MediaRecorder(streamRef.current!, {
        mimeType: "audio/webm;codecs=opus",
      });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      mr.start(250); // envia chunks a cada 250ms
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.transcript) {
        setTranscript(msg.transcript);
      }
      if (msg.is_final && msg.transcript) {
        await askAlma(msg.transcript);
      }
    };

    ws.onclose = () => {
      setIsStreaming(false);
      setStatus("🛑 Streaming terminado");
    };
  }

  function stopStreaming() {
    mediaRecorderRef.current?.stop();
    wsRef.current?.close();
    setIsStreaming(false);
    setStatus("Pronto");
  }

  // --- Perguntar à Alma + TTS
  async function askAlma(q: string) {
    setStatus("🧠 A perguntar à Alma…");
    setTranscript(q);

    const r = await fetch("/api/alma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });

    if (!r.ok) {
      setStatus("⚠️ Erro no Alma");
      return;
    }
    const j = await r.json();
    const out = j.answer || "";
    setAnswer(out);
    setStatus("🔊 A falar…");
    await speak(out);
    setStatus("Pronto");
  }

  async function speak(text: string) {
    if (!text) return;
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;

    const ab = await r.arrayBuffer();
    const blob = new Blob([ab], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = ttsAudioRef.current!;
    audio.src = url;
    try {
      await audio.play();
    } catch {
      setStatus("⚠️ O navegador bloqueou o áudio");
    }
  }

  // --- Texto escrito
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>🎭 Alma — Streaming</h1>
      <p>{status}</p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button onClick={requestMic}>
          {isArmed ? "Micro pronto ✅" : "Ativar micro"}
        </button>
        {!isStreaming ? (
          <button onClick={startStreaming}>🎤 Iniciar streaming</button>
        ) : (
          <button onClick={stopStreaming}>🛑 Parar streaming</button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Escreve aqui…"
          style={{ flex: 1 }}
          onKeyDown={(e) => e.key === "Enter" && sendTyped()}
        />
        <button onClick={sendTyped}>Enviar</button>
      </div>

      <div style={{ border: "1px solid #444", borderRadius: 8, padding: 12 }}>
        <div>
          <strong>Tu:</strong>
          <div>{transcript || "—"}</div>
        </div>
        <div>
          <strong>Alma:</strong>
          <div>{answer || "—"}</div>
        </div>
      </div>
    </main>
  );
}
