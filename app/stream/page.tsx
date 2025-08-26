"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma" | "sys"; text: string };

const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  "";

const TARGET_SR = 16000; // 16 kHz PCM

export default function StreamPage() {
  const [status, setStatus] = useState("Pronto (streaming em página separada)");
  const [isArmed, setIsArmed] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  const [level, setLevel] = useState(0);         // nível de input (0..1)
  const [kbSent, setKbSent] = useState(0);       // contador de bytes enviados
  const bytesSentRef = useRef(0);

  // Áudio in/out
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const muteGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);

  // TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // ------ setup TTS <audio> e desbloqueio iOS ------
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = () => {
      const el = ttsAudioRef.current;
      if (!el) return;
      el.muted = true;
      el.play().then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
      }).catch(() => {});
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

  // ------ mic ------
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
      setStatus("Micro pronto. Carrega em Iniciar streaming.");
    } catch {
      setStatus("⚠️ Permissão do micro negada.");
    }
  }

  // ------ PCM helpers ------
  function floatTo16BitPCM(float32: Float32Array): Int16Array {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function downsample(buffer: Float32Array, inSr: number, outSr: number) {
    if (outSr === inSr) return buffer;
    const ratio = inSr / outSr;
    const newLen = Math.round(buffer.length / ratio);
    if (!isFinite(newLen) || newLen <= 0) return new Float32Array(0);
    const result = new Float32Array(newLen);
    let offR = 0, offB = 0;
    while (offR < newLen) {
      const nextOffB = Math.round((offR + 1) * ratio);
      let acc = 0, count = 0;
      for (let i = offB; i < nextOffB && i < buffer.length; i++) {
        acc += buffer[i]; count++;
      }
      result[offR] = count > 0 ? acc / count : 0;
      offR++; offB = nextOffB;
    }
    return result;
  }

  // ------ TTS ------
  async function speak(text: string) {
    if (!text) return;
    try {
      const audioEl = ttsAudioRef.current;
      if (audioEl && !audioEl.paused) {
        try { audioEl.pause(); audioEl.currentTime = 0; } catch {}
      }

      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus(`⚠️ /api/tts ${r.status}: ${txt.slice(0, 160)}`);
        return;
      }
      const ab = await r.arrayBuffer();
      const blob = new Blob([ab], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);

      const audio = ttsAudioRef.current!;
      audio.src = url;
      audio.load();
      try {
        await audio.play();
      } catch {
        setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      }
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ------ Alma ------
  async function askAlma(q: string) {
    setTranscript(q);
    setLog((l) => [...l, { role: "you", text: q }]);
    setStatus(isStreaming ? "🧠 (stream) a perguntar à Alma…" : "🧠 A perguntar à Alma…");
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setStatus("⚠️ Erro no Alma: " + txt.slice(0, 160));
        return;
      }
      const j = (await r.json()) as { answer?: string };
      const out = (j.answer || "").trim();
      setAnswer(out);
      setLog((l) => [...l, { role: "alma", text: out }]);
      setStatus(isStreaming ? "🔊 A falar…" : "Pronto");
      await speak(out);
      setStatus(isStreaming ? "🎧 Streaming a decorrer…" : "Pronto");
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // ------ meter (nível de micro) ------
  function startMeter() {
    const ctx = audioCtxRef.current;
    const analyser = ctx!.createAnalyser();
    analyser.fftSize = 2048;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const loop = () => {
      analyser.getByteTimeDomainData(data);
      // RMS simples
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      setLevel(rms);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }

  function stopMeter() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current = null;
  }

  // ------ start/stop streaming (PCM via WebAudio) ------
  async function toggleStreaming() {
    if (isStreaming) {
      try { procRef.current?.disconnect(); } catch {}
      try { srcNodeRef.current?.disconnect(); } catch {}
      try { muteGainRef.current?.disconnect(); } catch {}
      try { audioCtxRef.current?.close(); } catch {}
      try { wsRef.current?.close(); } catch {}
      stopMeter();
      audioCtxRef.current = null;
      procRef.current = null;
      srcNodeRef.current = null;
      muteGainRef.current = null;
      wsRef.current = null;
      setIsStreaming(false);
      setStatus("Streaming parado.");
      return;
    }

    if (!STT_WS_URL) {
      setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definido.");
      return;
    }
    if (!isArmed) {
      await requestMic();
      if (!streamRef.current) return;
    }

    try {
      setStatus("🔌 A ligar ao STT…");
      const ws = new WebSocket(STT_WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        const hello = { type: "start", language: "pt-PT", format: "pcm_s16le", sampleRate: TARGET_SR };
        try { ws.send(JSON.stringify(hello)); } catch {}
        setStatus("🟢 Streaming ligado. A enviar áudio (PCM 16k)…");
        setLog((l)=>[...l, {role:"sys", text:`WS OPEN ${STT_WS_URL}`}]);
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
            setLog((l)=>[...l, {role:"sys", text:"STT error: "+msg.error}]);
          }
        } catch {}
      };

      ws.onerror = (e) => {
        console.warn("[WS] error:", e);
        setStatus("⚠️ Erro no WebSocket STT.");
        setLog((l)=>[...l, {role:"sys", text:"WS ERROR (ver consola)"}]);
      };

      ws.onclose = () => {
        setStatus("Streaming fechado.");
        setIsStreaming(false);
        try { procRef.current?.disconnect(); } catch {}
        try { srcNodeRef.current?.disconnect(); } catch {}
        try { muteGainRef.current?.disconnect(); } catch {}
        try { audioCtxRef.current?.close(); } catch {}
        stopMeter();
        setLog((l)=>[...l, {role:"sys", text:"WS CLOSE"}]);
      };

      wsRef.current = ws;

      // WebAudio pipeline
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext);
      const ctx = new Ctx();
      audioCtxRef.current = ctx;

      // tem MESMO de haver gesto do utilizador antes
      await ctx.resume();

      const source = ctx.createMediaStreamSource(streamRef.current!);
      srcNodeRef.current = source;

      // meter
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      // mute gain (mantém a cadeia viva)
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      muteGainRef.current = muteGain;

      // processor
      const bufferSize = 2048;
      const proc = ctx.createScriptProcessor(bufferSize, 1, 1);
      procRef.current = proc;

      proc.onaudioprocess = (e) => {
        const ch0 = e.inputBuffer.getChannelData(0);
        const down = downsample(ch0, ctx.sampleRate, TARGET_SR);
        if (down.length === 0) return; // proteção
        const pcm16 = floatTo16BitPCM(down);
        if (wsRef.current && wsRef.current.readyState === 1) {
          try {
            wsRef.current.send(pcm16.buffer);
            bytesSentRef.current += pcm16.byteLength;
            if ((bytesSentRef.current & 0xfff) === 0) {
              // atualiza a cada ~4KB para não re-render contínuo
              setKbSent(bytesSentRef.current / 1024);
            }
          } catch {}
        }
      };

      // cadeia: source -> analyser -> proc -> muteGain -> destination
      source.connect(analyser);
      analyser.connect(proc);
      proc.connect(muteGain);
      muteGain.connect(ctx.destination);

      startMeter();

      setIsStreaming(true);
      setStatus("🎧 Streaming a decorrer…");
    } catch (e: any) {
      setStatus("⚠️ Falha a iniciar streaming: " + (e?.message || e));
    }
  }

  // ---- botão de teste (envia 1 frame silencioso) ----
  function sendSilentFrame() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    const pcm16 = new Int16Array(TARGET_SR / 10); // 100 ms silêncio
    try {
      ws.send(pcm16.buffer);
      bytesSentRef.current += pcm16.byteLength;
      setKbSent(bytesSentRef.current / 1024);
      setLog((l)=>[...l, {role:"sys", text:"Silent 100ms frame enviado"}]);
    } catch {}
  }

  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: 16,
        color: "#fff",
        background: "#0b0b0b",
        minHeight: "100vh",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        🎭 Alma — Streaming (PCM 16 kHz)
      </h1>
      <p style={{ opacity: 0.85, marginBottom: 6 }}>{status}</p>
      <div style={{ fontSize: 12, color: "#aaa", marginBottom: 16 }}>
        Nível: {(level * 100).toFixed(0)}% • Enviado: {kbSent.toFixed(1)} KB • WS: {STT_WS_URL || "(não definido)"}
      </div>

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
          onClick={sendSilentFrame}
          disabled={!isStreaming}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: isStreaming ? "#222" : "#111",
            color: "#ddd",
          }}
        >
          Enviar 100ms silêncio (teste)
        </button>

        <a
          href="/"
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#222",
            color: "#ddd",
            textDecoration: "none",
          }}
        >
          ⤶ Voltar (hold/texto)
        </a>
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
        </div>
        <div style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>{transcript || "—"}</div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, color: "#aaa" }}>Alma (último):</div>
        </div>
        <div style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>{answer || "—"}</div>

        <hr style={{ borderColor: "#222", margin: "8px 0 12px" }} />

        <div>
          <div style={{ fontWeight: 600, color: "#aaa", marginBottom: 6 }}>Log</div>
          <div style={{ display: "grid", gap: 6 }}>
            {log.length === 0 && <div style={{ opacity: 0.6 }}>—</div>}
            {log.map((m, i) => (
              <div key={i} style={{ whiteSpace: "pre-wrap" }}>
                <span style={{ color: m.role === "sys" ? "#7aa" : "#999" }}>
                  {m.role === "you" ? "Tu:" : m.role === "alma" ? "Alma:" : "SYS:"}
                </span>{" "}
                {m.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
