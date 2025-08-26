"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  "";

/**
 * Página:
 *  - Botão "Ativar micro"
 *  - Botão "🔴 Iniciar/Parar streaming" (NOVO: envia PCM16/16k via WebAudio)
 *  - Botão "🎤 Segurar para falar" (upload clássico que já funcionava)
 *  - Input de texto (pergunta por escrito)
 *  - Fala as respostas via /api/tts
 */
export default function Page() {
  // -------- UI / estado
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");

  const [log, setLog] = useState<LogItem[]>([]);

  // -------- Áudio / gravação
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null); // usado só no modo "hold"
  const wsRef = useRef<WebSocket | null>(null);

  // Web Audio (streaming)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmBufferRef = useRef<Float32Array | null>(null); // acumula float32 antes de resample

  // player TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // cria <audio> e desbloqueia iOS
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = () => {
      if (!ttsAudioRef.current) return;
      const el = ttsAudioRef.current;
      el.muted = true;
      el
        .play()
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

  // -------- Helpers de micro
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Mantém o botão para falar ou inicia streaming.");
    } catch (e: any) {
      setStatus("⚠️ Permissão negada. Ativa o micro nas definições do navegador.");
    }
  }

  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      mime = "audio/webm;codecs=opus";
    } else if (MediaRecorder.isTypeSupported("audio/webm")) {
      mime = "audio/webm";
    } else {
      mime = "audio/mp4"; // fallback Safari
    }
    const mr = new MediaRecorder(streamRef.current!, { mimeType: mime });
    (mr as any).__mime = mime;
    return mr;
  }

  // -------- TTS
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
      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // -------- Alma
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
      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // -------- Fluxo “segurar para falar” (UPLOAD que já funcionava)
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
      // 1) STT (upload)
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

  // =========================
  // ===== STREAMING PCM =====
  // =========================

  // Util: concatena Float32Arrays
  function concatFloat32(a: Float32Array, b: Float32Array) {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // Downsample simples (linear) para 16 kHz mono
  function resampleTo16k(float32: Float32Array, fromRate: number): Int16Array {
    const toRate = 16000;
    if (fromRate === toRate) {
      return floatTo16PCM(float32);
    }
    const ratio = fromRate / toRate;
    const newLen = Math.floor(float32.length / ratio);
    const out = new Float32Array(newLen);
    let pos = 0;
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const w = idx - i0;
      out[i] = float32[i0] * (1 - w) + float32[i1] * w;
      pos++;
    }
    return floatTo16PCM(out);
  }

  function floatTo16PCM(f32: Float32Array): Int16Array {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function toBase64(int16: Int16Array): string {
    // Mais rápido: usar Buffer em browsers modernos via Uint8Array + btoa
    const u8 = new Uint8Array(int16.buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      const sub = u8.subarray(i, i + chunk);
      binary += String.fromCharCode.apply(null, Array.from(sub) as any);
    }
    return btoa(binary);
  }

  async function startStreamingPCM() {
    if (!isArmed) {
      await requestMic();
      if (!streamRef.current) return;
    }
    if (!STT_WS_URL) {
      setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definido.");
      return;
    }
    if (isStreaming) return;

    try {
      setStatus("🔌 A ligar ao STT…");
      const ws = new WebSocket(STT_WS_URL);
      wsRef.current = ws;

      ws.onopen = async () => {
        setStatus("🟢 Streaming ligado. A enviar áudio (PCM16/16k) …");
        // envia handshake
        try {
          ws.send(
            JSON.stringify({
              type: "start",
              format: "pcm16",
              sampleRate: 16000,
              language: "pt-PT",
            })
          );
        } catch {}

        // Web Audio pipeline
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = ctx;

        const src = ctx.createMediaStreamSource(streamRef.current!);
        sourceRef.current = src;

        // ScriptProcessorNode (bufferSize 2048 ou 4096; 1 canal)
        const bufferSize = 2048;
        const proc = ctx.createScriptProcessor(bufferSize, 1, 1);
        processorRef.current = proc;

        pcmBufferRef.current = new Float32Array(0);
        src.connect(proc);
        proc.connect(ctx.destination); // necessário em iOS para o callback correr (não fará som)

        proc.onaudioprocess = (ev) => {
          if (!wsRef.current || wsRef.current.readyState !== 1) return;
          const inBuf = ev.inputBuffer.getChannelData(0); // Float32
          // acumula
          const prev = pcmBufferRef.current!;
          const combined = concatFloat32(prev, inBuf);
          // queremos enviar em blocos de ~20–40ms @ 16k => 320–640 samples pós-resample
          // Para simplificar, enviaremos a cada callback tudo o que vier, resample e chunk
          // (os tamanhos serão pequenos e frequentes).
          // Resample para 16k
          const int16 = resampleTo16k(combined, ctx.sampleRate);
          // Limpa o acumulador (já enviámos tudo)
          pcmBufferRef.current = new Float32Array(0);

          if (int16.length === 0) return;

          // Opcional: chunking de 20ms (320 samples) para quadros mais estáveis
          const CH = 320; // 20ms @ 16k
          for (let i = 0; i < int16.length; i += CH) {
            const slice = int16.subarray(i, Math.min(i + CH, int16.length));
            if (slice.length === 0) continue;
            const b64 = toBase64(slice);
            try {
              wsRef.current!.send(JSON.stringify({ type: "audio", data: b64 }));
            } catch (err) {
              // ignore
            }
          }
        };

        setIsStreaming(true);
      };

      ws.onerror = (ev) => {
        console.warn("[WS] erro", ev);
        setStatus("⚠️ Erro no WebSocket STT.");
      };

      ws.onclose = () => {
        setStatus("Streaming fechado.");
        setIsStreaming(false);
        // limpa áudio
        try {
          processorRef.current?.disconnect();
          sourceRef.current?.disconnect();
          audioCtxRef.current?.close();
        } catch {}
        processorRef.current = null;
        sourceRef.current = null;
        audioCtxRef.current = null;
      };

      ws.onmessage = async (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "partial" && msg.transcript) {
            setTranscript(msg.transcript);
          } else if ((msg.type === "final" || msg.is_final) && msg.transcript) {
            setTranscript(msg.transcript);
            await askAlma(msg.transcript);
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + msg.error);
          }
        } catch {
          // ignora
        }
      };
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
    }
  }

  function stopStreamingPCM() {
    try {
      if (wsRef.current && wsRef.current.readyState === 1) {
        try {
          wsRef.current.send(JSON.stringify({ type: "stop" }));
        } catch {}
        try {
          wsRef.current.close();
        } catch {}
      }
    } catch {}
    // fecha audio
    try {
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      audioCtxRef.current?.close();
    } catch {}
    processorRef.current = null;
    sourceRef.current = null;
    audioCtxRef.current = null;
    setIsStreaming(false);
    setStatus("Streaming parado.");
  }

  async function toggleStreaming() {
    if (isStreaming) stopStreamingPCM();
    else await startStreamingPCM();
  }

  // -------- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // -------- UI
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

      {/* Controlo de micro + streaming */}
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
