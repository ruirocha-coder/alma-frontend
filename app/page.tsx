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

  // --- Audio / Recorder refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // Audio element para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastObjectUrlRef = useRef<string | null>(null);

  // cria o <audio> de TTS uma vez
  useEffect(() => {
    const a = new Audio();
    // Safari iOS: a propriedade playsInline não existe no tipo TS de <audio>,
    // forçamos via cast para não falhar no build.
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    a.volume = 1;
    a.muted = false;

    // liberta o objectURL quando o áudio terminar
    a.addEventListener("ended", () => {
      try {
        if (lastObjectUrlRef.current) {
          URL.revokeObjectURL(lastObjectUrlRef.current);
          lastObjectUrlRef.current = null;
        }
      } catch {}
    });

    ttsAudioRef.current = a;

    // desbloqueio de áudio no iOS: preparar um pequeno som silencioso on user-gesture
    const unlockAudio = () => {
      if (!ttsAudioRef.current) return;
      try {
        ttsAudioRef.current.muted = true;
        // tentativa de play para desbloquear o contexto
        ttsAudioRef.current
          .play()
          .then(() => {
            ttsAudioRef.current!.pause();
            ttsAudioRef.current!.currentTime = 0;
            ttsAudioRef.current!.muted = false;
          })
          .catch(() => {});
      } catch {}
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
    document.addEventListener("click", unlockAudio, { once: true });
    document.addEventListener("touchstart", unlockAudio, { once: true });

    return () => {
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
      try {
        if (lastObjectUrlRef.current) {
          URL.revokeObjectURL(lastObjectUrlRef.current);
          lastObjectUrlRef.current = null;
        }
      } catch {}
    };
  }, []);

  // --- Helpers

  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      // áudio apenas, sem echoCancellation para não distorcer (podes ligar se quiseres)
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

      const mime =
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4"; // fallback para Safari

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
        // se o backend /api/tts aceitar voiceId/model, podes adicionar aqui
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

      // limpa o URL anterior (se existir)
      try {
        if (lastObjectUrlRef.current) {
          URL.revokeObjectURL(lastObjectUrlRef.current);
        }
      } catch {}
      lastObjectUrlRef.current = url;

      const audio = ttsAudioRef.current;
      if (!audio) {
        setStatus("⚠️ Áudio não inicializado.");
        return;
      }

      audio.src = url;
      audio.muted = false;
      audio.volume = 1;

      // força o iOS a preparar a fonte nova antes de play
      try {
        audio.load();
      } catch {}

      try {
        await audio.play();
      } catch (e: any) {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
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
