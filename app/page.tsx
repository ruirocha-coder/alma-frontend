"use client";

import { useEffect, useRef, useState } from "react";

/* ========== Configs que podes afinar ========== */
const DEFAULT_LANGUAGE = "pt-PT";
// VAD – tempo de silêncio para parar automaticamente (tap-to-talk)
const SILENCE_MS = 800;
// VAD – nível mínimo (0..1 RMS) para considerar voz
const VAD_THRESHOLD = 0.02;
// quanto gravar no modo tap se VAD não disparar (máx segurança)
const MAX_TAP_SECONDS = 8;
// atraso intencional antes de começar a gravar (o browser “acorda” o micro)
const LEAD_IN_MS = 200;
// espera no fim para não cortar a última sílaba
const TAIL_MS = 250;

function pickBestMime(): string {
  if (typeof window === "undefined") return "audio/webm";
  const c = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4", // Safari fallback
  ];
  for (const m of c) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return "audio/webm";
}

/** Envia blob para /api/stt e devolve texto */
async function sttFromBlob(
  blob: Blob,
  lang = DEFAULT_LANGUAGE
): Promise<string> {
  const form = new FormData();
  form.append("file", blob, blob.type.startsWith("audio/mp4") ? "clip.m4a" : "clip.webm");
  form.append("mime", blob.type);
  form.append("lang", lang);
  const r = await fetch("/api/stt", { method: "POST", body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.detail || j?.error || "STT falhou");
  return j.text || "";
}

/** Pergunta ao Alma Server */
async function askAlma(question: string) {
  const r = await fetch("/api/alma", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.answer || "Erro no /api/alma");
  return j.answer || "";
}

/** Fala via /api/tts */
async function speakText(text: string, audioEl: HTMLAudioElement) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const ctype = r.headers.get("Content-Type") || "";
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`TTS error: ${r.status} ${err}`);
  }
  if (ctype.includes("application/json")) {
    const j = await r.json();
    if (!j?.url) throw new Error("TTS: resposta sem URL");
    audioEl.src = j.url;
  } else {
    const blob = await r.blob();
    audioEl.src = URL.createObjectURL(blob);
  }
  await audioEl.play().catch(() => {});
}

type RecState = "idle" | "recording" | "processing";

/** =======================================================
 *  Página
 *  ======================================================= */
