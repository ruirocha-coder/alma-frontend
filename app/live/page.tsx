"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * /live — igual ao teu fluxo atual (STT -> ALMA -> TTS),
 * mas isolado do / (não toca no que já funciona),
 * com:
 *  - botão "Interromper" para parar a fala da Alma
 *  - histórico copiável da conversa
 */

type Msg = { role: "you" | "alma"; text: string; ts: number };

export default function LivePage() {
  // --- UI state
  const [status, setStatus] = useState<string>("Pronto");
  const [isArmed, setIsArmed] = useState(false); // micro ativado
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [answer, setAnswer] = useState<string>("");

  // entrada por texto
  const [typed, setTyped] = useState("");

  // histórico simples
  const [history, setHistory] = useState<Msg[]>([]);

  // --- Audio / Recorder refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // Audio element para TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria o <audio> de TTS uma vez
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // desbloqueio de áudio no iOS
    const unlockAudio = () => {
      if (!ttsAudioRef.current) return;
      try {
        ttsAudioRef.current.muted = true;
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
    };
  }, []);

  // helpers
  function pushHistory(role: Msg["role"], text: string) {
    if (!text) return;
    setHistory((h) => [...h, { role, text, ts: Date.now() }]);
  }

  async function requestMic() {
    try {
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
    } catch {
      setStatus(
        "⚠️ Permissão do micro negada. Ativa o acesso ao micro nas definições do navegador."
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
      pushHistory("you", said);
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Tenta falar mais perto do micro.");
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
      pushHistory("alma", out);

      // 3) TTS
      setStatus("🔊 A falar…");
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
        body: JSON.stringify({ text }),
        // evita cache intermédia que por vezes atrasa o áudio
        cache: "no-store",
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

      audio.pause();
      audio.src = url;

      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // interromper fala da Alma
  function interruptSpeech() {
    const a = ttsAudioRef.current;
    if (a) {
      try {
        a.pause();
        a.currentTime = 0;
        a.src = ""; // libera URL e pára qualquer reprodução pendente
      } catch {}
    }
  }

  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setStatus("🧠 A perguntar à Alma…");
    setTranscript(q);
    setAnswer("");
    pushHistory("you", q);

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
      pushHistory("alma", out);

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

  function copyHistory() {
    const text = history
      .map((m) => `${m.role === "you" ? "Tu" : "Alma"}: ${m.text}`)
      .join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => setStatus("📋 Histórico copiado"))
      .catch(() => setStatus("⚠️ Não foi possível copiar"));
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
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Live (isolado)</h1>
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

        <button
          onClick={interruptSpeech}
          title="Interromper fala da Alma"
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#552222",
            color: "#fff",
          }}
        >
          ⏹️ Interromper
        </button>

        <button
          onClick={copyHistory}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#333",
            color: "#fff",
          }}
        >
          📋 Copiar histórico
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

      {/* Histórico copiável */}
      <div
        style={{
          border: "1px dashed #444",
          borderRadius: 12,
          padding: 12,
          background: "#0b0b0b",
        }}
      >
        <div style={{ fontWeight: 600, color: "#aaa", marginBottom: 8 }}>Histórico</div>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.5 }}>
          {history.length
            ? history
                .map((m) => `${m.role === "you" ? "Tu" : "Alma"}: ${m.text}`)
                .join("\n")
            : "—"}
        </div>
      </div>
    </main>
  );
}
