"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Página com 3 modos:
 *  1) Texto -> Alma -> TTS
 *  2) Hold-to-talk (gravação curta) -> STT -> Alma -> TTS
 *  3) Streaming WS (chunks 250ms) -> STT em tempo real -> Alma -> TTS
 *
 * Requer:
 *  - /api/stt  (multipart/form-data: audio, language)
 *  - /api/alma (JSON: {question}) -> {answer}
 *  - /api/tts  (JSON: {text}) -> audio/mpeg
 *  - NEXT_PUBLIC_STT_WS_URL (ws:// ou wss://)
 */

type WSMsg =
  | { type: "partial"; transcript: string; lang?: string }
  | { type: "final"; transcript: string; lang?: string }
  | { type: "error"; error: string }
  | any;

export default function Page() {
  // --------------------- UI STATE ---------------------
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");

  // histórico simples para copiar
  const [history, setHistory] = useState<{ role: "you" | "alma"; text: string }[]>([]);

  // --------------------- REFS ÁUDIO/WS ---------------------
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const STT_WS_URL = process.env.NEXT_PUBLIC_STT_WS_URL || "";

  // cria o elemento <audio> para TTS e faz o “unlock” no iOS
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

  // --------------------- HELPERS ÁUDIO ---------------------
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Mantém o botão para falar ou inicia streaming.");
    } catch {
      setStatus(
        "⚠️ Permissão do micro negada. Ativa o acesso ao micro nas definições do navegador."
      );
    }
  }

  function buildMediaRecorder(): MediaRecorder {
    const mime =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
    return new MediaRecorder(streamRef.current!, { mimeType: mime });
  }

  // --------------------- HOLD-TO-TALK ---------------------
  function startHold() {
    if (!isArmed) return requestMic();
    if (!streamRef.current) {
      setStatus("⚠️ Micro não está pronto. Carrega em 'Ativar micro'.");
      return;
    }
    try {
      setStatus("🎙️ A gravar…");
      chunksRef.current = [];
      const mr = buildMediaRecorder();
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

      mr.start(); // sem timeslice: um único blob no stop
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

  // --------------------- STREAMING WS ---------------------
  async function toggleStreaming() {
    if (isStreaming) {
      // parar
      try {
        mediaRecorderRef.current?.stop();
      } catch {}
      try {
        wsRef.current?.close();
      } catch {}
      setIsStreaming(false);
      setStatus("Streaming parado.");
      return;
    }

    // start
    if (!isArmed) {
      await requestMic();
      if (!streamRef.current) return;
    }

    if (!STT_WS_URL) {
      setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definido.");
      return;
    }

    try {
      setStatus("🔌 A ligar ao STT…");
      const ws = new WebSocket(STT_WS_URL);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        setStatus("🟢 Streaming ligado. A enviar áudio…");
      };
      ws.onerror = (ev) => {
        console.warn("[WS] erro", ev);
        setStatus("⚠️ Erro no WebSocket STT.");
      };
      ws.onclose = () => {
        setStatus("Streaming fechado.");
        setIsStreaming(false);
        try {
          mediaRecorderRef.current?.stop();
        } catch {}
      };
      ws.onmessage = async (ev) => {
        try {
          const msg: WSMsg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (msg.type === "partial" && msg.transcript) {
            setTranscript(msg.transcript);
          } else if (msg.type === "final" && msg.transcript) {
            setTranscript(msg.transcript);
            await askAlma(msg.transcript);
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + msg.error);
          }
        } catch {
          // mensagens binárias/keep-alive ignoradas
        }
      };

      wsRef.current = ws;

      // MediaRecorder com timeslice para ENVIAR CHUNKS
      const mr = buildMediaRecorder();
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0 && wsRef.current?.readyState === 1) {
          // envia imediatamente cada chunk
          wsRef.current.send(e.data);
        }
      };
      mr.onstop = () => {
        // no streaming não fazemos nada no stop; Alma é chamada em "final"
      };

      mr.start(250); // 250ms -> baixa latência
      setIsStreaming(true);
      setStatus("🎧 Streaming a decorrer…");
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
    }
  }

  // --------------------- LLM & TTS ---------------------
  async function askAlma(question: string) {
    const q = (question || "").trim();
    if (!q) return;
    setHistory((h) => [...h, { role: "you", text: q }]);

    setStatus("🧠 A perguntar à Alma…");
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
      setHistory((h) => [...h, { role: "alma", text: out }]);

      setStatus("🔊 A falar…");
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

  function stopSpeaking() {
    const a = ttsAudioRef.current;
    if (!a) return;
    try {
      a.pause();
      a.currentTime = 0;
    } catch {}
  }

  // --------------------- STT-HOLD PIPE ---------------------
  async function handleTranscribeAndAnswer(blob: Blob) {
    try {
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
        setStatus("⚠️ Não consegui transcrever o áudio. Tenta falar mais perto do micro.");
        return;
      }
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // --------------------- TEXTO ---------------------
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTranscript(q);
    setTyped("");
    await askAlma(q);
  }

  // Touch handlers iOS para hold
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    startHold();
  }
  function onHoldEnd(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    stopHold();
  }

  // --------------------- UI ---------------------
  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: 16,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Voz & Texto</h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>{status}</p>

      {/* Controlo de micro + streaming */}
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
          disabled={!isArmed}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isStreaming ? "#5b2b00" : "#333",
            color: "#fff",
          }}
        >
          {isStreaming ? "⏹️ Parar streaming" : "🟢 Iniciar streaming"}
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

        <button
          onClick={stopSpeaking}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#2b2b2b",
            color: "#fff",
          }}
        >
          🔇 Parar voz
        </button>
      </div>

      {/* Entrada por texto */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          name="typed"
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

      {/* Histórico copiável */}
      <div
        style={{
          border: "1px dashed #333",
          borderRadius: 12,
          padding: 12,
          background: "#0b0b0b",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <strong>Histórico</strong>
          <button
            onClick={() => {
              const txt = history.map((h) => `${h.role === "you" ? "Tu" : "Alma"}: ${h.text}`).join("\n");
              navigator.clipboard.writeText(txt).catch(() => {});
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #444",
              background: "#222",
              color: "#ddd",
            }}
          >
            Copiar
          </button>
        </div>
        <div style={{ maxHeight: 220, overflow: "auto", fontSize: 14, lineHeight: 1.4 }}>
          {history.length === 0 ? (
            <div style={{ opacity: 0.6 }}>— sem mensagens ainda —</div>
          ) : (
            history.map((m, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <span style={{ color: "#aaa", fontWeight: 600 }}>
                  {m.role === "you" ? "Tu" : "Alma"}:
                </span>{" "}
                <span style={{ whiteSpace: "pre-wrap" }}>{m.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}
