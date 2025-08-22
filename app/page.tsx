"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Página simples:
 * - Botão "Ativar micro" (1º toque para pedir permissão)
 * - Botão "Segurar para falar" (hold-to-talk). Envia áudio para /api/stt, pergunta ao Alma (/api/alma)
 *   e faz TTS com /api/tts.
 * - Caixa de texto para perguntar por escrito (também responde em voz).
 *
 * Requisitos no backend já existentes:
 *  - POST /api/stt  -> multipart/form-data { audio: File, language?: "pt-PT" }
 *  - POST /api/alma -> JSON { question: string }  -> { answer: string }
 *  - POST /api/tts  -> JSON { text: string }      -> retorna audio/mpeg (ArrayBuffer)
 */

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false); // micro ativado
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");

  // entrada por texto
  const [typed, setTyped] = useState("");

  // também controlamos se está a falar (para interromper)
  const [isSpeaking, setIsSpeaking] = useState(false);

  // --- Audio / Recorder refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // Audio element para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // Extras para tornar áudio robusto em iOS e poder interromper
  const ttsObjectUrlRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSrcRef = useRef<AudioBufferSourceNode | null>(null);

  async function ensureAudioContextUnlocked() {
    try {
      if (!audioCtxRef.current) {
        const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new AC();
      }
      if (audioCtxRef.current.state !== "running") {
        await audioCtxRef.current.resume();
      }
    } catch {}
  }

  // cria o <audio> de TTS uma vez (mantendo o teu desbloqueio por gesto)
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS
    a.autoplay = false;
    a.preload = "auto";
    a.onended = () => {
      // limpeza quando termina fala via <audio>
      if (ttsObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(ttsObjectUrlRef.current);
        } catch {}
        ttsObjectUrlRef.current = null;
      }
      setIsSpeaking(false);
    };
    ttsAudioRef.current = a;

    // desbloqueio de áudio no iOS: preparar um pequeno som silencioso on user-gesture
    const unlockAudio = async () => {
      await ensureAudioContextUnlocked();
      if (!ttsAudioRef.current) return;
      try {
        ttsAudioRef.current.muted = true;
        await ttsAudioRef.current.play().catch(() => {});
        ttsAudioRef.current.pause();
        ttsAudioRef.current.currentTime = 0;
        ttsAudioRef.current.muted = false;
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

  // retoma o AudioContext quando a aba volta a ficar visível (iOS “adormece” o contexto)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        ensureAudioContextUnlocked();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  function stopSpeaking() {
    // parar <audio>
    const audio = ttsAudioRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
        if (ttsObjectUrlRef.current) {
          URL.revokeObjectURL(ttsObjectUrlRef.current);
          ttsObjectUrlRef.current = null;
        }
        // limpar src para que o browser não mantenha contexto preso
        audio.src = "";
      } catch {}
    }
    // parar WebAudio
    if (currentSrcRef.current) {
      try {
        currentSrcRef.current.stop();
      } catch {}
      try {
        currentSrcRef.current.disconnect();
      } catch {}
      currentSrcRef.current = null;
    }
    setIsSpeaking(false);
  }

  // --- Helpers

  async function requestMic() {
    try {
      await ensureAudioContextUnlocked();
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

  function startHold() {
    // 1º toque arma o micro
    if (!isArmed) {
      requestMic();
      return;
    }
    if (!streamRef.current) {
      setStatus("⚠️ Micro não está pronto. Carrega primeiro em 'Ativar micro'.");
      return;
    }
    try {
      ensureAudioContextUnlocked();
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
      // 1) STT
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
      stopSpeaking(); // garantir que nada está a tocar
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  async function speak(text: string) {
    if (!text) return;

    await ensureAudioContextUnlocked();
    stopSpeaking();

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
      setIsSpeaking(true);

      // 1) tenta <audio> com blob/url
      try {
        if (ttsObjectUrlRef.current) {
          URL.revokeObjectURL(ttsObjectUrlRef.current);
          ttsObjectUrlRef.current = null;
        }
        const blob = new Blob([ab], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = ttsAudioRef.current!;
        audio.src = url;
        ttsObjectUrlRef.current = url;

        await audio.play();
        return; // se tocar, terminamos aqui
      } catch {
        // cai para WebAudio
      }

      // 2) fallback: WebAudio (mais robusto no iOS)
      const ctx = audioCtxRef.current!;
      const buf = await new Promise<AudioBuffer>((resolve, reject) => {
        // decodeAudioData com callbacks legacy é mais compatível em Safari
        // @ts-ignore
        ctx.decodeAudioData(ab.slice(0), resolve, reject);
      });

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      currentSrcRef.current = src;
      src.onended = () => {
        currentSrcRef.current = null;
        setIsSpeaking(false);
      };
      src.start(0);
    } catch (e: any) {
      setIsSpeaking(false);
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    await ensureAudioContextUnlocked();
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
      stopSpeaking();
      await speak(out);
      setStatus("Pronto");
      setTyped("");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
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

      {/* Controlo de micro */}
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

        {/* Testar voz (prime áudio e debug rápido) */}
        <button
          onClick={async () => {
            await ensureAudioContextUnlocked();
            stopSpeaking();
            speak("Teste de voz da Alma. Se ouves isto, o áudio está desbloqueado.");
          }}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#2b2bff",
            color: "#fff",
          }}
        >
          Testar voz
        </button>

        {/* Interromper fala atual */}
        <button
          onClick={stopSpeaking}
          disabled={!isSpeaking}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isSpeaking ? "#663300" : "#222",
            color: isSpeaking ? "#FFD7A1" : "#777",
          }}
          title="Interromper fala"
        >
          ⏹️ Parar fala
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
          background: "#0b0b0b",
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
    </main>
  );
}
