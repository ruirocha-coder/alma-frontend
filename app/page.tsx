"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

export default function Page() {
  // ---------- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // ---------- Media / refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // ---------- cria <audio> TTS e “desbloqueia” iOS
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // iOS não tipa isto em TS
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // 1º toque desbloqueia o contexto de áudio no iOS
    const unlock = () => {
      if (!ttsAudioRef.current) return;
      const el = ttsAudioRef.current;
      el.muted = true;
      el.play()
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        })
        .catch(() => {});
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true });

    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
  }, []);

  // ---------- Permissão do micro
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
      setStatus("⚠️ Permissão negada. Ativa o micro nas definições do navegador.");
    }
  }

  // ---------- TTS (com timeout + no-store)
  async function speak(text: string) {
    if (!text) return;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20_000);

      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        cache: "no-store",
      });

      clearTimeout(t);

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
      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ---------- ALMA (com timeout + retry leve)
  async function askAlma(question: string) {
    const q = String(question || "").trim();
    if (!q) return;

    setTranscript(q);
    setLog((l) => [...l, { role: "you", text: q }]);
    setStatus("🧠 A perguntar à Alma…");

    async function fetchWithTimeout(url: string, body: any, ms = 28_000) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
          cache: "no-store",
        });
        return res;
      } finally {
        clearTimeout(t);
      }
    }

    try {
      let r = await fetchWithTimeout("/api/alma", { question: q });

      // retry 1x se a ligação falhou mesmo
      if (!r) {
        try {
          r = await fetchWithTimeout("/api/alma", { question: q }, 28_000);
        } catch {}
      }

      if (!r || !r.ok) {
        const txt = r ? await r.text() : "Ligação falhou";
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        const msg = "⚠️ Não consegui obter resposta agora. Tenta novamente.";
        setAnswer(msg);
        setLog((l) => [...l, { role: "alma", text: "⚠️ Falha temporária. Tenta de novo." }]);
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
      const msg = "⚠️ A rede falhou ou houve timeout. Tenta novamente.";
      setAnswer(msg);
      setLog((l) => [...l, { role: "alma", text: "⚠️ Timeout/rede. Volta a tentar." }]);
    }
  }

  // ---------- Push-to-talk (upload do clip)
  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4"; // fallback Safari
    return new MediaRecorder(streamRef.current!, { mimeType: mime });
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
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Fala mais perto do micro.");
        return;
      }
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // ---------- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // ---------- UI helpers
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

  // ---------- UI
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

      {/* Controlo de micro + hold */}
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

        {/* Botão de teste de voz para desbloquear autoplay no iOS */}
        <button
          onClick={() => speak("Olá! Sou a Alma. Já posso falar contigo.")}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#2b2bff",
            color: "#fff",
          }}
        >
          🔊 Testar voz
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

      {/* Conversa + histórico */}
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
