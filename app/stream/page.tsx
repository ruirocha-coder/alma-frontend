"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  "";

export default function StreamPage() {
  // ----- UI -----
  const [status, setStatus] = useState("Pronto (streaming em página separada)");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [isArmed, setIsArmed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [log, setLog] = useState<LogItem[]>([]);

  // ----- Áudio / WS -----
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const requestTimerRef = useRef<any>(null);

  // player TTS (independente da home)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // preparar elemento <audio> e desbloquear áudio em iOS
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = () => {
      const el = ttsAudioRef.current;
      if (!el) return;
      el.muted = true;
      el.play().then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
      }).catch(() => {});
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true });

    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
  }, []);

  // ---- helpers ----
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Carrega em Iniciar Streaming.");
    } catch {
      setStatus("⚠️ Permissão do micro negada.");
    }
  }

  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      mime = "audio/webm;codecs=opus";
    } else if (MediaRecorder.isTypeSupported("audio/webm")) {
      mime = "audio/webm";
    } else {
      mime = "audio/mp4"; // fallback Safari
    }
    const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
    (mr as any).__mime = mime;
    return mr;
  }

  async function speak(text: string) {
    if (!text) return;
    try {
      // parar áudio anterior se ainda a tocar
      const audioEl = ttsAudioRef.current;
      if (audioEl && !audioEl.paused) {
        try { audioEl.pause(); audioEl.currentTime = 0; } catch {}
      }

      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus(`⚠️ /api/tts ${r.status}: ${txt.slice(0, 160)}`);
        return;
      }
      const ab = await r.arrayBuffer();
      const blob = new Blob([ab], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);

      const audio = ttsAudioRef.current;
      if (!audio) {
        URL.revokeObjectURL(url);
        setStatus("⚠️ Áudio não inicializado.");
        return;
      }
      audio.src = url;
      try { audio.load(); } catch {}

      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio (toca no ecrã e tenta de novo).");
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  async function askAlma(q: string) {
    setTranscript(q);
    setLog((l) => [...l, { role: "you", text: q }]);
    setStatus("🧠 A perguntar à Alma…");
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 160));
        return;
      }
      const j = (await r.json()) as { answer?: string };
      const out = (j.answer || "").trim();
      setAnswer(out);
      setLog((l) => [...l, { role: "alma", text: out }]);
      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("🎧 Streaming a decorrer…");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  async function toggleStreaming() {
    if (isStreaming) {
      // parar
      try { mediaRecorderRef.current?.stop(); } catch {}
      try { wsRef.current?.close(); } catch {}
      if (requestTimerRef.current) clearInterval(requestTimerRef.current);
      setIsStreaming(false);
      setStatus("Streaming parado.");
      return;
    }

    if (!STT_WS_URL) {
      setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definido.");
      return;
    }
    if (!isArmed) {
      await requestMic();
      if (!streamRef.current) return;
    }

    try {
      setStatus("🔌 A ligar ao STT…");
      const ws = new WebSocket(STT_WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setStatus("🟢 Streaming ligado. A enviar áudio…");
        // envia start com o mime detetado
        const mime = (mediaRecorderRef.current as any)?.__mime || "audio/webm;codecs=opus";
        try {
          ws.send(JSON.stringify({ type: "start", language: "pt-PT", format: mime }));
        } catch {}
      };

      ws.onerror = (ev) => {
        console.warn("[WS] erro", ev);
        setStatus("⚠️ Erro no WebSocket STT.");
      };

      ws.onclose = () => {
        setStatus("Streaming fechado.");
        setIsStreaming(false);
        try { mediaRecorderRef.current?.stop(); } catch {}
        if (requestTimerRef.current) clearInterval(requestTimerRef.current);
      };

      ws.onmessage = async (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "partial" && msg.transcript) {
            setTranscript(msg.transcript);
          } else if ((msg.type === "final" || msg.is_final) && msg.transcript) {
            setTranscript(msg.transcript);
            await askAlma(msg.transcript);
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + msg.error);
          }
        } catch {
          // ignora strings não-JSON (ping/pong)
        }
      };

      wsRef.current = ws;

      const mr = buildMediaRecorder();
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        if (!wsRef.current || wsRef.current.readyState !== 1) return;
        e.data.arrayBuffer().then((buf) => {
          try { wsRef.current!.send(buf); } catch (err) {
            console.warn("[WS] send falhou:", err);
          }
        });
      };

      mr.onstop = () => {
        if (wsRef.current && wsRef.current.readyState === 1) {
          try { wsRef.current.send(JSON.stringify({ type: "stop" })); } catch {}
        }
      };

      // timeslice + requestData para garantir envio (Safari/Chrome)
      mr.start(250);
      requestTimerRef.current = setInterval(() => {
        try { mr.requestData(); } catch {}
      }, 250);

      setIsStreaming(true);
      setStatus("🎧 Streaming a decorrer…");
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
    }
  }

  function copyLog() {
    const txt = log.map((l) => (l.role === "you" ? "Tu: " : "Alma: ") + l.text).join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setStatus("Histórico copiado.");
      setTimeout(() => setStatus(isStreaming ? "🎧 Streaming a decorrer…" : "Pronto"), 1200);
    });
  }

  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: 16,
        color: "#fff",
        background: "#0b0b0b",
        minHeight: "100vh",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        🎭 Alma — Streaming (página separada)
      </h1>
      <p style={{ opacity: 0.85, marginBottom: 16 }}>{status}</p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          onClick={requestMic}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isArmed ? "#113311" : "#222",
            color: isArmed ? "#9BE29B" : "#fff",
          }}
        >
          {isArmed ? "Micro pronto ✅" : "Ativar micro"}
        </button>

        <button
          onClick={toggleStreaming}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isStreaming ? "#004488" : "#333",
            color: "#fff",
          }}
        >
          {isStreaming ? "⏹️ Parar streaming" : "🔴 Iniciar streaming"}
        </button>

        <button
          onClick={copyLog}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#222",
            color: "#ddd",
          }}
        >
          Copiar histórico
        </button>

        <a
          href="/"
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#222",
            color: "#ddd",
            textDecoration: "none",
          }}
        >
          ⤶ Voltar (hold/texto)
        </a>
      </div>

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 12,
          padding: 12,
          background: "#0f0f0f",
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Tu (último):</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{transcript || "—"}</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Alma (último):</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{answer || "—"}</div>
        </div>

        <hr style={{ borderColor: "#222", margin: "8px 0 12px" }} />

        <div>
          <div style={{ fontWeight: 600, color: "#aaa", marginBottom: 6 }}>Histórico</div>
          <div style={{ display: "grid", gap: 6 }}>
            {log.length === 0 && <div style={{ opacity: 0.6 }}>—</div>}
            {log.map((m, i) => (
              <div key={i} style={{ whiteSpace: "pre-wrap" }}>
                <span style={{ color: "#999" }}>{m.role === "you" ? "Tu:" : "Alma:"}</span>{" "}
                {m.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
