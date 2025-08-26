"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Mantém:
 *  - Botão "Ativar micro"
 *  - Hold-to-talk (usa /api/stt -> /api/alma -> /api/tts)
 *  - Caixa de texto (usa /api/alma -> /api/tts)
 *
 * Acrescenta:
 *  - Streaming (beta): envia chunks do MediaRecorder por WebSocket em BASE64 JSON
 *    Estrutura enviada: { type: "audio", data: "<base64>" }
 *    Mensagens esperadas do WS: { transcript, is_final, error? }
 */

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false); // micro ativado
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");

  // histórico simples (para poderes copiar)
  const [history, setHistory] = useState<{ me: string; alma: string }[]>([]);

  // entrada por texto
  const [typed, setTyped] = useState("");

  // --- Audio / Recorder refs (HOLD)
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // --- Streaming WS
  const wsRef = useRef<WebSocket | null>(null);
  const streamingStreamRef = useRef<MediaStream | null>(null);
  const streamingRecorderRef = useRef<MediaRecorder | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const WS_URL = process.env.NEXT_PUBLIC_STT_WS_URL;

  // Audio element para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria o <audio> de TTS uma vez
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // desbloqueio de áudio em iOS
    const unlockAudio = () => {
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
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
    document.addEventListener("click", unlockAudio, { once: true });
    document.addEventListener("touchstart", unlockAudio, { once: true });

    return () => {
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
  }, []);

  // --- Helpers comuns

  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: false,
        },
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

  async function askAlmaAndSpeak(q: string) {
    // pergunta à Alma e fala
    setStatus("🧠 A perguntar à Alma…");
    setTranscript(q);
    setAnswer("");

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
    setHistory((h) => [...h, { me: q, alma: out }]);
    setStatus("🔊 A falar…");
    await speak(out);
    setStatus("Pronto");
  }

  // --- HOLD TO TALK (igual ao teu, sem mexer no fluxo REST)
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
      // 1) STT (REST)
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
        setStatus("⚠️ Não consegui transcrever o áudio. Tenta falar um pouco mais perto.");
        return;
      }

      await askAlmaAndSpeak(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // --- STREAMING (beta) via WS -> envia base64 de cada chunk do MediaRecorder
  async function startStreaming() {
    if (!WS_URL) {
      setStatus("⚠️ Falta NEXT_PUBLIC_STT_WS_URL.");
      return;
    }
    if (isStreaming) return;

    try {
      // micro dedicado ao streaming (não mexe no hold)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: false,
        },
        video: false,
      });
      streamingStreamRef.current = stream;

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("🔌 WS ligado. A enviar áudio em base64…");
        setIsStreaming(true);

        // arrancar MediaRecorder só após WS aberto
        const mime =
          MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "audio/mp4";

        const mr = new MediaRecorder(stream, { mimeType: mime });
        streamingRecorderRef.current = mr;

        mr.ondataavailable = (e) => {
          if (!e.data || e.data.size === 0) return;
          if (!wsRef.current || wsRef.current.readyState !== 1) return;

          // Envia cada chunk como base64 JSON
          e.data.arrayBuffer().then((buf) => {
            const b64 = base64FromArrayBuffer(buf);
            const payload = JSON.stringify({ type: "audio", data: b64 });
            try {
              wsRef.current!.send(payload);
            } catch (err) {
              console.warn("[WS] send falhou:", err);
            }
          });
        };

        // reduzir latência: pedir blobs frequentes
        mr.start(250); // 250ms por chunk
      };

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.error) {
            setStatus("⚠️ WS: " + msg.error);
            return;
          }
          if (typeof msg?.transcript === "string") {
            setTranscript(msg.transcript);
          }
          if (msg?.is_final && msg?.transcript) {
            // final — pergunta à Alma + TTS
            await askAlmaAndSpeak(msg.transcript);
          }
        } catch (e) {
          console.warn("[WS] onmessage parse error:", e);
        }
      };

      ws.onclose = () => {
        setStatus("🔌 WS fechado.");
        setIsStreaming(false);
        cleanupStreaming();
      };

      ws.onerror = (e) => {
        console.warn("[WS] erro:", e);
        setStatus("⚠️ Erro no WS.");
      };
    } catch (e: any) {
      setStatus("⚠️ Não foi possível iniciar streaming: " + (e?.message || e));
      cleanupStreaming();
    }
  }

  function stopStreaming() {
    if (!isStreaming) return;
    if (streamingRecorderRef.current && streamingRecorderRef.current.state !== "inactive") {
      streamingRecorderRef.current.stop();
    }
    if (wsRef.current && wsRef.current.readyState === 1) {
      // envia sinal de fim (se o servidor suportar)
      try {
        wsRef.current.send(JSON.stringify({ type: "end" }));
      } catch {}
      wsRef.current.close();
    }
    cleanupStreaming();
    setIsStreaming(false);
    setStatus("Streaming parado.");
  }

  function cleanupStreaming() {
    if (streamingRecorderRef.current) {
      try {
        if (streamingRecorderRef.current.state !== "inactive") {
          streamingRecorderRef.current.stop();
        }
      } catch {}
      streamingRecorderRef.current = null;
    }
    if (streamingStreamRef.current) {
      for (const t of streamingStreamRef.current.getTracks()) t.stop();
      streamingStreamRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }

  // util: ArrayBuffer -> base64
  function base64FromArrayBuffer(buf: ArrayBuffer) {
    let binary = "";
    const bytes = new Uint8Array(buf);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // Touch handlers para iOS (segurar)
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
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Voz & Texto</h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>{status}</p>

      {/* Controlo de micro (hold) */}
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
      </div>

      {/* Streaming (beta) */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
          border: "1px dashed #333",
          padding: 12,
          borderRadius: 8,
        }}
      >
        <button
          onClick={startStreaming}
          disabled={isStreaming}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isStreaming ? "#113311" : "#222",
            color: isStreaming ? "#9BE29B" : "#fff",
          }}
        >
          {isStreaming ? "Streaming ON ✅" : "Iniciar streaming (beta)"}
        </button>
        <button
          onClick={stopStreaming}
          disabled={!isStreaming}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: !isStreaming ? "#333" : "#8b0000",
            color: "#fff",
          }}
        >
          Parar streaming
        </button>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Envia chunks base64 por WS ({WS_URL || "WS URL em falta"})
        </div>
      </div>

      {/* Entrada por texto */}
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

      {/* Conversa simples */}
      <div
        style={{
          border: "1px solid #333",
          borderRadius: 12,
          padding: 12,
          background: "#0b0b0b",
          marginBottom: 12,
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Tu:</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{transcript || "—"}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Alma:</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{answer || "—"}</div>
        </div>
      </div>

      {/* Histórico para copiar */}
      <div
        style={{
          border: "1px solid #222",
          borderRadius: 12,
          padding: 12,
          background: "#0a0a0a",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Histórico</div>
        {history.length === 0 ? (
          <div style={{ opacity: 0.7 }}>—</div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 8,
              maxHeight: 300,
              overflowY: "auto",
              paddingRight: 6,
            }}
          >
            {history.map((h, i) => (
              <div key={i} style={{ borderBottom: "1px solid #1b1b1b", paddingBottom: 8 }}>
                <div style={{ color: "#9bd", marginBottom: 4 }}>Tu:</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{h.me}</div>
                <div style={{ color: "#bd9", margin: "8px 0 4px" }}>Alma:</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{h.alma}</div>
              </div>
            ))}
          </div>
        )}
        {history.length > 0 && (
          <button
            onClick={() => {
              const txt = history
                .map((h) => `Tu: ${h.me}\nAlma: ${h.alma}`)
                .join("\n\n----------------\n\n");
              navigator.clipboard.writeText(txt).catch(() => {});
            }}
            style={{
              marginTop: 8,
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #333",
              background: "#1b1b1b",
              color: "#eee",
            }}
          >
            Copiar histórico
          </button>
        )}
      </div>
    </main>
  );

  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlmaAndSpeak(q);
  }
}
