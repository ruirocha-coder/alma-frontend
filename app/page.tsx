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
  const btnPrimaryRound: React.CSSProperties = {
    ...btnBase,
    borderRadius: 999,
    width: 160,
    height: 160,
    fontSize: 16,
    fontWeight: 700,
    background: colors.accent,
    color: "#000",
    borderColor: "rgba(0,0,0,0.35)",
    display: "grid",
    placeItems: "center",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  };

  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");
  const [typed, setTyped] = useState("");

  const [log, setLog] = useState<LogItem[]>([]);

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

  // “latch” para 1º toque
  const firstArmDoneRef = useRef(false);

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

  // garante que o áudio está “unlocked” (iOS/Chrome mobile)
  async function ensureAudioUnlocked() {
    const a = ttsAudioRef.current;
    if (!a) return;
    try {
      a.muted = true;
      (a as any).playsInline = true;
      a.autoplay = false;
      a.preload = "auto";
      await a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;
      a.muted = false;

      const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
      if (AC && !audioCtxRef.current) audioCtxRef.current = new AC();
    } catch {}
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
    return () => {
      if (meterRAF.current) cancelAnimationFrame(meterRAF.current);
      try {
        audioCtxRef.current?.close();
      } catch {}
    };
  }, []);

  // --- Micro
  async function requestMic() {
    try {
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
    if (!isArmed) {
      return;
    }
    if (!streamRef.current) {
      setStatus("⚠️ Micro não está pronto. Toca no botão para ativar.");
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

  // ---------- Botão único (pointer handlers)
  async function handlePointerDown(e: React.PointerEvent) {
    e.preventDefault();

    // se a Alma estiver a falar, 1º toque interrompe
    const a = ttsAudioRef.current;
    if (a && !a.paused) {
      a.pause();
      a.currentTime = 0;
      setStatus("Pronto");
      return; // este toque serviu para interromper
    }

    // 1º toque: desbloqueia áudio + pede micro e sai
    if (!isArmed) {
      setStatus("A preparar áudio e micro…");
      await ensureAudioUnlocked();
      await requestMic();
      firstArmDoneRef.current = true;
      setStatus("Micro pronto. Mantém o botão para falar.");
      return; // importante: não começa a gravar neste gesto
    }

    // Já armado → iniciar gravação ao “segurar”
    startHold();
  }

  function handlePointerUp(e: React.PointerEvent) {
    e.preventDefault();
    if (isRecording) {
      stopHold();
    }
  }

  function copyLog() {
    const txt = log.map((l) => (l.role === "you" ? "Tu: " : "Alma: ") + l.text).join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setStatus("Histórico copiado.");
      setTimeout(() => setStatus("Pronto"), 1200);
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

      {/* STATUS — invisível (sem borda), texto centrado */}
      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          border: "none",
          borderRadius: 10,
          background: colors.bg, // igual ao fundo → invisível
          color: colors.fgDim,
          textAlign: "center",
        }}
      >
        {status}
      </div>

      {/* Botão único, centrado */}
      <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
        <button
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
          style={{
            ...btnPrimaryRound,
            background: isRecording ? "#8b0000" : colors.accent,
            color: isRecording ? "#fff" : "#000",
            touchAction: "none",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {isArmed ? (isRecording ? "A gravar…\nsolta para enviar" : "Segurar para falar") : "Falar com a Alma"}
        </button>
      </div>

      {/* Entrada por texto (mantida) */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 18,
          alignItems: "stretch",
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Escreve aqui para perguntar à Alma…"
          style={{
            flex: 1,
            padding: "14px 14px",
            borderRadius: 12,
            border: `1px solid ${colors.border}`,
            background: "#101014",
            color: colors.fg,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendTyped();
          }}
        />
        <button
          onClick={sendTyped}
          style={{
            ...btnBase,
            background: colors.accent,
            color: "#000",
            borderColor: "rgba(0,0,0,0.35)",
            fontWeight: 600,
            minWidth: 120,
            borderRadius: 12,
          }}
        >
          Enviar
        </button>
      </div>

      {/* Conversa — painel único tipo “bubbles” (sem ‘Último’/‘Histórico’) */}
      <div
        style={{
          position: "relative",
          border: `1px solid ${colors.border}`,
          borderRadius: 14,
          padding: 14,
          background: colors.panel,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
          minHeight: 120,
        }}
      >
        {/* Botão Copiar no canto inferior direito (estilo do alma-chat) */}
        <button
          onClick={copyLog}
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            fontSize: 12,
            color: colors.fgDim,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 6,
          }}
          title="Copiar histórico"
        >
          Copiar
        </button>

        {/* Bubbles */}
        <div style={{ display: "grid", gap: 10 }}>
          {log.length === 0 && (
            <div style={{ opacity: 0.6, color: colors.fgDim }}>Sem mensagens ainda.</div>
          )}
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
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
