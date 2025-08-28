"use client";

import React, { useEffect, useRef, useState } from "react";

type LogItem = { role: "you" | "alma"; text: string };

const STT_WS_URL =
  (typeof window !== "undefined" && (window as any).env?.NEXT_PUBLIC_STT_WS_URL) ||
  process.env.NEXT_PUBLIC_STT_WS_URL ||
  ""; // wss://<teu-ws>/stt

// === Parâmetros anti-feedback (podes afinar) ===
const VAD_THRESHOLD = 0.015;      // nível mínimo (~-36 dBFS) para considerar que o utilizador começou a falar
const HANGOVER_MS   = 350;        // tempo extra de silêncio após TTS antes de reabrir o micro
const IGNORE_WS_MS  = 400;        // durante este período após TTS, ignoramos mensagens do WS

export default function Page() {
  // --- UI
  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false); // push-to-talk
  const [isStreaming, setIsStreaming] = useState(false); // streaming WS
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  // --- Media / refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // TTS
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const webAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Streaming WS
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const workletLoadedRef = useRef(false);

  // Anti-feedback gates
  const lastTtsEndAtRef = useRef<number>(0);   // timestamp quando o TTS terminou
  const gateUntilRef    = useRef<number>(0);   // não enviar áudio ao WS até este timestamp

  // cria <audio> + desbloqueio + warm TTS
  useEffect(() => {
    const a = new Audio();
    (a as any).playsInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    const unlock = async () => {
      if (audioUnlockedRef.current) return;
      audioUnlockedRef.current = true;
      try {
        const Ctx =
          (window as any).AudioContext || (window as any).webkitAudioContext || AudioContext;
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx({ sampleRate: 48000 });
        await audioCtxRef.current.resume();
      } catch {}

      // “toque” mudo para desbloquear <audio>
      const el = ttsAudioRef.current!;
      el.muted = true;
      try { await el.play(); } catch {}
      el.pause(); el.currentTime = 0; el.muted = false;

      // pré-aquecer TTS com um ponto (decode only)
      warmTTS().catch(() => {});
    };

    const opts: AddEventListenerOptions = { once: true };
    window.addEventListener("click", unlock, opts);
    window.addEventListener("touchstart", unlock, opts);
    window.addEventListener("keydown", unlock, opts);

    return () => {
      window.removeEventListener("click", unlock);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  async function warmTTS() {
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "." }),
      });
      if (!r.ok) return;
      const ab = await r.arrayBuffer();
      try {
        const ctx = audioCtxRef.current!;
        await ctx.decodeAudioData(ab.slice(0));
      } catch {}
    } catch {}
  }

  // ---- Micro
  async function requestMic() {
    try {
      setStatus("A pedir permissão do micro…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true, // ajuda a reduzir retorno da coluna
          autoGainControl: false,
        },
        video: false,
      });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto. Podes falar (hold) ou iniciar streaming.");
    } catch {
      setStatus("⚠️ Permissão negada. Ativa o micro nas definições do navegador.");
    }
  }

  // ---- parar fala (barge-in + abre a janela de hangover)
  function stopSpeaking() {
    try { ttsAudioRef.current?.pause(); } catch {}
    if (ttsAudioRef.current) {
      try { ttsAudioRef.current.currentTime = 0; } catch {}
    }
    try { webAudioSourceRef.current?.stop(); } catch {}
    webAudioSourceRef.current = null;
    isSpeakingRef.current = false;
    gateUntilRef.current = Date.now() + HANGOVER_MS; // espera curto antes de reabrir envio
  }

  // ---- TTS (com fallback WebAudio)
  async function speak(text: string) {
    if (!text) return;
    const audio = ttsAudioRef.current;
    if (!audio) { setStatus("⚠️ Áudio não inicializado."); return; }

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

      // Tenta <audio>
      try {
        const blob = new Blob([ab], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        audio.src = url;
        isSpeakingRef.current = true;
        const onEnded = () => {
          isSpeakingRef.current = false;
          lastTtsEndAtRef.current = Date.now();
          gateUntilRef.current = lastTtsEndAtRef.current + HANGOVER_MS;
          audio.removeEventListener("ended", onEnded);
          URL.revokeObjectURL(url);
          setStatus("Pronto");
        };
        audio.addEventListener("ended", onEnded);
        await audio.play();
        return;
      } catch {
        // Fallback WebAudio
        try {
          const ctx = audioCtxRef.current!;
          await ctx.resume();
          const buf = await ctx.decodeAudioData(ab.slice(0));
          const src = ctx.createBufferSource();
          webAudioSourceRef.current = src;
          isSpeakingRef.current = true;
          src.buffer = buf;
          src.connect(ctx.destination);
          src.onended = () => {
            isSpeakingRef.current = false;
            lastTtsEndAtRef.current = Date.now();
            gateUntilRef.current   = lastTtsEndAtRef.current + HANGOVER_MS;
            setStatus("Pronto");
          };
          src.start(0);
          return;
        } catch {
          isSpeakingRef.current = false;
          setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
          return;
        }
      }
    } catch (e: any) {
      isSpeakingRef.current = false;
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ---- Alma
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
      await speak(out);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // ---- Push-to-talk (upload) — mantido
  function buildMediaRecorder(): MediaRecorder {
    let mime = "";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/webm")) mime = "audio/webm";
    else mime = "audio/mp4";
    return new MediaRecorder(streamRef.current!, { mimeType: mime });
  }
  function startHold() {
    if (!isArmed) { requestMic(); return; }
    if (!streamRef.current) { setStatus("⚠️ Micro não está pronto."); return; }
    try {
      // barge-in imediato
      stopSpeaking();
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
      if (!said) { setStatus("⚠️ Não consegui transcrever o áudio."); return; }
      await askAlma(said);
    } catch (e: any) {
      setStatus("⚠️ Erro: " + (e?.message || e));
    }
  }

  // ---- Streaming (PCM16 → WS) + VAD/anti-feedback
  async function ensureAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext || AudioContext;
    const ctx: AudioContext = new Ctx({ sampleRate: 48000 });
    audioCtxRef.current = ctx;
    return ctx;
  }
  async function loadPcmWorklet(ctx: AudioContext) {
    if (workletLoadedRef.current) return;

    // Calcula RMS, downsample 48k -> 16k, envia {buf, level}
    const workletCode = `
      class PCM16Downsampler extends AudioWorkletProcessor {
        constructor(){ super(); this._ratio = sampleRate / 16000; this._acc = 0; }
        process(inputs){
          const i = inputs[0]; if(!i || !i[0]) return true;
          const ch = i[0];
          let sum=0; for(let k=0;k<ch.length;k++){ const v=ch[k]; sum+=v*v; }
          const rms = Math.sqrt(sum/Math.max(1,ch.length));
          const out=[];
          for(let k=0;k<ch.length;k++){
            this._acc+=1; if(this._acc>=this._ratio){ this._acc-=this._ratio;
              let s = Math.max(-1, Math.min(1, ch[k]));
              s = s<0 ? s*0x8000 : s*0x7FFF;
              out.push(s);
            }
          }
          if(out.length){
            const arr=new Int16Array(out.length);
            for(let j=0;j<out.length;j++) arr[j]=out[j]|0;
            const buf = arr.buffer;
            this.port.postMessage({ buf, level: rms }, [buf]);
          }
          return true;
        }
      }
      registerProcessor('pcm16-downsampler', PCM16Downsampler);
    `;
    const blob = new Blob([workletCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    // @ts-ignore
    await (ctx.audioWorklet as any).addModule(url);
    URL.revokeObjectURL(url);
    workletLoadedRef.current = true;
  }

  async function startStreaming() {
    if (isStreaming) return;
    if (!isArmed) { await requestMic(); if (!streamRef.current) return; }
    if (!STT_WS_URL) { setStatus("⚠️ NEXT_PUBLIC_STT_WS_URL não definido."); return; }

    try {
      setStatus("🔌 A ligar ao STT…");
      const ctx = await ensureAudioContext();
      await loadPcmWorklet(ctx);

      const src = ctx.createMediaStreamSource(streamRef.current!);
      sourceNodeRef.current = src;

      const node = new AudioWorkletNode(ctx, "pcm16-downsampler");
      workletNodeRef.current = node;
      src.connect(node);

      const ws = new WebSocket(STT_WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => { setStatus("🟢 Streaming ligado. A enviar PCM16/16k…"); setIsStreaming(true); };
      ws.onerror = () => setStatus("⚠️ Erro no WebSocket STT.");
      ws.onclose = () => { setStatus("Streaming fechado."); setIsStreaming(false); };

      ws.onmessage = async (ev) => {
        if (typeof ev.data !== "string") return;

        // Anti-feedback no lado do cliente:
        const now = Date.now();
        if (isSpeakingRef.current || now - lastTtsEndAtRef.current < IGNORE_WS_MS) {
          // Estamos a falar ou ainda dentro da janela pós-TTS → ignora
          return;
        }

        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "partial" && msg.transcript) {
            setTranscript((msg.transcript || "").trim());
          } else if ((msg.type === "utterance" || msg.isFinal || msg.is_final) && msg.transcript) {
            const text = (msg.transcript || "").trim();
            if (text) { setTranscript(text); await askAlma(text); }
          } else if (msg.type === "error") {
            setStatus("⚠️ STT (WS): " + (msg.message || msg.error || "erro"));
          }
        } catch {}
      };

      // Envio de frames com gate
      node.port.onmessage = (e: MessageEvent) => {
        const data = e.data as { buf: ArrayBuffer; level: number } | any;
        const now = Date.now();

        // Se a Alma fala ou estamos na janela de hangover, não enviar nada
        if (isSpeakingRef.current || now < gateUntilRef.current) return;

        // Só abrir envio quando nível passa limiar (utilizador começou mesmo a falar)
        if (typeof data?.level === "number" && data.level < VAD_THRESHOLD) {
          return;
        }

        if (data?.buf && ws.readyState === 1) {
          try { ws.send(data.buf); } catch {}
        }
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
  async function toggleStreaming() { if (isStreaming) await stopStreaming(); else await startStreaming(); }

  // ---- Texto → Alma
  async function sendTyped() {
    const q = typed.trim(); if (!q) return;
    setTyped("");
    await askAlma(q);
  }

  // ---- Hold UI
  function onHoldStart(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    stopSpeaking(); // barge-in instantâneo
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

  // ---- UI
  return (
    <main
      style={{
        maxWidth: 820, margin: "0 auto", padding: 16,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
        color: "#fff", background: "#0b0b0b", minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>🎭 Alma — Voz & Texto</h1>
      <p style={{ opacity: 0.85, marginBottom: 16 }}>{status}</p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          onClick={requestMic}
          style={{
            padding: "10px 14px", borderRadius: 8, border: "1px solid #444",
            background: isArmed ? "#113311" : "#222", color: isArmed ? "#9BE29B" : "#fff",
          }}
        >
          {isArmed ? "Micro pronto ✅" : "Ativar micro"}
        </button>

        <button
          onClick={toggleStreaming}
          style={{
            padding: "10px 14px", borderRadius: 8, border: "1px solid #444",
            background: isStreaming ? "#004488" : "#333", color: "#fff",
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
            padding: "10px 14px", borderRadius: 999, border: "1px solid #444",
            background: isRecording ? "#8b0000" : "#333", color: "#fff",
          }}
        >
          {isRecording ? "A gravar… solta para enviar" : "🎤 Segurar para falar"}
        </button>

        <button
          onClick={copyLog}
          style={{
            padding: "10px 14px", borderRadius: 8, border: "1px solid #444",
            background: "#222", color: "#ddd",
          }}
        >
          Copiar histórico
        </button>

        <button
          onClick={() => speak("Olá! Já estou pronta para falar contigo.")}
          style={{
            padding: "10px 14px", borderRadius: 8, border: "1px solid #444",
            background: "#2b2bff", color: "#fff",
          }}
        >
          Teste de voz
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Escreve aqui para perguntar à Alma…"
          style={{
            flex: 1, padding: "10px 12px", borderRadius: 8,
            border: "1px solid #444", background: "#111", color: "#fff",
          }}
          onKeyDown={(e) => { if (e.key === "Enter") sendTyped(); }}
        />
        <button
          onClick={sendTyped}
          style={{
            padding: "10px 14px", borderRadius: 8, border: "1px solid #444",
            background: "#2b2bff", color: "#fff",
          }}
        >
          Enviar
        </button>
      </div>

      <div
        style={{
          border: "1px solid #333", borderRadius: 12, padding: 12, background: "#0f0f0f",
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
