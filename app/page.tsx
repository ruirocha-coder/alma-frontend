"use client";

import { useState, useRef, useEffect } from "react";

export default function Home() {
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

  // audio refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // ganho/velocidade
  const [gain, setGain] = useState<number>(2.0);
  const [speed, setSpeed] = useState<number>(1.0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compRef = useRef<DynamicsCompressorNode | null>(null);

  // cria cadeia WebAudio uma vez
  useEffect(() => {
    if (!audioRef.current) {
      const el = document.createElement("audio");
      el.controls = false;
      el.hidden = true;
      document.body.appendChild(el);
      audioRef.current = el;
    }

    const ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const src = ctx.createMediaElementSource(audioRef.current!);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 20;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    const g = ctx.createGain();
    g.gain.value = gain;

    src.connect(comp);
    comp.connect(g);
    g.connect(ctx.destination);

    audioCtxRef.current = ctx;
    gainNodeRef.current = g;
    compRef.current = comp;

    return () => {
      try {
        src.disconnect();
        comp.disconnect();
        g.disconnect();
        ctx.close();
      } catch {}
    };
  }, []);

  // atualiza ganho
  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = gain;
  }, [gain]);

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      // pequeno atraso para não cortar fim
      await new Promise((r) => setTimeout(r, 250));
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      await handleSTT(blob);
    };

    recorder.start();
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  async function handleSTT(blob: Blob) {
    setLoading(true);
    setTranscript("");
    setAnswer("");

    try {
      const res = await fetch("/api/stt", {
        method: "POST",
        body: blob,
      });

      if (!res.ok) throw new Error("Falha no STT");
      const data = await res.json();
      const text = data.transcript || "";
      setTranscript(text);

      if (text) {
        await askAlma(text);
      }
    } catch (e) {
      setTranscript("❌ Não consegui transcrever o áudio.");
    } finally {
      setLoading(false);
    }
  }

  async function askAlma(question: string) {
    setAnswer("…");
    try {
      const res = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      const reply = data.answer || "";
      setAnswer(reply);
      if (reply) await speak(reply);
    } catch (e) {
      setAnswer("❌ Erro a contactar Alma.");
    }
  }

  async function speak(text: string) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("Erro no TTS");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.playbackRate = speed;
        await audioRef.current.play();
      }
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <main className="flex flex-col items-center p-6">
      <h1 className="text-2xl font-bold mb-4">Alma 🎙️</h1>

      <div className="flex gap-4 mb-4">
        <button
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          className="px-4 py-2 bg-blue-600 text-white rounded"
        >
          🎤 Segurar para falar
        </button>
      </div>

      {loading && <p>⏳ A transcrever…</p>}
      {transcript && (
        <p className="mt-2 text-gray-700">
          <strong>Tu:</strong> {transcript}
        </p>
      )}
      {answer && (
        <p className="mt-2 text-gray-900">
          <strong>Alma:</strong> {answer}
        </p>
      )}

      <div className="mt-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <label className="text-sm opacity-80">🔊 Ganho</label>
          <input
            type="range"
            min={1}
            max={3}
            step={0.1}
            value={gain}
            onChange={(e) => setGain(parseFloat(e.target.value))}
            className="w-40"
          />
          <span>{gain.toFixed(1)}×</span>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm opacity-80">⏩ Velocidade</label>
          <input
            type="range"
            min={0.8}
            max={1.2}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            className="w-40"
          />
          <span>{speed.toFixed(2)}×</span>
        </div>
      </div>

      <button
        onClick={() => speak("Olá, eu sou a Alma. Vamos testar o som.")}
        className="mt-6 px-3 py-2 bg-gray-200 rounded"
      >
        🔊 Testar voz
      </button>
    </main>
  );
}
