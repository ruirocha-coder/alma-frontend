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

  // helpers base
  const btnPrimaryRound: React.CSSProperties = {
    width: 80,
    height: 80,
    borderRadius: 999,
    border: "0",
    background: colors.accent,
    color: "#000",
    fontSize: 28,
    fontWeight: 700,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    boxShadow: "0 10px 28px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.25)",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
  };

  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");

  const [log, setLog] = useState<LogItem[]>([]);

  // --- Audio / Recorder
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const isPressingRef = useRef(false);

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

  // desbloqueio de áudio iOS + ref do <audio>
  useEffect(() => {
    const el = document.getElementById("tts-audio") as HTMLAudioElement | null;
    if (el) {
      ttsAudioRef.current = el;
      (el as any).playsInline = true;
      el.autoplay = false;
      el.preload = "auto";
      el.crossOrigin = "anonymous";
    }

    const unlock = async () => {
      const a = ttsAudioRef.current;
      try {
        if (a) {
          a.muted = true;
          await a.play().catch(() => {});
          a.pause();
          a.currentTime = 0;
          a.muted = false;
        }
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
    const have = streamRef.current;
    if (have) {
      setIsArmed(true);
      return have;
    }
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Mantém o botão para falar.");
      return stream;
    } catch {
      setStatus("⚠️ Permissão do micro negada. Ativa nas definições do navegador.");
      return null;
    }
  }

  async function startRecording() {
    if (!streamRef.current) return;
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

  function stopRecording() {
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

  async function sendTyped(typed: string, setTyped: (v: string) => void) {
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

  // --- Botão Único: lógica de press/hold + interrupção TTS
  function isSpeaking() {
    const a = ttsAudioRef.current;
    return !!a && !a.paused && !a.ended && a.currentTime > 0;
  }

  async function onPressDown() {
    isPressingRef.current = true;

    // desbloqueio áudio imediato
    try {
      const a = ttsAudioRef.current;
      if (a) {
        await a.play().catch(() => {});
        a.pause();
        a.currentTime = 0;
      }
    } catch {}

    // se estiver a falar → interromper e NÃO começar a gravar neste toque
    if (isSpeaking()) {
      const a = ttsAudioRef.current!;
      a.pause();
      a.currentTime = 0;
      setStatus("⏹️ Interrompido");
      return;
    }

    // pedir micro (primeira vez) e, se ainda estiver a pressionar, arrancar gravação
    const s = await requestMic();
    if (s && isPressingRef.current) {
      await startRecording();
    }
  }

  function onPressUp() {
    isPressingRef.current = false;
    stopRecording();
  }

  function copyLog() {
    const txt = log.map((l) => (l.role === "you" ? "Tu: " : "Alma: ") + l.text).join("\n");
    navigator.clipboard.writeText(txt).then(() => {
      setStatus("Histórico copiado.");
      setTimeout(() => setStatus("Pronto"), 1200);
    });
  }

  // ---------- UI ----------
  const [typed, setTyped] = useState("");

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
          marginBottom: 12,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          overflow: "hidden",
          background: colors.panel,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
          display: "grid",
          placeItems: "stretch",
        }}
      >
        <AvatarCanvas audioLevelRef={audioLevelRef} />
      </div>

      {/* player TTS no DOM (hidden) */}
      <audio id="tts-audio" style={{ width: 0, height: 0, opacity: 0 }} />

      {/* STATUS — invisível (sem borda), texto centrado */}
      <div
        style={{
          margin: "6px 0 8px 0",
          padding: "6px 0",
          border: "none",
          background: colors.bg,
          color: colors.fgDim,
          textAlign: "center",
          minHeight: 22,
        }}
      >
        {status}
      </div>

      {/* Botão ÚNICO — centrado */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
        <button
          aria-label={isRecording ? "A gravar… solta para enviar" : "Segurar para falar / tocar para interromper"}
          onPointerDown={onPressDown}
          onPointerUp={onPressUp}
          onPointerCancel={onPressUp}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            ...btnPrimaryRound,
            background: isRecording ? "#8b0000" : colors.accent,
            color: isRecording ? "#fff" : "#000",
          }}
        >
          {isRecording ? "◉" : "🎤"}
        </button>
      </div>

      {/* Entrada por texto */}
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
            if (e.key === "Enter") sendTyped(typed, setTyped);
          }}
        />
        <button
          onClick={() => sendTyped(typed, setTyped)}
          style={{
            width: 120,
            borderRadius: 10,
            border: "0",
            background: colors.accent,
            color: "#000",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Enviar
        </button>
      </div>

      {/* Conversa — só “bubbles” + Copiar no canto inferior direito */}
      <div
        style={{
          position: "relative",
          border: `1px solid ${colors.border}`,
          borderRadius: 14,
          padding: 14,
          background: colors.panel,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
        }}
      >
        {/* botão copiar no canto inferior direito */}
        <button
          onClick={copyLog}
          style={{
            position: "absolute",
            right: 12,
            bottom: 10,
            fontSize: 12,
            color: colors.fgDim,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 4,
          }}
          title="Copiar"
        >
          Copiar
        </button>

        {/* Histórico */}
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
