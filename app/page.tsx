"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Audio / Recorder refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Reutilizamos um único <audio> para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);

  // cria o <audio> de TTS uma vez + rotina de desbloqueio iOS
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = () => {
      if (audioUnlockedRef.current) return;
      const el = ttsAudioRef.current;
      if (!el) return;

      // pequeno “beep” silencioso só para desbloquear autoplay
      el.muted = true;
      el
        .play()
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
          audioUnlockedRef.current = true;
        })
        .catch(() => {
          // ignore – alguns browsers só desbloqueiam no 2º toque
        });
    };

    // desbloqueamos no primeiro gesto do utilizador
    const onFirstGesture = () => {
      unlock();
      document.removeEventListener("click", onFirstGesture);
      document.removeEventListener("touchstart", onFirstGesture);
    };
    document.addEventListener("click", onFirstGesture, { once: true });
    document.addEventListener("touchstart", onFirstGesture, { once: true });

    return () => {
      document.removeEventListener("click", onFirstGesture);
      document.removeEventListener("touchstart", onFirstGesture);
    };
  }, []);

  // --- Helpers

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
    } catch {
      setStatus("⚠️ Permissão do micro negada no navegador/dispositivo.");
    }
  }

  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4"; // fallback Safari
    return new MediaRecorder(streamRef.current!, { mimeType: mime });
  }

  // --- TTS
  async function speak(text: string) {
    if (!text) return;
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        // keepalive ajuda quando o tab fica em background
        keepalive: true,
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

      // Se o iPad bloquear, a próxima interação (clicar) deve libertar
      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // Botão “Testar voz” — útil no iPad para aquecer a pipeline
  async function testVoice() {
    await speak("Olá! A minha voz está pronta.");
  }

  // --- ALMA
  async function askAlma(question: string) {
    setTranscript(question);
    setLog((l) => [...l, { role: "you", text: question }]);
    setStatus("🧠 A perguntar à Alma…");
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        keepalive: true,
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
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // --- Push-to-talk (upload) — SEM streaming
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
      const mr = buildMediaRecorder();
      mediaRecorderRef.current = mr;

      const chunks: BlobPart[] = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mr.onstop = async () => {
        const blob = new Blob(chunks, { type: mr.mimeType });
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
      fd.append("language", "pt-PT");

      const sttResp = await fetch("/api/stt", { method: "POST", body: fd, keepalive: true });
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

      // 2) ALMA → 3) TTS
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // --- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // --- UI handlers (hold)
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
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

  // --- UI
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

      {/* Controlo de micro + teste de voz + hold */}
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
          onClick={testVoice}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#333",
            color: "#fff",
          }}
        >
          🔊 Testar voz
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
