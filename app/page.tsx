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

type Msg = { role: "you" | "alma"; text: string };

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false); // micro ativado
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");

  // histórico para o utilizador copiar
  const [history, setHistory] = useState<Msg[]>([]);

  // entrada por texto
  const [typed, setTyped] = useState("");

  // opcional: modo rápido (falar 1ª frase logo que possível)
  const [fastMode, setFastMode] = useState(false);

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

  // para cancelar sequências de fala (modo rápido)
  const speakSessionIdRef = useRef<number>(0);

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

  // cria o <audio> de TTS uma vez
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS
    a.autoplay = false;
    a.preload = "auto";
    a.onended = () => {
      if (ttsObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(ttsObjectUrlRef.current);
        } catch {}
        ttsObjectUrlRef.current = null;
      }
      setIsSpeaking(false);
    };
    ttsAudioRef.current = a;

    // desbloqueio de áudio no iOS por gesto
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

  // retoma o AudioContext quando a aba volta a ficar visível
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
    // cancelar cadeia de fala
    speakSessionIdRef.current++;
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
      setHistory((h) => [...h, { role: "you", text: said }]);

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
      setHistory((h) => [...h, { role: "alma", text: out }]);
      setStatus("🔊 A falar…");

      // 3) TTS
      stopSpeaking();
      if (fastMode) {
        await speakSequential(out);
      } else {
        await speak(out);
      }
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // Fala “normal” (1 pedido /api/tts)
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

      // 1) tenta <audio>
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
        return;
      } catch {
        // fallback abaixo
      }

      // 2) fallback WebAudio
      const ctx = audioCtxRef.current!;
      const buf = await new Promise<AudioBuffer>((resolve, reject) => {
        // @ts-ignore (Safari legacy)
        ctx.decodeAudioData(ab.slice(0), resolve, reject);
      });

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      currentSrcRef.current = src;
      setIsSpeaking(true);
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

  // “Modo rápido”: divide em frases e fala por partes
  async function speakSequential(text: string) {
    const id = ++speakSessionIdRef.current;

    const parts = splitIntoSentences(text);
    if (parts.length === 0) return;

    setIsSpeaking(true);

    // toca sequencialmente; se stopSpeaking() for chamado, o id deixa de bater certo
    for (let i = 0; i < parts.length; i++) {
      if (speakSessionIdRef.current !== id) break;

      const chunk = parts[i];
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunk }),
        });
        if (!r.ok) {
          // se falhar uma parte, tentamos seguir em frente
          continue;
        }
        const ab = await r.arrayBuffer();

        // tentar <audio>
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

          await ensureAudioContextUnlocked();

          await new Promise<void>((resolve, reject) => {
            const onEnd = () => {
              audio.removeEventListener("ended", onEnd);
              resolve();
            };
            audio.addEventListener("ended", onEnd, { once: true });
            audio.play().catch(reject);
          });
        } catch {
          // fallback WebAudio
          const ctx = audioCtxRef.current!;
          const buf = await new Promise<AudioBuffer>((resolve, reject) => {
            // @ts-ignore
            ctx.decodeAudioData(ab.slice(0), resolve, reject);
          });
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          currentSrcRef.current = src;
          await new Promise<void>((resolve) => {
            src.onended = () => {
              currentSrcRef.current = null;
              resolve();
            };
            src.start(0);
          });
        }
      } catch {
        // ignora e segue
      }
    }

    // terminar estado de fala
    if (speakSessionIdRef.current === id) {
      setIsSpeaking(false);
    }
  }

  function splitIntoSentences(text: string): string[] {
    // divide por pontos/interrogações/exclamações, preservando frases curtas agregadas
    const raw = text
      .split(/([.!?…])\s+/)
      .reduce<string[]>((acc, cur, i, arr) => {
        if (/[.!?…]/.test(cur) && acc.length) {
          acc[acc.length - 1] = acc[acc.length - 1] + cur;
        } else if (cur.trim()) {
          acc.push(cur.trim());
        }
        return acc;
      }, []);

    // junta frases muito curtas para evitar muitos pedidos
    const merged: string[] = [];
    let buffer = "";
    for (const s of raw) {
      if ((buffer + " " + s).trim().length < 140) {
        buffer = (buffer ? buffer + " " : "") + s;
      } else {
        if (buffer) merged.push(buffer);
        buffer = s;
      }
    }
    if (buffer) merged.push(buffer);
    return merged;
  }

  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    await ensureAudioContextUnlocked();
    setStatus("🧠 A perguntar à Alma…");
    setTranscript(q);
    setAnswer("");
    setHistory((h) => [...h, { role: "you", text: q }]);

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
      stopSpeaking();
      if (fastMode) {
        await speakSequential(out);
      } else {
        await speak(out);
      }
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

  function copyHistory() {
    const text = history
      .map((m) => (m.role === "you" ? "Tu: " : "Alma: ") + m.text)
      .join("\n");
    navigator.clipboard
      .writeText(text || "—")
      .then(() => setStatus("Histórico copiado 📋"))
      .catch(() => setStatus("⚠️ Não consegui copiar."));
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

      {/* Controlo de micro + ações */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
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

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          <input
            type="checkbox"
            checked={fastMode}
            onChange={(e) => setFastMode(e.target.checked)}
          />
          Modo rápido (fala por frases)
        </label>
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

      {/* Conversa simples (mostra o último turno + histórico completo com copiar) */}
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

      {/* Histórico completo + copiar */}
      <div
        style={{
          border: "1px dashed #444",
          borderRadius: 12,
          padding: 12,
          background: "#0b0b0b",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Histórico</div>
          <button
            onClick={copyHistory}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #444",
              background: "#1d1d1d",
              color: "#ddd",
            }}
          >
            Copiar histórico
          </button>
        </div>
        <div
          style={{
            maxHeight: 240,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {history.length === 0 ? (
            <div style={{ opacity: 0.6 }}>Sem mensagens ainda…</div>
          ) : (
            history.map((m, i) => (
              <div key={i} style={{ whiteSpace: "pre-wrap" }}>
                <span style={{ color: "#888" }}>{m.role === "you" ? "Tu" : "Alma"}:</span>{" "}
                {m.text}
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}
