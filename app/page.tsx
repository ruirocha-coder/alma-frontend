"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);       // micro ativado
  const [isRecording, setIsRecording] = useState(false); // hold-to-talk a gravar?

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Media / refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // player TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsUrlRef = useRef<string | null>(null);

  // cria <audio> TTS uma vez e “desbloqueia” áudio em iOS com gesto do utilizador
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true; // suprime TS no iOS
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // limpar URL quando desmontar
    return () => {
      if (ttsUrlRef.current) {
        try { URL.revokeObjectURL(ttsUrlRef.current); } catch {}
        ttsUrlRef.current = null;
      }
      try { a.pause(); } catch {}
    };
  }, []);

  // -------- Helpers

  function primeAudio() {
    // Desbloqueia áudio em iOS/Safari num gesto do utilizador
    const a = ttsAudioRef.current;
    if (!a) return;
    try {
      a.muted = true;
      a.play()
        .then(() => {
          a.pause();
          a.currentTime = 0;
          a.muted = false;
          console.log("🔓 Áudio ‘primed’");
        })
        .catch(() => {});
    } catch {}
  }

  function stopSpeaking() {
    const a = ttsAudioRef.current;
    if (!a) return;
    try { a.pause(); } catch {}
    try { a.currentTime = 0; } catch {}
  }

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
      setStatus("⚠️ Permissão negada. Ativa o micro nas definições do navegador.");
    }
  }

  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4"; // fallback Safari
    const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
    return mr;
  }

  // -------- TTS robusto
  async function speak(text: string) {
    if (!text) return;
    const audio = ttsAudioRef.current;
    if (!audio) {
      setStatus("⚠️ Áudio não inicializado.");
      return;
    }

    try {
      setStatus("🔊 A preparar voz…");

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);

      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      }).catch((e) => {
        throw new Error("Falha de rede ao chamar /api/tts: " + (e?.message || e));
      });

      clearTimeout(timer);

      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!r.ok) {
        const bodyTxt = await r.text().catch(() => "");
        setStatus(`⚠️ Erro no /api/tts: ${r.status} ${bodyTxt.slice(0, 200)}`);
        console.warn("❌ /api/tts", r.status, ct, bodyTxt);
        return;
      }
      if (!ct.startsWith("audio/")) {
        const bodyTxt = await r.text().catch(() => "");
        setStatus(`⚠️ /api/tts devolveu ${ct}. ${bodyTxt.slice(0, 200)}`);
        console.warn("❌ /api/tts CT inesperado:", ct, bodyTxt);
        return;
      }

      const ab = await r.arrayBuffer();
      if (!ab || ab.byteLength < 512) {
        setStatus("⚠️ O TTS devolveu áudio vazio.");
        console.warn("❌ /api/tts áudio muito pequeno:", ab?.byteLength);
        return;
      }

      // libertar URL anterior
      if (ttsUrlRef.current) {
        try { URL.revokeObjectURL(ttsUrlRef.current); } catch {}
        ttsUrlRef.current = null;
      }

      const blob = new Blob([ab], { type: ct });
      const url = URL.createObjectURL(blob);
      ttsUrlRef.current = url;

      audio.pause();
      audio.currentTime = 0;
      audio.src = url;
      if (typeof (audio as any).load === "function") (audio as any).load();

      setStatus("🔊 A falar…");
      try {
        await audio.play();
      } catch (err) {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca em “🔊 Testar voz” e tenta de novo.");
        console.warn("❌ audio.play falhou:", err);
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
      console.warn("❌ speak exceção:", e);
    }
  }

  // -------- Alma (batch, sem streaming)
  async function askAlma(question: string) {
    setTranscript(question);
    setLog((l) => [...l, { role: "you", text: question }]);
    setStatus("🧠 A perguntar à Alma…");
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000); // 45s para respostas grandes

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

      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // -------- Fluxo “segurar para falar”
  function startHold() {
    if (!isArmed) {
      // primeiro gesto: primeAudio + pedir micro
      primeAudio();
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
      if (!said) {
        setStatus("⚠️ Não consegui transcrever o áudio. Fala um pouco mais perto do micro.");
        return;
      }
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // -------- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // -------- UI handlers
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

      {/* Controlo de micro + TTS */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          onClick={() => { primeAudio(); requestMic(); }}
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
          onClick={() => speak("Olá! Sou a Alma. Se me ouves, a voz está OK.")}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#1b4d1b",
            color: "#fff",
          }}
        >
          🔊 Testar voz
        </button>

        <button
          onClick={stopSpeaking}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#552222",
            color: "#fff",
          }}
        >
          ⏹️ Interromper fala
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

      {/* Push-to-talk */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
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
