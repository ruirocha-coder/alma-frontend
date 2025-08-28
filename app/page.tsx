"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

// -----------------------
// AJUSTES
// -----------------------
const STT_LANGUAGE = "pt-PT";          // linguagem da transcrição
const ALMA_TIMEOUT_MS = 45000;         // timeout da chamada ao /api/alma
const TTS_TIMEOUT_MS = 30000;          // timeout da chamada ao /api/tts

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);       // micro ativado
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false); // TTS a tocar

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");

  // entrada por texto
  const [typed, setTyped] = useState("");

  // histórico simples
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Audio / Recorder refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // HTMLAudio para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria o <audio> de TTS e desbloqueia iOS no 1º gesto
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS
    a.autoplay = false;
    a.preload = "auto";
    a.addEventListener("ended", () => setIsSpeaking(false));
    ttsAudioRef.current = a;

    const unlock = () => {
      const el = ttsAudioRef.current;
      if (!el) return;
      el.muted = true;
      el.play()
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        })
        .catch(() => {});
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

  // -----------------------
  // Helpers
  // -----------------------
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: false, // evita cortar sílabas
        },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Mantém o botão para falar.");
    } catch {
      setStatus("⚠️ Permissão do micro negada. Ativa o micro nas definições do navegador.");
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
    return new MediaRecorder(streamRef.current!, { mimeType: mime });
  }

  // fetch com timeout
  async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit & { timeout?: number } = {}
  ) {
    const { timeout, ...rest } = init;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout ?? 30000);
    try {
      return await fetch(input, { ...rest, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  }

  // -----------------------
  // TTS
  // -----------------------
  async function speak(text: string) {
    if (!text) return;
    try {
      const r = await fetchWithTimeout("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        timeout: TTS_TIMEOUT_MS,
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus(`⚠️ Erro no /api/tts: ${r.status} ${txt.slice(0, 200)}`);
        setIsSpeaking(false);
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

      // se já estiver a falar, interrompe
      try {
        audio.pause();
      } catch {}
      audio.currentTime = 0;
      audio.src = url;

      try {
        setIsSpeaking(true);
        await audio.play();
      } catch {
        setIsSpeaking(false);
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setIsSpeaking(false);
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  function stopSpeaking() {
    const a = ttsAudioRef.current;
    if (!a) return;
    try {
      a.pause();
    } catch {}
    a.currentTime = 0;
    setIsSpeaking(false);
  }

  // -----------------------
  // ALMA
  // -----------------------
  async function askAlma(question: string) {
    setTranscript(question);
    setLog((l) => [...l, { role: "you", text: question }]);
    setStatus("🧠 A perguntar à Alma…");

    try {
      const r = await fetchWithTimeout("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        timeout: ALMA_TIMEOUT_MS,
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        return;
      }
      const j = (await r.json()) as { answer?: string };
      const out = (j.answer || "").trim();
      setAnswer(out);
      setLog((l) => [...l, { role: "alma", text: out }]);
      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "tempo esgotado" : (e?.message || e);
      setStatus("⚠️ Erro: " + msg);
    }
  }

  // -----------------------
  // Push-to-talk (HOLD)
  // -----------------------
  function startHold() {
    if (!isArmed) {
      // primeira interação: ativa o micro (desbloqueia também o áudio no iOS)
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
      const mr = buildMediaRecorder();
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
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
      // 1) STT
      setStatus("🎧 A transcrever…");
      const fd = new FormData();
      fd.append("audio", blob, "audio.webm");
      fd.append("language", STT_LANGUAGE);

      const sttResp = await fetchWithTimeout("/api/stt", {
        method: "POST",
        body: fd,
        // Deepgram HTTP costuma ser rápido; 25s é mais que suficiente
        timeout: 25000,
      });
      if (!sttResp.ok) {
        const txt = await sttResp.text();
        setTranscript("");
        setStatus("⚠️ STT " + sttResp.status + ": " + txt.slice(0, 200));
        return;
      }
      const sttJson = (await sttResp.json()) as { transcript?: string; error?: string };
      const said = (sttJson.transcript || "").trim();
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Fala um pouco mais perto do micro.");
        return;
      }

      // 2) ALMA + TTS
      await askAlma(said);
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "tempo esgotado" : (e?.message || e);
      setStatus("⚠️ Erro: " + msg);
    }
  }

  // -----------------------
  // Texto → Alma
  // -----------------------
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");

    // permite interromper fala anterior antes de nova resposta
    stopSpeaking();
    await askAlma(q);
  }

  // -----------------------
  // UI handlers
  // -----------------------
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    // interrompe fala para não alimentar eco no micro
    stopSpeaking();
    startHold();
  }
  function onHoldEnd(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    stopHold();
  }

  function copyLog() {
    const txt = log.map((l) => (l.role === "you" ? "Tu: " : "Alma: ") + l.text).join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setStatus("Histórico copiado.");
      setTimeout(() => setStatus("Pronto"), 1200);
    });
  }

  // -----------------------
  // UI
  // -----------------------
  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: 16,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
        color: "#fff",
        background: "#0b0b0b",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Voz & Texto</h1>
      <p style={{ opacity: 0.85, marginBottom: 16 }}>{status}</p>

      {/* Controlo de micro + Hold + Interrupt */}
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

        <button
          onClick={stopSpeaking}
          disabled={!isSpeaking}
          title="Interromper fala"
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isSpeaking ? "#442200" : "#222",
            color: isSpeaking ? "#FFD7A0" : "#bbb",
          }}
        >
          ⏹️ Interromper fala
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
