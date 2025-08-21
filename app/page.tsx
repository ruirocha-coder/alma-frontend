"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

/** 🔊 Reprodutor único (evita bloqueios de autoplay no iOS/Chrome) */
let __almaAudio: HTMLAudioElement | null = null;
async function ensureAudioReady() {
  if (!__almaAudio) {
    __almaAudio = new Audio();
    __almaAudio.preload = "auto";
    __almaAudio.volume = 1.0; // mais alto por defeito
  }
  // Destrava áudio em browsers que exigem gesto do utilizador
  try {
    await __almaAudio.play().catch(() => {});
    __almaAudio.pause();
  } catch {}
}

/** Faz TTS chamando /api/tts e toca o áudio */
async function speak(text: string) {
  const t = text?.trim();
  if (!t) return;
  await ensureAudioReady();

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: t }),
  });

  if (!res.ok) {
    console.error("TTS falhou:", await res.text());
    return;
  }

  const blob = await res.blob(); // deve ser audio/mpeg
  const url = URL.createObjectURL(blob);
  try {
    __almaAudio!.src = url;
    __almaAudio!.load();
    await __almaAudio!.play();
  } catch (e) {
    console.error("Falha a tocar áudio:", e);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

type Msg = { role: "you" | "alma"; text: string };

export default function Page() {
  // conversa
  const [messages, setMessages] = useState<Msg[]>([]);
  // input de texto
  const [text, setText] = useState("");
  // estados de voz
  const [isHolding, setIsHolding] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [error, setError] = useState<string>("");

  // MediaRecorder
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  /** ====== HELPERS DE UI ====== */
  const pushMsg = useCallback((m: Msg) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const askAlma = useCallback(async (question: string, speakIt = true) => {
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const j = await r.json();
      const answer = (j?.answer ?? "").toString();
      pushMsg({ role: "alma", text: answer });
      if (speakIt) {
        await speak(answer);
      }
    } catch (e: any) {
      const t = "Erro a contactar a Alma: " + (e?.message || String(e));
      pushMsg({ role: "alma", text: t });
    }
  }, [pushMsg]);

  /** ====== TEXTO → ALMA ====== */
  const onSubmitText = useCallback(async () => {
    const q = text.trim();
    if (!q) return;
    setText("");
    setError("");
    pushMsg({ role: "you", text: q });
    await askAlma(q, true);
  }, [text, askAlma, pushMsg]);

  /** ====== VOZ (HOLD-TO-TALK) ====== */

  // Pede permissões e cria MediaRecorder com o codec suportado
  const getRecorder = useCallback(async (): Promise<MediaRecorder> => {
    // preferimos opus webm (leve e compatível); se falhar, caímos para wav
    const constraints: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    mediaStreamRef.current = stream;

    let recorder: MediaRecorder;
    const mimeWebm = "audio/webm;codecs=opus";
    if (MediaRecorder.isTypeSupported(mimeWebm)) {
      recorder = new MediaRecorder(stream, { mimeType: mimeWebm, audioBitsPerSecond: 128000 });
      (recorder as any).__mime = "webm";
    } else {
      // fallback para wav: vamos gravar raw PCM via webm e o backend faz o melhor; se tiveres
      // endpoint específico para wav, podes trocar
      recorder = new MediaRecorder(stream);
      (recorder as any).__mime = "webm";
    }
    return recorder;
  }, []);

  const startHold = useCallback(async () => {
    try {
      setError("");
      setIsHolding(true);
      setIsRecording(false);
      chunksRef.current = [];

      const rec = await getRecorder();
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstart = () => setIsRecording(true);
      rec.onstop = () => setIsRecording(false);

      rec.start(250); // intervalos pequenos → menos risco de chunk corrompido
    } catch (e: any) {
      setError("Não consegui aceder ao microfone: " + (e?.message || String(e)));
      setIsHolding(false);
    }
  }, [getRecorder]);

  const stopHold = useCallback(async () => {
    setIsHolding(false);
    const rec = mediaRecorderRef.current;
    if (!rec) return;

    // parar gravação
    rec.state !== "inactive" && rec.stop();

    // fechar micro (evita “dispositivos presos” no iOS)
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;

    // juntar blobs
    const blob = new Blob(chunksRef.current, { type: (rec as any).__mime === "webm" ? "audio/webm" : "audio/webm" });
    chunksRef.current = [];

    if (!blob || blob.size < 1024) {
      setError("⚠️ Falha na transcrição (áudio quase vazio)");
      return;
    }

    // enviar para STT
    try {
      const fd = new FormData();
      fd.append("file", blob, "input.webm");

      const stt = await fetch("/api/stt", { method: "POST", body: fd });
      const j = await stt.json();

      if (!stt.ok) {
        setError(`⚠️ STT ${stt.status}: ${JSON.stringify(j)}`);
        return;
      }

      const transcript = (j?.transcript ?? "").toString().trim();
      if (!transcript) {
        setError("⚠️ Falha na transcrição");
        return;
      }

      setLastTranscript(transcript);
      pushMsg({ role: "you", text: transcript });

      // pergunta à Alma e FALA a resposta
      await askAlma(transcript, true);
    } catch (e: any) {
      setError("Erro no STT: " + (e?.message || String(e)));
    }
  }, [askAlma, pushMsg]);

  /** ====== UI ====== */
  useEffect(() => {
    // rolar para o fim quando chegam mensagens
    const el = document.getElementById("msgs-bottom");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-[840px] p-4 sm:p-6">
        <header className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-lg sm:text-xl font-semibold">🎭 Alma — Conversa (voz + texto)</h1>
          <div className="flex gap-2">
            <button
              onClick={ensureAudioReady}
              className="px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700"
              title="Destravar áudio no browser"
            >
              Permitir áudio
            </button>
            <button
              onClick={() => speak("Olá! Este é um teste de voz da Alma.")}
              className="px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700"
              title="Testar saída de voz"
            >
              Testar TTS
            </button>
          </div>
        </header>

        {/* Mensagens */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 sm:p-4 h-[48dvh] overflow-y-auto">
          {messages.length === 0 && (
            <div className="opacity-70 text-sm">
              Fala mantendo o botão <em>Carregar para Falar</em>, ou escreve em baixo e carrega em <em>Enviar</em>.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`mb-3 ${m.role === "you" ? "text-right" : "text-left"}`}>
              <div
                className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "you" ? "bg-sky-700/70" : "bg-zinc-800/80"
                }`}
              >
                <div className="opacity-75 text-[11px] mb-0.5">{m.role === "you" ? "Tu" : "Alma"}</div>
                <div className="whitespace-pre-wrap">{m.text}</div>
              </div>
            </div>
          ))}
          <div id="msgs-bottom" />
        </section>

        {/* Estado/erros */}
        <div className="mt-2 text-xs opacity-80">
          {isHolding ? (
            <span className="text-amber-300">A gravar… {isRecording ? "(micro ativo)" : "(a iniciar…)"}</span>
          ) : lastTranscript ? (
            <span className="text-zinc-400">Última transcrição: “{lastTranscript}”</span>
          ) : null}
          {error && <div className="text-rose-400 mt-1">⚠️ {error}</div>}
        </div>

        {/* Controlo de voz */}
        <div className="mt-4 flex items-center gap-3">
          <button
            onMouseDown={startHold}
            onMouseUp={stopHold}
            onTouchStart={(e) => {
              e.preventDefault();
              startHold();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              stopHold();
            }}
            className={`select-none px-4 py-3 rounded-lg font-medium ${
              isHolding ? "bg-rose-600" : "bg-rose-700 hover:bg-rose-600 active:bg-rose-800"
            }`}
          >
            {isHolding ? "A gravar… largar para enviar" : "🎙️ Carregar para Falar"}
          </button>

          <button
            onClick={() => {
              // fallback: força pedir permissão/“acordar” áudio
              ensureAudioReady();
              navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
            }}
            className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700"
          >
            Dar permissão de micro (se precisar)
          </button>
        </div>

        {/* Input de texto */}
        <div className="mt-4 flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) onSubmitText();
            }}
            placeholder="Escreve aqui…"
            className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-600"
          />
          <button
            onClick={onSubmitText}
            className="px-4 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 active:bg-sky-800 font-medium"
          >
            Enviar
          </button>
        </div>
      </div>
    </main>
  );
}
