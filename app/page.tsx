"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false); // micro ativado
  const [isRecording, setIsRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");

  // entrada por texto
  const [typed, setTyped] = useState("");

  // histórico
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Audio / Recorder refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // Audio element para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria o <audio> de TTS uma vez + desbloqueio iOS
  useEffect(() => {
    const a = new Audio();
    // TS não conhece playsInline para <audio>; cast para evitar erro de build
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // Desbloquear áudio em iOS no primeiro gesto do utilizador
    const unlockAudio = () => {
      const el = ttsAudioRef.current;
      if (!el) return;
      try {
        el.muted = true;
        el.play().then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        }).catch(() => {});
      } catch {}
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
    document.addEventListener("click", unlockAudio, { once: true });
    document.addEventListener("touchstart", unlockAudio, { once: true });

    // Clean up
    return () => {
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
  }, []);

  // --- Helpers

  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: false, // podes ligar se houver feedback
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

  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4"; // fallback (Safari antigo)
    const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
    return mr;
  }

  function startHold() {
    if (!isArmed) {
      // primeira interação: ativar micro
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

  // --- ALMA (timeout aumentado)
  async function askAlma(question: string) {
    setTranscript(question);
    setLog((l) => [...l, { role: "you", text: question }]);

    setStatus("🧠 A perguntar à Alma…");

    // Timeout 100s para evitar abort prematuro
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 100000);

    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: ctrl.signal,
      });

      clearTimeout(timer);

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
      clearTimeout(timer);
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // --- STT upload
  async function handleTranscribeAndAnswer(blob: Blob) {
    try {
      // 1) STT
      setStatus("🎧 A transcrever…");
      const fd = new FormData();
      // Mantemos webm/mp4 — o teu /api/stt já está a aceitar e a funcionar
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
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Tenta falar um pouco mais perto.");
        return;
      }

      // 2) ALMA
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // --- TTS (timeout aumentado) + parar fala
  function stopSpeaking() {
    const audio = ttsAudioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {}
    setSpeaking(false);
  }

  async function speak(text: string) {
    if (!text) return;

    // Se já está a falar algo, interrompe primeiro
    stopSpeaking();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 100000);

    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      });

      clearTimeout(timer);

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

      // Quando terminar, limpa estado
      audio.onended = () => {
        setSpeaking(false);
      };

      try {
        setSpeaking(true);
        await audio.play();
      } catch {
        setSpeaking(false);
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      clearTimeout(timer);
      setSpeaking(false);
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // --- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
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

  function copyLog() {
    const txt = log.map((l) => (l.role === "you" ? "Tu: " : "Alma: ") + l.text).join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setStatus("Histórico copiado.");
      setTimeout(() => setStatus("Pronto"), 1200);
    });
  }

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

      {/* Controlo de micro + TTS utilitários */}
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
          onClick={() => speak("Olá! Sou a Alma. Já posso falar no teu dispositivo.")}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#333",
            color: "#fff",
          }}
        >
          Testar voz 🔊
        </button>

        <button
          onClick={stopSpeaking}
          disabled={!speaking}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: speaking ? "#552222" : "#2a2a2a",
            color: "#fff",
            opacity: speaking ? 1 : 0.6,
          }}
        >
          Interromper fala ⏹️
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
