"use client";

import React, { useEffect, useRef, useState } from "react";
import AvatarCanvas from "@/components/AvatarCanvas";

type LogItem = { role: "you" | "alma"; text: string };

const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  ""; // ex.: wss://alma-stt-ws-xxxx.up.railway.app/stt

export default function Page() {
  // --- UI state (mantido)
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false); // push-to-talk
  const [isStreaming, setIsStreaming] = useState(false); // streaming WS

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Media / refs (mantido + novos)
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null); // upload (push-to-talk)

  // player TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  // NEW: callback que vem do Avatar para anexarmos o <audio> (lip-sync)
  const attachAudioCbRef = useRef<null | ((audio: HTMLAudioElement) => void)>(null);

  // Streaming (PCM 16 kHz)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const requestTimerRef = useRef<any>(null);

  // cria <audio> TTS + unlock iOS (mantido) — e anexa ao Avatar quando existir
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // se o Avatar já expôs o attach, ligamos agora o <audio>
    if (attachAudioCbRef.current && ttsAudioRef.current) {
      attachAudioCbRef.current(ttsAudioRef.current);
    }

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

  // --- Permissão do micro (mantido)
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

  // --- TTS (mantido)
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

  // --- ALMA (mantido)
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

  // --- Push-to-talk (upload) — MANTIDO
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

  // --- STREAMING PCM 16 kHz → alma-stt-ws (mantido tal como tinhas)
  async function ensureAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 48000, // a maioria dos browsers usa 48k; vamos downsample para 16k
    });
    audioCtxRef.current = ctx;
    return ctx;
  }

  // Pequeno worklet para: mono → downsample 16k → Int16 → postMessage(ArrayBuffer)
  async function loadPcmWorklet(ctx: AudioContext) {
    if (workletNodeRef.current) return;

    const workletCode = `
      class PCM16Downsampler extends AudioWorkletProcessor {
        constructor() {
          super();
          this._inRate = sampleRate;
          this._outRate = 16000;
          this._ratio = this._inRate / this._outRate;
          this._acc = 0;
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const ch = input[0];
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
      registerProcessor('pcm16-downsampler', PCM16Downsampler);
    `;
    const blob = new Blob([workletCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await (ctx.audioWorklet as any).addModule(url);
    URL.revokeObjectURL(url);

    const node = new AudioWorkletNode(ctx, "pcm16-downsampler");
    workletNodeRef.current = node;
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
      const node = workletNodeRef.current!;
      src.connect(node); // sem output audível (sem eco)

      const ws = new WebSocket(STT_WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setStatus("🟢 Streaming ligado. A enviar PCM16/16k…");
        setIsStreaming(true);
      };
      ws.onerror = (e) => {
        console.warn("[WS] erro", e);
        setStatus("⚠️ Erro no WebSocket STT.");
      };
      ws.onclose = () => {
        setStatus("Streaming fechado.");
        setIsStreaming(false);
      };
      ws.onmessage = async (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "transcript") {
            if (msg.isFinal || msg.is_final) {
              setTranscript(msg.transcript);
              await askAlma(msg.transcript);
            } else {
              setTranscript(msg.transcript);
            }
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + (msg.message || msg.error || "erro"));
          }
        } catch {}
      };

      node.port.onmessage = (e: MessageEvent) => {
        const buf = e.data as ArrayBuffer;
        if (ws.readyState === 1) {
          ws.send(buf); // envia Int16 PCM (little-endian)
        }
      };

      wsRef.current = ws;
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
      await stopStreaming(); // limpeza
    }
  }

  async function stopStreaming() {
    try {
      wsRef.current?.send("stop");
    } catch {}
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;

    try {
      workletNodeRef.current?.port.close();
    } catch {}
    try {
      sourceNodeRef.current?.disconnect();
    } catch {}
    workletNodeRef.current = null;
    sourceNodeRef.current = null;

    setIsStreaming(false);
  }

  async function toggleStreaming() {
    if (isStreaming) await stopStreaming();
    else await startStreaming();
  }

  // --- Texto → Alma (mantido)
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // --- UI handlers (mantido)
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

  // --- UI com Avatar no topo (NOVO bloco) + resto igual
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
      {/* Avatar (NOVO) */}
      <div style={{ width: "100%", height: 520, marginBottom: 16 }}>
        <AvatarCanvas
          onAttachReady={(attachAudioElement) => {
            // guardamos a função e anexamos já se o <audio> existir
            attachAudioCbRef.current = attachAudioElement;
            if (ttsAudioRef.current) attachAudioElement(ttsAudioRef.current);
          }}
        />
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Voz & Texto</h1>
      <p style={{ opacity: 0.85, marginBottom: 16 }}>{status}</p>

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
