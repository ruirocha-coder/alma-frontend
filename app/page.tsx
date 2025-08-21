"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "alma" | "system"; text: string };

export default function Page() {
  // UI state
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "system",
      text:
        "🎧 Mantém o botão premido para falar. Solta para eu responder. Ou escreve abaixo.",
    },
  ]);
  const [input, setInput] = useState("");
  const [recording, setRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Mic & Recorder
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const preferredMime = useRef<string>("");

  // Audio TTS
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ensureAudio = () => {
    if (!audioRef.current) {
      const el = document.createElement("audio");
      el.setAttribute("playsinline", "true");
      el.preload = "auto";
      document.body.appendChild(el);
      audioRef.current = el;
    }
  };

  const speak = useCallback(async (text: string) => {
    try {
      ensureAudio();
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`TTS error: ${r.status} ${t}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const el = audioRef.current!;
      el.src = url;

      await el.play().catch(async () => {
        // 2ª tentativa (iOS às vezes precisa de mais do que 1 chamada)
        await el.play();
      });

      el.onended = () => URL.revokeObjectURL(url);
    } catch (e: any) {
      console.error("Erro a reproduzir TTS:", e?.message || e);
      setErr("Não consegui reproduzir áudio agora.");
    }
  }, []);

  // Permissões micro
  const askMic = useCallback(async () => {
    try {
      if (streamRef.current) return;

      // Descobre um MIME suportado
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
      ];
      const ok = candidates.find((c) => MediaRecorder.isTypeSupported(c));
      preferredMime.current = ok || "";

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      streamRef.current = stream;
      setErr(null);
      setMessages((m) => [
        ...m,
        { role: "system", text: "✅ Microfone autorizado." },
      ]);
    } catch (e: any) {
      console.error(e);
      setErr("Não consegui aceder ao microfone.");
    }
  }, []);

  // Gravação
  const startRecording = useCallback(async () => {
    try {
      if (!streamRef.current) await askMic();
      if (!streamRef.current) return;

      chunksRef.current = [];
      const rec = new MediaRecorder(streamRef.current, {
        mimeType: preferredMime.current || undefined,
        audioBitsPerSecond: 128000,
      });
      recRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.start();
      setRecording(true);
      setErr(null);
    } catch (e: any) {
      console.error(e);
      setErr("Falha ao iniciar gravação.");
    }
  }, [askMic]);

  const stopRecording = useCallback(async () => {
    try {
      const rec = recRef.current;
      if (!rec || rec.state === "inactive") return;

      const stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
      setRecording(false);
      await stopped;

      const mime =
        preferredMime.current ||
        (chunksRef.current[0] as any)?.type ||
        "audio/webm";

      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];

      // 1) STT
      setIsThinking(true);
      const text = await transcribe(blob, mime);
      if (!text) {
        setIsThinking(false);
        return;
      }
      setMessages((m) => [...m, { role: "user", text }]);

      // 2) Grok (Alma)
      const answer = await askAlma(text);
      setMessages((m) => [...m, { role: "alma", text: answer }]);

      // 3) TTS
      await speak(answer);
      setIsThinking(false);
    } catch (e: any) {
      console.error(e);
      setErr("Falha ao terminar gravação.");
      setIsThinking(false);
    }
  }, [speak]);

  // STT helper
  async function transcribe(blob: Blob, mime: string): Promise<string | null> {
    try {
      const fd = new FormData();
      fd.append("audio", blob, `audio.${mime.includes("mp4") ? "mp4" : "webm"}`);
      fd.append("mime", mime);

      const r = await fetch("/api/stt", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        setErr(`Erro no STT: ${t || r.status}`);
        return null;
      }
      const j = (await r.json()) as { text?: string };
      if (!j?.text) {
        setErr("Não consegui transcrever o áudio. Tenta falar mais perto.");
        return null;
      }
      return j.text;
    } catch (e: any) {
      console.error(e);
      setErr("Não consegui transcrever o áudio. Tenta falar mais perto.");
      return null;
    }
  }

  // Alma helper (Grok)
  async function askAlma(question: string): Promise<string> {
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(t || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { answer?: string };
      return j.answer || "Não consegui obter resposta agora.";
    } catch (e: any) {
      console.error(e);
      return "Tive um problema a contactar o cérebro (Grok).";
    }
  }

  // Envio por texto
  const sendText = useCallback(async () => {
    const q = input.trim();
    if (!q) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setIsThinking(true);
    const a = await askAlma(q);
    setMessages((m) => [...m, { role: "alma", text: a }]);
    await speak(a);
    setIsThinking(false);
  }, [input, speak]);

  // Tecla Enter envia
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendText();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sendText]);

  // UI
  return (
    <div className="min-h-dvh w-full max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4 text-zinc-100 bg-zinc-950">
      <h1 className="text-xl font-semibold">Alma — voz em tempo quase real</h1>

      <div className="flex gap-2">
        <button
          className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700"
          onClick={askMic}
        >
          Permitir micro
        </button>
        <button
          className={`px-3 py-2 rounded ${
            recording ? "bg-red-600" : "bg-emerald-700 hover:bg-emerald-600"
          }`}
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onTouchStart={startRecording}
          onTouchEnd={stopRecording}
        >
          {recording ? "A gravar… solta para enviar" : "Manter premido para falar"}
        </button>
        <button
          className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700"
          onClick={() => speak("Teste de voz da Alma. 1, 2, 3.")}
        >
          Testar voz
        </button>
      </div>

      {isThinking && (
        <div className="text-sm text-zinc-300">A pensar…</div>
      )}

      {err && (
        <div className="text-sm text-red-400">⚠️ {err}</div>
      )}

      <div className="flex flex-col gap-2 border border-zinc-800 rounded p-3 max-h-[50vh] overflow-auto">
        {messages.map((m, i) => (
          <div key={i}>
            <span
              className={`text-xs mr-2 ${
                m.role === "user"
                  ? "text-sky-400"
                  : m.role === "alma"
                  ? "text-emerald-400"
                  : "text-zinc-400"
              }`}
            >
              {m.role.toUpperCase()}
            </span>
            <span className="whitespace-pre-wrap">{m.text}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 rounded bg-zinc-900 border border-zinc-800"
          placeholder="Escreve aqui… (⌘/Ctrl + Enter para enviar)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700"
          onClick={sendText}
        >
          Enviar
        </button>
      </div>
    </div>
  );
}
