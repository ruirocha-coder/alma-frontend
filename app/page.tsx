"use client";

import React, { useEffect, useRef, useState } from "react";
import AvatarCanvas from "../components/AvatarCanvas";

type LogItem = { role: "you" | "alma"; text: string };

// --- USER_ID estável para Mem0 (curto prazo)
function getUserId() {
  try {
    const KEY = "alma_user_id";
    let v = localStorage.getItem(KEY);
    if (v) return v;
    v = "u_" + crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
    localStorage.setItem(KEY, v);
    return v;
  } catch {
    return "anon";
  }
}
const USER_ID = typeof window !== "undefined" ? getUserId() : "anon";

export default function Page() {
  // ---------- PALETA (igual à do alma-chat)
  const colors = {
    bg: "#0a0a0b",
    panel: "#0f0f11",
    panel2: "#141418",
    fg: "#f3f3f3",
    fgDim: "#cfcfd3",
    border: "#26262b",
    accent: "#d4a017", // amarelo torrado
    bubbleUser: "#1b1b21",
    bubbleAlma: "#23232a",
  };

  // helpers visuais (apenas estilo)
  const btnBase: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 10,
    border: `1px solid ${colors.border}`,
    background: "#19191e",
    color: colors.fg,
    cursor: "pointer",
  };
  const btnSubtle: React.CSSProperties = {
    ...btnBase,
    background: "#14141a",
    color: colors.fgDim,
  };
  const btnPrimary: React.CSSProperties = {
    ...btnBase,
    background: colors.accent,
    color: "#000",
    borderColor: "rgba(0,0,0,0.35)",
    fontWeight: 600,
  };

  // --- UI state (mantido)
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // controla o primeiro clique no botão amarelo: ativa teste de voz e passa a “segurar para falar”
  const [firstPressDone, setFirstPressDone] = useState(false);

  // --- Audio / Recorder
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // TTS player
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // LIPSYNC
  const audioLevelRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRAF = useRef<number | null>(null);

  function startOutputMeter() {
    if (analyserRef.current && audioCtxRef.current && ttsAudioRef.current) return;
    const el = ttsAudioRef.current;
    if (!el) return;

    const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
    if (!AC) return;

    const ctx = audioCtxRef.current || new AC();
    audioCtxRef.current = ctx;

    const src = ctx.createMediaElementSource(el);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;

    src.connect(analyser);
    analyser.connect(ctx.destination);

    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 4);
      audioLevelRef.current = level;
      meterRAF.current = requestAnimationFrame(tick);
    };
    if (meterRAF.current) cancelAnimationFrame(meterRAF.current);
    meterRAF.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    const el = document.getElementById("tts-audio") as HTMLAudioElement | null;
    if (el) {
      ttsAudioRef.current = el;
      (el as any).playsInline = true;
      el.autoplay = false;
      el.preload = "auto";
      el.crossOrigin = "anonymous";
    }

    // Desbloqueio de áudio em iOS/Safari após gesto
    const unlock = async () => {
      const a = ttsAudioRef.current;
      if (!a) return;
      try {
        a.muted = true;
        await a.play().catch(() => {});
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      } catch {}
      try {
        const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
        if (AC && !audioCtxRef.current) audioCtxRef.current = new AC();
      } catch {}
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true });

    // Auto-armar vindo do index: .../alma-frontend?arm=1
    try {
      const p = new URLSearchParams(location.search);
      if (p.get("arm") === "1") {
        // pequeno atraso para deixar a página montar
        setTimeout(() => requestMic(), 50);
      }
    } catch {}

    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
      if (meterRAF.current) cancelAnimationFrame(meterRAF.current);
      try {
        audioCtxRef.current?.close();
      } catch {}
    };
  }, []);

  // --- Micro
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
      setStatus("⚠️ Permissão do micro negada. Ativa nas definições do navegador.");
    }
  }

  function startHold() {
    // Primeiro clique: armar + teste de voz (e não gravamos ainda)
    if (!firstPressDone) {
      const go = async () => {
        if (!isArmed) await requestMic();
        await testVoice();
        setFirstPressDone(true);
        setStatus("Pronto");
      };
      go();
      return;
    }

    if (!isArmed) {
      requestMic();
      return;
    }
    if (!streamRef.current) {
      setStatus("⚠️ Micro não está pronto.");
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
          : "audio/mp4";

      const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
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
      setLog((l) => (said ? [...l, { role: "you", text: said }] : l));
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Fala mais perto do micro.");
        return;
      }

      await askAlma(said);
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

      startOutputMeter();

      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  async function testVoice() {
    setStatus("🔊 A testar voz…");
    await speak("Olá! Sou a Alma. Estás a ouvir bem?");
  }

  async function askAlma(question: string) {
    setStatus("🧠 A perguntar à Alma…");
    setAnswer("");
    try {
      const almaResp = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, user_id: USER_ID }),
      });
      if (!almaResp.ok) {
        const txt = await almaResp.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        return;
      }
      const almaJson = (await almaResp.json()) as { answer?: string };
      const out = (almaJson.answer || "").trim();
      setAnswer(out);
      setLog((l) => [...l, { role: "alma", text: out }]);
      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setStatus("🧠 A perguntar à Alma…");
    setTranscript(q);
    setLog((l) => [...l, { role: "you", text: q }]);
    setAnswer("");
    setTyped("");

    try {
      const almaResp = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, user_id: USER_ID }),
      });
      if (!almaResp.ok) {
        const txt = await almaResp.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        return;
      }
      const almaJson = (await almaResp.json()) as { answer?: string };
      const out = (almaJson.answer || "").trim();
      setAnswer(out);
      setLog((l) => [...l, { role: "alma", text: out }]);
      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // Touch handlers (hold)
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    startHold();
  }
  function onHoldEnd(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    stopHold();
  }

  function copyOne(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setStatus("Copiado.");
      setTimeout(() => setStatus("Pronto"), 900);
    });
  }

  // ---------- UI ----------
  return (
    <main
      style={{
        maxWidth: 980,
        margin: "0 auto",
        padding: 16,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
        color: colors.fg,
        background: colors.bg,
        minHeight: "100vh",
      }}
    >
      {/* AVATAR */}
      <div
        style={{
          width: "100%",
          height: 520,
          marginBottom: 16,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          overflow: "hidden",
          background: colors.panel,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
        }}
      >
        <AvatarCanvas audioLevelRef={audioLevelRef} />
      </div>

      {/* player TTS no DOM (hidden-ish) */}
      <audio id="tts-audio" style={{ width: 0, height: 0, opacity: 0 }} />

      {/* STATUS — sem borda e centrado */}
      <div
        style={{
          marginBottom: 12,
          padding: "6px 8px",
          border: "none",
          borderRadius: 10,
          background: "transparent",
          color: colors.fgDim,
          textAlign: "center",
          fontWeight: 500,
          minHeight: 24,
        }}
      >
        {status}
      </div>

      {/* Controlo de micro — dois botões, centrados */}
      <div style={{ display: "flex", gap: 14, justifyContent: "center", alignItems: "center", marginBottom: 16 }}>
        {/* Botão redondo amarelo */}
        <button
          onMouseDown={onHoldStart}
          onMouseUp={onHoldEnd}
          onTouchStart={onHoldStart}
          onTouchEnd={onHoldEnd}
          style={{
            ...btnPrimary,
            width: 72,
            height: 72,
            borderRadius: "50%",
            padding: 0,
            fontSize: 12,
            background: isRecording ? "#8b0000" : colors.accent,
            color: isRecording ? "#fff" : "#000",
            display: "grid",
            placeItems: "center",
          }}
          title={firstPressDone ? (isRecording ? "A gravar… solta para enviar" : "Segurar para falar") : "Falar com a Alma"}
        >
          <div style={{ textAlign: "center", lineHeight: 1.1 }}>
            {firstPressDone ? (isRecording ? "A gravar" : "🎤") : "Falar"}
          </div>
        </button>

        {/* Botão “parar” quadrado */}
        <button
          onClick={() => {
            const a = ttsAudioRef.current;
            if (a) {
              a.pause();
              a.currentTime = 0;
            }
          }}
          style={{
            ...btnSubtle,
            width: 56,
            height: 56,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            fontSize: 18,
          }}
          title="Interromper fala"
        >
          ⏹️
        </button>
      </div>

      {/* Entrada por texto — sem borda e centrado */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, alignItems: "stretch", justifyContent: "center" }}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="perguntar à alma"
          style={{
            flex: "0 1 720px",
            padding: "14px 14px",
            borderRadius: 12,
            border: "none",
            background: "transparent",
            color: colors.fg,
            outline: "none",
            textAlign: "center",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendTyped();
          }}
        />
      </div>

      {/* Conversa — estilo tipo “bubbles” como no alma-chat, com ‘copiar’ por balão */}
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 14,
          padding: 14,
          background: colors.panel,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
        }}
      >
        {/* Último turno (mantido) */}
        <div
          style={{
            marginBottom: 12,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
          }}
        >
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 10,
              background: colors.panel2,
            }}
          >
            <div style={{ fontWeight: 600, color: colors.fgDim, marginBottom: 6 }}>Tu (último):</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{transcript || "—"}</div>
          </div>
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 10,
              background: colors.panel2,
            }}
          >
            <div style={{ fontWeight: 600, color: colors.fgDim, marginBottom: 6 }}>Alma (último):</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{answer || "—"}</div>
          </div>
        </div>

        {/* Histórico */}
        <div>
          <div style={{ fontWeight: 600, color: colors.fgDim, marginBottom: 10 }}>Histórico</div>
          {log.length === 0 && <div style={{ opacity: 0.6 }}>—</div>}
          <div style={{ display: "grid", gap: 10 }}>
            {log.map((m, i) => {
              const right = m.role === "alma";
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: right ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      maxWidth: "720px",
                      padding: "12px 14px",
                      borderRadius: 14,
                      border: `1px solid rgba(255,255,255,0.06)`,
                      background: right ? colors.bubbleAlma : colors.bubbleUser,
                      color: colors.fg,
                      whiteSpace: "pre-wrap",
                      boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
                    }}
                  >
                    <div style={{ fontSize: 12, color: colors.fgDim, marginBottom: 6 }}>
                      {m.role === "you" ? "Tu" : "Alma"}
                    </div>
                    {m.text}
                    <button
                      onClick={() => copyOne(m.text)}
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        fontSize: 11,
                        padding: "4px 8px",
                        borderRadius: 8,
                        border: `1px solid ${colors.border}`,
                        background: "#121217",
                        color: colors.fgDim,
                        cursor: "pointer",
                      }}
                      title="Copiar"
                    >
                      copiar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
