"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "you" | "alma"; text: string };

const ALMA_URL =
  process.env.NEXT_PUBLIC_ALMA_SERVER_URL ??
  process.env.NEXT_PUBLIC_ALMA_ASK_URL ?? // opcional se usaste outro nome
  "";

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // util: append message
  function push(role: Msg["role"], text: string) {
    setMessages((m) => [...m, { role, text }]);
  }

  // ---- Alma (LLM externo) ----
  async function askAlma(question: string): Promise<string> {
    if (!ALMA_URL) throw new Error("⚠️ NEXT_PUBLIC_ALMA_SERVER_URL em falta.");
    const r = await fetch(ALMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Erro do Alma-server (${r.status}): ${txt.slice(0, 400)}`);
    }
    const j = await r.json().catch(() => ({}));
    return j.answer ?? "";
  }

  // ---- STT (Deepgram via /api/stt) ----
  async function stt(blob: Blob): Promise<string> {
    const form = new FormData();
    form.append("audio", blob, "audio.webm");
    // força idioma pt-PT
    const r = await fetch("/api/stt?lang=pt-PT", { method: "POST", body: form });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`STT ${r.status}: ${t.slice(0, 400)}`);
    }
    const j = await r.json();
    if (!j.transcript) throw new Error(j.error || "Falha na transcrição");
    return j.transcript as string;
  }

  // ---- TTS (ElevenLabs via /api/tts) ----
  async function ttsSpeak(text: string) {
    // devolve audio/mpeg; aqui criamos objectURL e tocamos
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: "pt-PT" }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`TTS ${r.status}: ${t.slice(0, 400)}`);
    }
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    if (!audioRef.current) return;
    audioRef.current.src = url;
    audioRef.current.play().catch(() => {
      // caso autoplay bloqueado, o utilizador tem de clicar
    });
  }

  // ---- Microfone (push-to-talk) ----
  async function startRecording() {
    setErrors(null);
    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        } as MediaTrackConstraints,
      });

      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstart = () => setRecording(true);
      rec.start();

      mediaRecorderRef.current = rec;
    } catch (e: any) {
      setErrors(e?.message || String(e));
    }
  }

  async function stopRecording() {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    setRecording(false);

    // espera pelos últimos pacotes
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await stopped;

    const stream = rec.stream;
    stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(chunksRef.current, {
      type: rec.mimeType || "audio/webm",
    });
    chunksRef.current = [];
    mediaRecorderRef.current = null;

    // pipeline voz → texto → alma → fala
    try {
      setBusy(true);
      const transcript = await stt(blob);
      push("you", transcript);

      const answer = await askAlma(transcript);
      push("alma", answer);
      await ttsSpeak(answer);
    } catch (e: any) {
      setErrors(e?.message || String(e));
      push("alma", "⚠️ Não consegui transcrever/responder. Tenta outra vez.");
    } finally {
      setBusy(false);
    }
  }

  // ---- Texto → Alma ----
  async function sendText() {
    if (!input.trim()) return;
    const q = input.trim();
    setInput("");
    push("you", q);
    try {
      setBusy(true);
      const answer = await askAlma(q);
      push("alma", answer);
      await ttsSpeak(answer);
    } catch (e: any) {
      setErrors(e?.message || String(e));
      push("alma", "⚠️ Erro a pedir resposta à Alma.");
    } finally {
      setBusy(false);
    }
  }

  // tecla Enter para enviar
  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      sendText();
    }
  }

  // limpar objectURL quando troca o áudio
  useEffect(() => {
    return () => {
      if (audioRef.current?.src.startsWith("blob:")) {
        URL.revokeObjectURL(audioRef.current.src);
      }
    };
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50 px-4 py-6">
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <h1 className="text-xl font-semibold">🎙️ Alma — voz & texto</h1>

        {/* Área de mensagens */}
        <div className="bg-zinc-900 rounded-lg p-4 h-[44vh] overflow-y-auto border border-zinc-800">
          {messages.length === 0 ? (
            <p className="text-zinc-400">
              Mantém o botão <span className="font-medium">FALAR</span> carregado para ditar,
              ou escreve abaixo e carrega em <span className="font-medium">Enviar</span>.
            </p>
          ) : (
            <ul className="space-y-3">
              {messages.map((m, i) => (
                <li key={i}>
                  <span
                    className={
                      m.role === "you"
                        ? "text-emerald-400 font-medium"
                        : "text-sky-400 font-medium"
                    }
                  >
                    {m.role === "you" ? "Tu" : "Alma"}:
                  </span>{" "}
                  <span className="whitespace-pre-wrap">{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Controlo de áudio */}
        <div className="flex items-center gap-3">
          <button
            className={`px-4 py-2 rounded-md border ${
              recording ? "bg-red-600 border-red-500" : "bg-zinc-800 border-zinc-700"
            }`}
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onTouchStart={(e) => {
              e.preventDefault();
              startRecording();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              stopRecording();
            }}
            disabled={busy}
            aria-pressed={recording}
            title="Carrega e mantém para falar"
          >
            {recording ? "● A gravar (largar para enviar)" : "🎤 FALAR (manter)"}
          </button>

          <button
            className="px-3 py-2 rounded-md border bg-zinc-800 border-zinc-700"
            onClick={() => {
              const sample = "Olá! Sou a Alma. Como posso ajudar-te hoje?";
              push("alma", sample);
              ttsSpeak(sample).catch((e) => setErrors(String(e)));
            }}
          >
            🔊 Testar voz
          </button>

          {busy && <span className="text-sm text-zinc-400">a pensar…</span>}
        </div>

        {/* Texto */}
        <div className="flex items-start gap-2">
          <textarea
            className="flex-1 rounded-md border bg-zinc-900 border-zinc-800 p-3 h-24"
            placeholder="Escreve aqui… (Enter para enviar)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <button
            className="px-4 py-2 h-10 mt-1 rounded-md border bg-sky-600 border-sky-500"
            onClick={sendText}
            disabled={busy || !input.trim()}
          >
            Enviar
          </button>
        </div>

        {/* Áudio player escondido */}
        <audio ref={audioRef} hidden />

        {/* Erros */}
        {errors && (
          <div className="text-amber-400 text-sm">
            ⚠️ {errors}
            <button
              className="ml-2 underline"
              onClick={() => setErrors(null)}
              aria-label="Fechar erro"
            >
              fechar
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
