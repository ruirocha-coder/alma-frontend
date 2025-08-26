"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Mantém:
 *  - Ativar micro
 *  - Segurar para falar (hold) -> /api/stt -> /api/alma -> /api/tts
 *  - Caixa de texto -> /api/alma -> /api/tts
 *
 * Acrescenta:
 *  - Streaming STT por WebSocket (NEXT_PUBLIC_STT_WS_URL)
 *    Mostra transcrição ao vivo; quando is_final=true, pergunta à Alma e fala.
 */

export default function Page() {
  // --- UI base (como tinhas)
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");
  const [typed, setTyped] = useState("");

  // --- Streaming STT extra
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");

  // --- Audio / Recorder refs (iguais aos teus)
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // --- TTS audio
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria <audio> p/ TTS (igual ao teu, com playsInline no iOS)
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = () => {
      if (!ttsAudioRef.current) return;
      try {
        ttsAudioRef.current.muted = true;
        ttsAudioRef.current
          .play()
          .then(() => {
            ttsAudioRef.current!.pause();
            ttsAudioRef.current!.currentTime = 0;
            ttsAudioRef.current!.muted = false;
          })
          .catch(() => {});
      } catch {}
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

  // ---- MIC igual ao teu
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Mantém o botão para falar.");
    } catch (e: any) {
      setStatus(
        "⚠️ Permissão do micro negada. Abre as definições do navegador e permite acesso ao micro."
      );
    }
  }

  // ---- HOLD (o teu fluxo original)
  function startHold() {
    if (!isArmed) {
      requestMic();
      return;
    }
    if (!streamRef.current) {
      setStatus("⚠️ Micro não está pronto. Carrega primeiro em 'Ativar micro'.");
      return;
    }
    try {
      setStatus("🎙️ A gravar…");
      chunksRef.current = [];

      const mime =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4"; // fallback Safari

      const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        await handleTranscribeAndAnswer(blob);
      };

      mr.start();
      setIsRecording(true);
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar gravação: " + (e?.message || e));
    }
  }

  function stopHold() {
    if (mediaRecorderRef.current && isRecording) {
      setStatus("⏳ A processar áudio…");
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  async function handleTranscribeAndAnswer(blob: Blob) {
    try {
      // 1) STT (igual ao teu)
      setStatus("🎧 A transcrever…");
      const fd = new FormData();
      fd.append("audio", blob, "audio.webm");
      fd.append("language", "pt-PT");

      const sttResp = await fetch("/api/stt", { method: "POST", body: fd });
      if (!sttResp.ok) {
        const txt = await sttResp.text();
        setTranscript("");
        setStatus("⚠️ STT " + sttResp.status + ": " + txt.slice(0, 200));
        return;
      }
      const sttJson = (await sttResp.json()) as { transcript?: string; error?: string };
      const said = (sttJson.transcript || "").trim();
      setTranscript(said);
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Tenta falar mais perto.");
        return;
      }

      // 2) ALMA
      setStatus("🧠 A perguntar à Alma…");
      const almaResp = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: said }),
      });
      if (!almaResp.ok) {
        const txt = await almaResp.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        return;
      }
      const almaJson = (await almaResp.json()) as { answer?: string };
      const out = (almaJson.answer || "").trim();
      setAnswer(out);
      setStatus("🔊 A falar…");

      // 3) TTS
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  async function speak(text: string) {
    if (!text) return;
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus(`⚠️ Erro no /api/tts: ${r.status} ${txt.slice(0, 200)}`);
        return;
      }
      const ab = await r.arrayBuffer();
      const blob = new Blob([ab], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);

      const audio = ttsAudioRef.current;
      if (!audio) {
        setStatus("⚠️ Áudio não inicializado.");
        return;
      }
      audio.src = url;
      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ---- Texto escrito (igual)
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setStatus("🧠 A perguntar à Alma…");
    setTranscript(q);
    setAnswer("");

    try {
      const almaResp = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!almaResp.ok) {
        const txt = await almaResp.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        return;
      }
      const almaJson = (await almaResp.json()) as { answer?: string };
      const out = (almaJson.answer || "").trim();
      setAnswer(out);
      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("Pronto");
      setTyped("");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // =========================
  //   STREAMING WEBSOCKET
  // =========================
  const wsRef = useRef<WebSocket | null>(null);
  const streamMrRef = useRef<MediaRecorder | null>(null);
  const pingTimerRef = useRef<any>(null);

  function startStreaming() {
    if (!isArmed) {
      requestMic();
      return;
    }
    const WS_URL = process.env.NEXT_PUBLIC_STT_WS_URL;
    if (!WS_URL) {
      setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definida.");
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WS] aberto:", WS_URL);
        setStatus("🎙️ Streaming ativo");
        setIsStreaming(true);
        setLiveTranscript("");

        // (Opcional) handshake/config para o teu proxy STT
        // Ex.: ws.send(JSON.stringify({ type: "start", format: "webm_opus", lang: "pt-PT" }));
        try {
          ws.send(JSON.stringify({ type: "start", format: "webm_opus", lang: "pt-PT" }));
        } catch {}

        // MediaRecorder com timeslice para enviar chunks
        const mime =
          MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";

        const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
        streamMrRef.current = mr;

        mr.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
            // Envia blob diretamente (browsers WS aceitam Blob)
            ws.send(e.data);
          }
        };
        mr.onstop = () => {
          console.log("[WS] MediaRecorder stop");
        };
        mr.start(250);

        // ping keepalive (se o proxy fechar por inatividade)
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {}
          }
        }, 15000);
      };

      ws.onmessage = async (ev) => {
        try {
          const txt = typeof ev.data === "string" ? ev.data : "";
          if (!txt) return;
          const msg = JSON.parse(txt);
          // Espera-se: { transcript: string, is_final: boolean }
          if (typeof msg.transcript === "string") {
            setLiveTranscript(msg.transcript);
          }
          if (msg.is_final && msg.transcript) {
            // Pergunta à Alma e fala
            await askAlma(msg.transcript);
          }
        } catch (e) {
          console.warn("[WS] onmessage parse error:", e);
        }
      };

      ws.onerror = (e) => {
        console.error("[WS] erro:", e);
        setStatus("⚠️ Erro no streaming");
      };

      ws.onclose = () => {
        console.log("[WS] fechado");
        setIsStreaming(false);
        setStatus("Pronto");
        try {
          streamMrRef.current?.stop();
        } catch {}
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
      };
    } catch (e: any) {
      setStatus("⚠️ Não consegui iniciar streaming: " + (e?.message || e));
    }
  }

  function stopStreaming() {
    try {
      streamMrRef.current?.stop();
    } catch {}
    try {
      wsRef.current?.close();
    } catch {}
    setIsStreaming(false);
    setStatus("Pronto");
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }

  // Touch handlers (iguais)
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    startHold();
  }
  function onHoldEnd(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    stopHold();
  }

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: 16,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Voz & Texto (com Streaming)</h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>{status}</p>

      {/* Controlo de micro (igual) */}
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
          onMouseDown={onHoldStart}
          onMouseUp={onHoldEnd}
          onTouchStart={onHoldStart}
          onTouchEnd={onHoldEnd}
          style={{
            padding: "10px 14px",
            borderRadius: 999,
            border: "1px solid #444",
            background: isRecording ? "#8b0000" : "#333",
            color: "#fff",
          }}
        >
          {isRecording ? "A gravar… solta para enviar" : "🎤 Segurar para falar"}
        </button>

        {!isStreaming ? (
          <button
            onClick={startStreaming}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #444",
              background: "#1c1c5a",
              color: "#fff",
            }}
          >
            🎤 Iniciar streaming
          </button>
        ) : (
          <button
            onClick={stopStreaming}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #444",
              background: "#5a1c1c",
              color: "#fff",
            }}
          >
            🛑 Parar streaming
          </button>
        )}
      </div>

      {/* Entrada por texto (igual) */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Escreve aqui para perguntar à Alma…"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#111",
            color: "#fff",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendTyped();
          }}
        />
        <button
          onClick={sendTyped}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#2b2bff",
            color: "#fff",
          }}
        >
          Enviar
        </button>
      </div>

      {/* Conversa simples (igual) */}
      <div
        style={{
          border: "1px solid #333",
          borderRadius: 12,
          padding: 12,
          background: "#0b0b0b",
          marginBottom: 16,
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Tu (última pergunta):</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{transcript || "—"}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Alma:</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{answer || "—"}</div>
        </div>
      </div>

      {/* Transcrição ao vivo do Streaming */}
      <div
        style={{
          border: "1px dashed #444",
          borderRadius: 12,
          padding: 12,
          background: "#0b0b0b",
        }}
      >
        <div style={{ fontWeight: 600, color: "#aaa", marginBottom: 4 }}>
          Transcrição ao vivo (Streaming):
        </div>
        <div style={{ minHeight: 24, whiteSpace: "pre-wrap" }}>
          {isStreaming ? liveTranscript || "…" : "—"}
        </div>
        <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
          * Quando o servidor enviar <code>is_final: true</code>, a Alma responde e fala automaticamente.
        </div>
      </div>
    </main>
  );
}
