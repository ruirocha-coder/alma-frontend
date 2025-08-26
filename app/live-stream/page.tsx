"use client";

import React, { useEffect, useRef, useState } from "react";

export default function LiveStreamPage() {
  const [status, setStatus] = useState("Pronto");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria audio player
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    ttsAudioRef.current = a;
  }, []);

  async function startStreaming() {
    setStatus("🔌 A ligar ao STT...");
    const ws = new WebSocket(
      `${window.location.origin.replace(/^http/, "ws")}/api/stt-stream`
    );

    ws.onopen = async () => {
      setStatus("🎙️ Micro aberto, a enviar áudio em streaming...");
      wsRef.current = ws;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

      rec.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      rec.start(250); // envia chunks a cada 250ms
      recorderRef.current = rec;
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.channel?.alternatives?.[0]?.transcript) {
        const said = msg.channel.alternatives[0].transcript;
        if (said.trim()) {
          setTranscript(said);

          // quando há frase final
          if (msg.is_final) {
            setStatus("🧠 A perguntar à Alma…");
            const almaResp = await fetch("/api/alma", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ question: said }),
            });
            const almaJson = await almaResp.json();
            const out = almaJson.answer || "";
            setAnswer(out);
            setStatus("🔊 A falar…");

            // TTS
            const r = await fetch("/api/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: out }),
            });
            const ab = await r.arrayBuffer();
            const blob = new Blob([ab], { type: "audio/mpeg" });
            const url = URL.createObjectURL(blob);
            const audio = ttsAudioRef.current!;
            audio.src = url;
            await audio.play();

            setStatus("Pronto");
          }
        }
      }
    };

    ws.onerror = () => setStatus("⚠️ Erro no WebSocket STT");
  }

  function stopStreaming() {
    setStatus("⏹️ Streaming parado");
    recorderRef.current?.stop();
    wsRef.current?.close();
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>🎭 Alma — Live Streaming</h1>
      <p>{status}</p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <button onClick={startStreaming}>▶️ Iniciar streaming</button>
        <button onClick={stopStreaming}>⏹️ Parar</button>
      </div>

      <div style={{ border: "1px solid #333", padding: 12, borderRadius: 8 }}>
        <div>
          <strong>Tu:</strong> {transcript || "—"}
        </div>
        <div>
          <strong>Alma:</strong> {answer || "—"}
        </div>
      </div>
    </main>
  );
}
