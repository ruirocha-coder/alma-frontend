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

/* =======================================================
   TTS sem ler links
   - Remove apenas do texto ENVIADO ao /api/tts
   - NÃO mexe no texto mostrado no ecrã (log)
   ======================================================= */
function stripLinksForVoice(text: string): string {
  if (!text) return "";
  let t = String(text);

  // 1) Remove secção final "Links dos produtos:"
  t = t.replace(/\n?\s*Links dos produtos\s*:\s*\n[\s\S]*$/i, "");

  // 2) Markdown links: [texto](url) -> texto
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1");

  // 3) URLs soltas
  t = t.replace(/\bhttps?:\/\/[^\s]+/gi, "");
  t = t.replace(/\bwww\.[^\s]+/gi, "");

  // 4) Limpezas
  t = t.replace(/[()[\]{}<>]/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

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
    padding: "12px 18px",
    borderRadius: 999,
    border: `1px solid rgba(0,0,0,0.35)`,
    background: colors.accent,
    color: "#000",
    cursor: "pointer",
    fontWeight: 700,
    letterSpacing: 0.2,
  };

  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [typed, setTyped] = useState<string>("");
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
  const audioPrimedRef = useRef<boolean>(false); // evita duplo toque
  const ttsUrlRef = useRef<string | null>(null); // para revogar URL anterior

  // ---------- PRIME/UNLOCK ÁUDIO (resolve “duplo toque”)
  function makeSilentWavDataURL(ms = 80, sampleRate = 8000) {
    const samples = Math.max(1, Math.floor((ms / 1000) * sampleRate));
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples * blockAlign;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    let o = 0;
    const W = (s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i));
    };
    const U32 = (v: number) => {
      view.setUint32(o, v, true);
      o += 4;
    };
    const U16 = (v: number) => {
      view.setUint16(o, v, true);
      o += 2;
    };

    W("RIFF");
    U32(36 + dataSize);
    W("WAVE");
    W("fmt ");
    U32(16);
    U16(1);

    U16(numChannels);
    U32(sampleRate);
    U32(byteRate);
    U16(blockAlign);
    U16(16);

    W("data");
    U32(dataSize);
    for (let i = 0; i < dataSize; i++) view.setInt8(o++, 0);

    const blob = new Blob([buffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }

  async function ensureAudioReady() {
    if (audioPrimedRef.current) return;

    const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
    if (AC && !audioCtxRef.current) audioCtxRef.current = new AC();
    try {
      await audioCtxRef.current?.resume();
    } catch {}

    const el = ttsAudioRef.current;
    if (el) {
      try {
        const url = makeSilentWavDataURL(80);
        el.src = url;
        el.muted = true;
        await el.play().catch(() => {});
        el.pause();
        el.currentTime = 0;
        el.muted = false;
        URL.revokeObjectURL(url);
      } catch {}
    }
    audioPrimedRef.current = true;
  }

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

    // Desbloqueio no primeiro gesto (tap/click)
    const onFirstGesture = async () => {
      await ensureAudioReady();
    };
    document.addEventListener("pointerdown", onFirstGesture, { once: true });

    return () => {
      document.removeEventListener("pointerdown", onFirstGesture);
      if (meterRAF.current) cancelAnimationFrame(meterRAF.current);
      try {
        audioCtxRef.current?.close();
      } catch {}
      // revogar URL de áudio se existir
      if (ttsUrlRef.current) {
        try {
          URL.revokeObjectURL(ttsUrlRef.current);
        } catch {}
        ttsUrlRef.current = null;
      }
    };
  }, []);

  // --- Micro
  async function requestMic() {
    await ensureAudioReady();
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
    // Se a Alma estiver a falar, tocar no botão interrompe
    const a = ttsAudioRef.current;
    if (a && !a.paused && !a.ended) {
      a.pause();
      a.currentTime = 0;
      setStatus("Pronto");
      return;
    }

    // 1º toque: ativa micro; depois segurar grava
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

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";

      const mr = new MediaRecorder(streamRef.current, { mimeType: mime });
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
        setStatus("⚠️ STT " + sttResp.status + ": " + txt.slice(0, 200));
        return;
      }

      const sttJson = (await sttResp.json()) as { transcript?: string; error?: string };
      const said = (sttJson.transcript || "").trim();

      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Fala mais perto do micro.");
        return;
      }

      setLog((l) => [...l, { role: "you", text: said }]);
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  async function speak(text: string) {
    if (!text) return;

    // Só para TTS: remove links
    const voiceText = stripLinksForVoice(text);
    if (!voiceText) return;

    try {
      await ensureAudioReady();

      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: voiceText }),
      });

      if (!r.ok) {
        const txt = await r.text();
        setStatus(`⚠️ Erro no /api/tts: ${r.status} ${txt.slice(0, 200)}`);
        return;
      }

      const ab = await r.arrayBuffer();
      const blob = new Blob([ab], { type: "audio/mpeg" });

      // revoga URL anterior para evitar leaks
      if (ttsUrlRef.current) {
        try {
          URL.revokeObjectURL(ttsUrlRef.current);
        } catch {}
        ttsUrlRef.current = null;
      }

      const url = URL.createObjectURL(blob);
      ttsUrlRef.current = url;

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

      if (out) setLog((l) => [...l, { role: "alma", text: out }]);

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
    setTyped("");
    setLog((l) => [...l, { role: "you", text: q }]);
    await askAlma(q);
  }

  // Touch handlers (hold)
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    ensureAudioReady().finally(() => startHold());
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
          marginBottom: 10,
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

      {/* STATUS — invisível, sem borda e texto centrado */}
      <div
        style={{
          marginBottom: 16,
          padding: "6px 8px",
          border: "none",
          borderRadius: 0,
          background: colors.bg,
          color: colors.fgDim,
          textAlign: "center",
          minHeight: 20,
        }}
      >
        {status}
      </div>

      {/* Botão único horizontal */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
        <button
          onMouseDown={onHoldStart}
          onMouseUp={onHoldEnd}
          onTouchStart={onHoldStart}
          onTouchEnd={onHoldEnd}
          style={{
            ...btnBase,
            width: 320,
            maxWidth: "92%",
            height: 52,
            background: isRecording ? "#8b0000" : colors.accent,
            color: isRecording ? "#fff" : "#000",
            fontSize: 16,
          }}
          aria-label="Segurar para falar"
          title="Segurar para falar"
        >
          {isRecording ? "A gravar… solta para enviar" : "Segurar para falar"}
        </button>
      </div>

      {/* Caixa de texto → voz */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendTyped();
          }}
          placeholder="Escrever para a Alma…"
          style={{
            width: 680,
            maxWidth: "95%",
            padding: "12px 14px",
            border: "none",
            outline: "none",
            borderRadius: 999,
            background: "transparent",
            color: "#cfcfd3",
            textAlign: "center",
          }}
        />
      </div>

      {/* Conversa */}
      <div
        style={{
          position: "relative",
          border: `1px solid ${colors.border}`,
          borderRadius: 14,
          padding: 14,
          background: colors.panel,
          boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px rgba(0,0,0,0.25)",
          minHeight: 80,
        }}
      >
        <div style={{ display: "grid", gap: 10 }}>
          {log.length === 0 && <div style={{ opacity: 0.6 }}>—</div>}
          {log.map((m, i) => {
            const right = m.role === "alma";
            return (
              <div key={i} style={{ display: "flex", justifyContent: right ? "flex-end" : "flex-start" }}>
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

        <button
          onClick={copyLog}
          style={{
            position: "absolute",
            right: 10,
            bottom: 10,
            fontSize: 12,
            background: "transparent",
            border: "none",
            color: colors.fgDim,
            cursor: "pointer",
            padding: 6,
          }}
          title="Copiar histórico"
        >
          copiar
        </button>
      </div>
    </main>
  );
}