export default function Page() {
  const [lang] = useState(DEFAULT_LANGUAGE);
  const [you, setYou] = useState("");
  const [alma, setAlma] = useState("");
  const [err, setErr] = useState("");
  const [recState, setRecState] = useState<RecState>("idle");
  const [typing, setTyping] = useState("");

  const audioRef = useRef<HTMLAudioElement>(null);

  // refs de gravação
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVoiceMsRef = useRef<number>(0);
  const modeRef = useRef<"tap" | "hold">("tap");
  const stopTimeoutRef = useRef<number | null>(null);

  function clearRaf() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
  function clearStopTimeout() {
    if (stopTimeoutRef.current) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }
  }

  function getConstraints(): MediaStreamConstraints {
    return {
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: false,
      } as MediaTrackConstraints,
      video: false,
    };
  }

  async function startRecording(mode: "tap" | "hold") {
    setErr("");
    modeRef.current = mode;

    // prepara micro
    const stream = await navigator.mediaDevices.getUserMedia(getConstraints());
    const mime = pickBestMime();

    // espera lead-in (micro “acorda”)
    await new Promise((r) => setTimeout(r, LEAD_IN_MS));

    // mediarecorder
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorderRef.current = rec;

    rec.ondataavailable = (e) => {
      if (e.data?.size) chunksRef.current.push(e.data);
    };

    // webaudio p/ VAD
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    analyserRef.current = analyser;

    lastVoiceMsRef.current = performance.now();

    // VAD loop (só auto-stop no modo TAP)
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      // RMS simples
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);

      if (rms > VAD_THRESHOLD) {
        lastVoiceMsRef.current = performance.now();
      }

      if (modeRef.current === "tap") {
        const silentFor = performance.now() - lastVoiceMsRef.current;
        if (silentFor >= SILENCE_MS) {
          // auto-stop
          stopRecording();
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rec.start(50); // timeslice para gerar chunks frequentes
    setRecState("recording");
    rafRef.current = requestAnimationFrame(tick);

    // safety-stop para TAP (não ficar infinito)
    if (modeRef.current === "tap") {
      stopTimeoutRef.current = window.setTimeout(() => {
        stopRecording();
      }, MAX_TAP_SECONDS * 1000) as unknown as number;
    }
  }

  async function stopRecording() {
    if (recState !== "recording") return;
    setRecState("processing");

    clearRaf();
    clearStopTimeout();

    // tail para não cortar a última sílaba
    await new Promise((r) => setTimeout(r, TAIL_MS));

    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    }

    // fechar audio graph
    try {
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      if (audioCtxRef.current?.state !== "closed") {
        await audioCtxRef.current?.close();
      }
    } catch {}

    // fechar tracks do micro
    const stream = (rec as any)?.stream as MediaStream | undefined;
    stream?.getTracks().forEach((t) => t.stop());

    const mime = pickBestMime();
    const blob = new Blob(chunksRef.current, { type: mime });

    try {
      const said = await sttFromBlob(blob, lang);
      setYou(said || "(sem texto)");
      if (!said) {
        setRecState("idle");
        return;
      }
      const response = await askAlma(said);
      setAlma(response || "");
      if (response && audioRef.current) {
        await speakText(response, audioRef.current);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setRecState("idle");
    }
  }

  // handlers para hold-to-talk (desktop & touch)
  const holdHandlers = {
    onMouseDown: () => startRecording("hold"),
    onMouseUp: () => stopRecording(),
    onMouseLeave: () => stopRecording(),
    onTouchStart: () => startRecording("hold"),
    onTouchEnd: () => stopRecording(),
    onTouchCancel: () => stopRecording(),
  };

  async function handleTapTalk() {
    if (recState === "idle") await startRecording("tap");
  }

  async function handleTextFlow() {
    setErr("");
    setAlma("");
    if (!typing.trim()) return;
    setYou(typing);
    try {
      const resp = await askAlma(typing.trim());
      setAlma(resp || "");
      if (resp && audioRef.current) await speakText(resp, audioRef.current);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setTyping("");
    }
  }

  useEffect(() => {
    return () => {
      clearRaf();
      clearStopTimeout();
      try {
        sourceRef.current?.disconnect();
        analyserRef.current?.disconnect();
        audioCtxRef.current?.close();
      } catch {}
    };
  }, []);

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100 p-4 flex items-center justify-center">
      <div className="w-full max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold">🎤 Alma – STT (VAD) → Grok → TTS</h1>

        <div className="flex flex-wrap gap-3">
          {/* Tap-to-talk (auto VAD) */}
          <button
            onClick={handleTapTalk}
            disabled={recState !== "idle"}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2"
          >
            {recState === "recording" ? "A gravar…" : "Falar (toque único)"}
          </button>

          {/* Hold-to-talk */}
          <button
            {...holdHandlers}
            disabled={recState === "processing"}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2"
          >
            {recState === "recording" && modeRef.current === "hold"
              ? "A gravar… (largar para enviar)"
              : "Carrega e fala (hold)"}
          </button>

          {/* Texto manual */}
          <input
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            placeholder="ou escreve aqui e carrega em Enviar…"
            className="flex-1 min-w-[12rem] rounded-md bg-zinc-800 px-3 py-2 outline-none"
          />
          <button
            onClick={handleTextFlow}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2"
          >
            Enviar
          </button>
        </div>

        <div className="rounded-lg bg-zinc-900 p-4 space-y-3">
          <div>
            <div className="text-sm text-zinc-400">Tu disseste</div>
            <div className="mt-1 whitespace-pre-wrap">{you || "—"}</div>
          </div>

          <div className="border-t border-zinc-800 my-2" />

          <div>
            <div className="text-sm text-zinc-400">Alma</div>
            <div className="mt-1 whitespace-pre-wrap">{alma || "—"}</div>
          </div>

          <audio ref={audioRef} hidden />
        </div>

        {!!err && (
          <div className="rounded-md bg-red-600/15 text-red-300 p-3">
            Alma: {err}
          </div>
        )}

        <ul className="text-xs text-zinc-500 space-y-1">
          <li>• Se ainda “come” o início, sobe o <code>LEAD_IN_MS</code> (ex.: 300–400ms).</li>
          <li>• Se corta cedo, aumenta <code>SILENCE_MS</code> (ex.: 1200ms) ou usa o modo “hold”.</li>
          <li>• Em ambientes ruidosos, sobe <code>VAD_THRESHOLD</code> para 0.03–0.05.</li>
          <li>• Garante que o teu /api/stt força <code>language=pt-PT</code> e <code>smart_format=true</code>.</li>
        </ul>
      </div>
    </main>
  );
}
