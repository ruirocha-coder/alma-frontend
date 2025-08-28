"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

// URL do teu WS de STT (ex.: wss://alma-stt-ws-xxxx.up.railway.app/stt)
const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  "";

export default function Page() {
  // ---------------- UI
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false); // push-to-talk
  const [isStreaming, setIsStreaming] = useState(false); // streaming WS
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // ---------------- Áudio base
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null); // upload

  // TTS player e desbloqueio iOS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const isSpeakingRef = useRef(false);

  // ---------------- Streaming (WebAudio → PCM16 → WS)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const workletLoadedRef = useRef(false);

  // Buffer de finais + debounce para enviar uma frase “inteira”
  const finalBufRef = useRef<string[]>([]);
  const finalTimerRef = useRef<number | null>(null);

  function clearFinalTimer() {
    if (finalTimerRef.current) {
      clearTimeout(finalTimerRef.current);
      finalTimerRef.current = null;
    }
  }
  function scheduleFlush(ms: number) {
    clearFinalTimer();
    finalTimerRef.current = window.setTimeout(async () => {
      const text = finalBufRef.current.join(" ").replace(/\s+/g, " ").trim();
      finalBufRef.current = [];
      if (text) {
        setTranscript(text);
        await askAlma(text);
      }
    }, ms) as unknown as number;
  }

  // Cria <audio> TTS e regista *unlock* genérico (qualquer gesto do user)
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = () => {
      if (audioUnlockedRef.current) return;
      const el = ttsAudioRef.current;
      if (!el) return;
      audioUnlockedRef.current = true;
      // “nudge” silencioso para desbloquear políticas de autoplay
      el.muted = true;
      el
        .play()
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        })
        .catch(() => {
          // se falhar, não há problema: um próximo gesto volta a tentar
          audioUnlockedRef.current = false;
        });
    };

    // desbloqueia em QUALQUER primeiro gesto (click/touch/keydown)
    const opts = { once: true } as AddEventListenerOptions;
    window.addEventListener("click", unlock, opts);
    window.addEventListener("touchstart", unlock, opts);
    window.addEventListener("keydown", unlock, opts);

    return () => {
      window.removeEventListener("click", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // ---------------- Micro (permissão)
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Podes falar (hold) ou iniciar streaming.");
    } catch {
      setStatus("⚠️ Permissão negada. Ativa o micro nas definições do navegador.");
    }
  }

  // ---------------- TTS
  async function speak(text: string) {
    if (!text) return;
    const audio = ttsAudioRef.current;
    if (!audio) {
      setStatus("⚠️ Áudio não inicializado.");
      return;
    }
    try {
      setStatus("🔊 A falar…");
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

      audio.src = url;

      // marca “a falar” (para anti-feedback)
      isSpeakingRef.current = true;
      // quando terminar a fala, libertar flag
      const onEnded = () => {
        isSpeakingRef.current = false;
        audio.removeEventListener("ended", onEnded);
        setStatus("Pronto");
      };
      audio.addEventListener("ended", onEnded);

      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
        isSpeakingRef.current = false;
        audio.removeEventListener("ended", onEnded);
      }
    } catch (e: any) {
      isSpeakingRef.current = false;
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ---------------- Alma
  async function askAlma(question: string) {
    setTranscript(question);
    setLog((l) => [...l, { role: "you", text: question }]);
    setStatus("🧠 A perguntar à Alma…");
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 200));
        return;
      }
      const j = (await r.json()) as { answer?: string };
      const out = (j.answer || "").trim();
      setAnswer(out);
      setLog((l) => [...l, { role: "alma", text: out }]);
      await speak(out); // fala já aqui; o “isSpeakingRef” evita feedback no streaming
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // ---------------- Push-to-talk (upload)
  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4";
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
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
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

  // ---------------- Streaming (PCM16 → WS)
  async function ensureAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext || AudioContext;
    const ctx: AudioContext = new Ctx({ sampleRate: 48000 });
    audioCtxRef.current = ctx;
    return ctx;
  }

  async function loadPcmWorklet(ctx: AudioContext) {
    if (workletLoadedRef.current) return;
    const workletCode = `
      class PCM16Downsampler extends AudioWorkletProcessor {
        constructor() {
          super();
          this._inRate = sampleRate;  // p.ex. 48000
          this._outRate = 16000;
          this._ratio = this._inRate / this._outRate;
          this._acc = 0;
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const ch = input[0]; // mono
          const out = [];
          for (let i = 0; i < ch.length; i++) {
            this._acc += 1;
            if (this._acc >= this._ratio) {
              this._acc -= this._ratio;
              let s = Math.max(-1, Math.min(1, ch[i]));
              s = s < 0 ? s * 0x8000 : s * 0x7FFF;
              out.push(s);
            }
          }
          if (out.length) {
            const arr = new Int16Array(out.length);
            for (let i = 0; i < out.length; i++) arr[i] = out[i] | 0;
            this.port.postMessage(arr.buffer, [arr.buffer]);
          }
          return true;
        }
      }
      try { registerProcessor('pcm16-downsampler', PCM16Downsampler); } catch(e) {}
    `;
    const blob = new Blob([workletCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      // @ts-ignore
      await ctx.audioWorklet.addModule(url);
      workletLoadedRef.current = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function startStreaming() {
    if (isStreaming) return;
    if (!isArmed) {
      await requestMic();
      if (!streamRef.current) return;
    }
    if (!STT_WS_URL) {
      setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definido.");
      return;
    }

    try {
      setStatus("🔌 A ligar ao STT…");
      const ctx = await ensureAudioContext();
      await loadPcmWorklet(ctx);

      const src = ctx.createMediaStreamSource(streamRef.current!);
      sourceNodeRef.current = src;

      const node = new AudioWorkletNode(ctx, "pcm16-downsampler");
      workletNodeRef.current = node;
      src.connect(node); // não ligamos ao destino (sem eco)

      const ws = new WebSocket(STT_WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setStatus("🟢 Streaming ligado. A enviar PCM16/16k…");
        setIsStreaming(true);
      };
      ws.onerror = () => setStatus("⚠️ Erro no WebSocket STT.");
      ws.onclose = () => {
        setStatus("Streaming fechado.");
        setIsStreaming(false);
        clearFinalTimer();
        finalBufRef.current = [];
      };

      ws.onmessage = async (ev) => {
        if (typeof ev.data !== "string") return;
        if (isSpeakingRef.current) return; // anti-feedback: ignora transcripts enquanto a Alma fala
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "transcript") {
            const part = (msg.transcript || "").trim();
            if (!part) return;

            const fixed = finalBufRef.current.join(" ");
            if (!msg.isFinal && !msg.is_final) {
              setTranscript((fixed + " " + part).replace(/\s+/g, " ").trim());
              return;
            }

            // é final → acumula e decide quando enviar à Alma
            finalBufRef.current.push(part);

            const hasPunct = /[.!?…:]\s*$/.test(part);
            const words = finalBufRef.current.join(" ").trim().split(/\s+/).filter(Boolean).length;

            if (hasPunct || words >= 6) {
              clearFinalTimer();
              const text = finalBufRef.current.join(" ").replace(/\s+/g, " ").trim();
              finalBufRef.current = [];
              if (text) {
                setTranscript(text);
                await askAlma(text);
              }
            } else {
              scheduleFlush(600);
            }
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + (msg.message || msg.error || "erro"));
          }
        } catch {
          /* ignora */
        }
      };

      node.port.onmessage = (e: MessageEvent) => {
        if (isSpeakingRef.current) return; // não mandar frames enquanto falamos
        const buf = e.data as ArrayBuffer;
        if (ws.readyState === 1) {
          try {
            ws.send(buf);
          } catch {}
        }
      };

      wsRef.current = ws;
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
      await stopStreaming();
    }
  }

  async function stopStreaming() {
    clearFinalTimer();
    finalBufRef.current = [];
    try { wsRef.current?.send("stop"); } catch {}
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;

    try { workletNodeRef.current?.port.close(); } catch {}
    try { sourceNodeRef.current?.disconnect(); } catch {}
    workletNodeRef.current = null;
    sourceNodeRef.current = null;

    setIsStreaming(false);
  }

  async function toggleStreaming() {
    if (isStreaming) await stopStreaming();
    else await startStreaming();
  }

  // ---------------- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // ---------------- UI handlers
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

  // ---------------- UI
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

      {/* Controlo principal */}
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
          onClick={toggleStreaming}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isStreaming ? "#004488" : "#333",
            color: "#fff",
          }}
        >
          {isStreaming ? "⏹️ Parar streaming" : "🔴 Iniciar streaming"}
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

        {/* Teste de voz (opcional). Já não é necessário para desbloquear, mas fica útil */}
        <button
          onClick={() => speak("Olá! Já estou pronta para falar contigo.")}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#2b2bff",
            color: "#fff",
          }}
        >
          Teste de voz
        </button>
      </div>

      {/* Texto → Alma */}
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

      {/* Conversa */}
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
