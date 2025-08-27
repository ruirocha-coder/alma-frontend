"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  ""; // ex.: wss://alma-stt-ws-xxxx.up.railway.app/stt

export default function Page() {
  // --- UI state
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Media / refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // Streaming (PCM 16 kHz)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Anti-eco
  const lastAlmaReplyRef = useRef<string>("");
  const lastAlmaReplyAtRef = useRef<number>(0);

  // cria <audio> TTS + unlock iOS
  useEffect(() => {
    createAudioElement();
    primeAudioUnlock();
    return () => {
      document.removeEventListener("click", unlockOnce);
      document.removeEventListener("touchstart", unlockOnce);
      closeMic();
      try { audioCtxRef.current?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function createAudioElement() {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;
  }

  function primeAudioUnlock() {
    document.addEventListener("click", unlockOnce, { once: true });
    document.addEventListener("touchstart", unlockOnce, { once: true });
  }

  async function unlockOnce() {
    const el = ttsAudioRef.current;
    if (!el) return;
    try {
      el.muted = true;
      await el.play();
      el.pause();
      el.currentTime = 0;
      el.muted = false;
    } catch {}
  }

  async function ensurePlaybackUnlocked() {
    const el = ttsAudioRef.current;
    if (!el) return;
    try {
      el.muted = true;
      await el.play();
      el.pause();
      el.currentTime = 0;
      el.muted = false;
    } catch {}
  }

  // ---------- AUDIO MIC LIFECYCLE
  function closeMic() {
    try {
      if (streamRef.current) {
        for (const tr of streamRef.current.getTracks()) tr.stop();
      }
    } catch {}
    streamRef.current = null;
    setIsArmed(false);
  }

  async function checkMicPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
    try {
      // Nem todos os browsers suportam:
      // @ts-ignore
      if (navigator.permissions?.query) {
        // @ts-ignore
        const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
        return p.state as any;
      }
    } catch {}
    return "unknown";
  }

  function getStrictConstraints() {
    return {
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true, // anti-eco ligado
      },
      video: false,
    } as MediaStreamConstraints;
  }
  function getLooseConstraints() {
    return { audio: true, video: false } as MediaStreamConstraints;
  }

  function gumWithTimeout(constraints: MediaStreamConstraints, ms: number) {
    return new Promise<MediaStream>((resolve, reject) => {
      let done = false;
      const to = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("getUserMedia timeout"));
      }, ms);
      navigator.mediaDevices
        .getUserMedia(constraints)
        .then((s) => {
          if (done) { s.getTracks().forEach(t=>t.stop()); return; }
          done = true;
          clearTimeout(to);
          resolve(s);
        })
        .catch((e) => {
          if (done) return;
          done = true;
          clearTimeout(to);
          reject(e);
        });
    });
  }

  async function requestMic() {
    // encerra qualquer stream antigo
    closeMic();

    const perm = await checkMicPermission();
    if (perm === "denied") {
      setStatus("⚠️ Micro bloqueado nas permissões do navegador/sistema.");
      return;
    }
    setStatus("A pedir permissão do micro…");

    // 1) tentativa “strict” com timeout curto
    try {
      const s = await gumWithTimeout(getStrictConstraints(), 6000);
      streamRef.current = s;
      setIsArmed(true);
      setStatus("Micro pronto. Podes falar (hold) ou iniciar streaming.");
      return;
    } catch {
      // segue para fallback
    }

    // 2) fallback rápido e simples
    try {
      const s2 = await gumWithTimeout(getLooseConstraints(), 4000);
      streamRef.current = s2;
      setIsArmed(true);
      setStatus("Micro pronto (fallback). Podes falar (hold) ou iniciar streaming.");
      return;
    } catch (e: any) {
      setStatus(
        "⚠️ Falha a obter micro. Verifica permissões do browser e se o site está em HTTPS."
      );
    }
  }

  // ---------- TTS
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
      try { audio.load(); } catch {}
      try {
        await audio.play();
      } catch {
        await ensurePlaybackUnlocked();
        try {
          await audio.play();
        } catch {
          setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
        }
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ---------- ALMA
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

      lastAlmaReplyRef.current = out;
      lastAlmaReplyAtRef.current = Date.now();

      setStatus("🔊 A falar…");
      await speak(out);
      setStatus("Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // ---------- Anti-eco
  function looksLikeEcho(text: string): boolean {
    const windowMs = 6000;
    if (!lastAlmaReplyRef.current) return false;
    if (Date.now() - lastAlmaReplyAtRef.current > windowMs) return false;

    const a = normalize(lastAlmaReplyRef.current);
    const b = normalize(text);
    if (!a || !b) return false;

    if (a.length >= 24 && b.includes(a.slice(0, 24))) return true;

    const sa = new Set(a.split(/\s+/));
    const sb = new Set(b.split(/\s+/));
    let inter = 0;
    sa.forEach((t) => { if (sb.has(t)) inter++; });
    const union = sa.size + sb.size - inter;
    const j = union ? inter / union : 0;
    return j >= 0.9;
  }
  function normalize(s: string) {
    return s.toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- Push-to-talk upload (mantido)
  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4";
    return new MediaRecorder(streamRef.current!, { mimeType: mime });
  }

  function startHold() {
    if (!isArmed) { requestMic(); return; }
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

  // ---------- STREAMING PCM 16 kHz
  async function ensureAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx({ sampleRate: 48000 });
    audioCtxRef.current = ctx;
    return ctx;
  }

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
      src.connect(node);

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
            const t: string = msg.transcript || "";
            if (msg.isFinal || msg.is_final) {
              if (looksLikeEcho(t)) {
                setTranscript(t + " (ignorado como eco)");
                return;
              }
              setTranscript(t);
              await askAlma(t);
            } else {
              setTranscript(t);
            }
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + (msg.message || msg.error || "erro"));
          }
        } catch {}
      };

      node.port.onmessage = (e: MessageEvent) => {
        const buf = e.data as ArrayBuffer;
        if (ws.readyState === 1) ws.send(buf);
      };

      wsRef.current = ws;
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
      await stopStreaming();
    }
  }

  async function stopStreaming() {
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

  // ---------- Texto → Alma
  async function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    setTyped("");
    await ensurePlaybackUnlocked();
    await askAlma(q);
  }

  // ---------- UI handlers
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

  async function resetAudio() {
    // fecha streams e contexto, recria elementos
    await stopStreaming();
    if (isRecording && mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
      setIsRecording(false);
    }
    closeMic();
    try { audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    workletNodeRef.current = null;
    sourceNodeRef.current = null;
    createAudioElement();
    primeAudioUnlock();
    setStatus("Áudio reiniciado. Carrega 'Ativar micro'.");
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

        <button
          onClick={resetAudio}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#333",
            color: "#ddd",
          }}
        >
          Reiniciar áudio
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
          onKeyDown={(e) => { if (e.key === "Enter") sendTyped(); }}
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
