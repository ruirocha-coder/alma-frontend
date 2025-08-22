"use client";

import React, { useEffect, useRef, useState } from "react";

/* =======================
   ÁUDIO: desbloqueio iOS/Android + safe play
   ======================= */

let _ctx: AudioContext | null = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  // @ts-ignore
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!_ctx && AC) _ctx = new AC();
  return _ctx;
}

// toca um buffer silencioso após gesto — “desbloqueia” autoplay
async function unlockAudio(): Promise<boolean> {
  const ctx = getAudioCtx();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {}
  }
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    return true;
  } catch {
    return false;
  }
}

async function safePlay(el: HTMLAudioElement): Promise<boolean> {
  try {
    await el.play();
    return true;
  } catch (e: any) {
    if (e?.name === "NotAllowedError") return false; // bloqueado por autoplay
    throw e;
  }
}

/* =======================
   Página
   ======================= */

type Msg = { role: "user" | "alma" | "sys"; text: string };

export default function Page() {
  // UI & estado
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "sys", text: "Dica: usa o botão Manter para falar, ou escreve na caixa." },
  ]);
  const [busy, setBusy] = useState(false);

  // Áudio
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // Gravação (hold)
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  /* ---------- setup do elemento <audio> ---------- */
  useEffect(() => {
    const a = new Audio();
    a.playsInline = true as any;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;
  }, []);

  /* ---------- tentar desbloquear no 1º gesto ---------- */
  useEffect(() => {
    const handler = async () => {
      const ok = await unlockAudio();
      setAudioUnlocked(ok);
      setAudioBlocked(!ok);
      window.removeEventListener("touchstart", handler);
      window.removeEventListener("click", handler);
    };
    window.addEventListener("touchstart", handler, { once: true });
    window.addEventListener("click", handler, { once: true });
    return () => {
      window.removeEventListener("touchstart", handler);
      window.removeEventListener("click", handler);
    };
  }, []);

  /* =======================
     Funções auxiliares (network)
     ======================= */

  // 1) perguntar ao Alma (teu backend Grok)
  async function askAlma(question: string): Promise<string> {
    const r = await fetch("/api/alma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Erro no /api/alma: ${r.status} ${t.slice(0, 400)}`);
    }
    const j = await r.json();
    return j.answer ?? "";
  }

  // 2) TTS → devolve Blob (mp3/wav) e faz play com fallback de desbloqueio
  async function speak(text: string) {
    // fetch TTS
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Erro no /api/tts: ${r.status} ${t.slice(0, 300)}`);
    }
    const blob = await r.blob();
    await playTTSFromBlob(blob);
  }

  async function playTTSFromBlob(ttsBlob: Blob) {
    const el = ttsAudioRef.current!;
    try {
      // libertar URL anterior (evitar leaks)
      if (el.src) URL.revokeObjectURL(el.src);
    } catch {}
    el.src = URL.createObjectURL(ttsBlob);
    const ok = await safePlay(el);
    if (!ok) {
      setAudioBlocked(true);
    } else {
      setAudioBlocked(false);
    }
  }

  // 3) STT: envia Blob (webm/wav) ao teu /api/stt via FormData
  async function sttFromBlob(blob: Blob, langHint?: string): Promise<string> {
    const fd = new FormData();
    fd.append("file", blob, blob.type.startsWith("audio/") ? `audio.${blob.type.split("/")[1]}` : "audio.webm");
    if (langHint) fd.append("lang", langHint);
    const r = await fetch("/api/stt", {
      method: "POST",
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.transcript) {
      throw new Error(`STT ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return j.transcript as string;
  }

  /* =======================
     Envio por TEXTO
     ======================= */

  async function onSendText(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMsgs(m => [...m, { role: "user", text }]);
    try {
      setBusy(true);
      const answer = await askAlma(text);
      setMsgs(m => [...m, { role: "alma", text: answer }]);
      await speak(answer); // 🔊 falar a resposta
    } catch (err: any) {
      setMsgs(m => [...m, { role: "sys", text: "⚠️ " + (err?.message || String(err)) }]);
    } finally {
      setBusy(false);
    }
  }

  /* =======================
     FALAR: botão “Manter para falar”
     ======================= */

  async function startRecording() {
    try {
      // garante gesto + desbloqueio áudio (importante em iOS)
      await unlockAudio();

      // pede micro
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        } as any,
      });
      mediaStreamRef.current = stream;

      // tenta webm + fallback para áudio puro
      const prefer = "audio/webm;codecs=opus";
      const mimeType = MediaRecorder.isTypeSupported(prefer) ? prefer : "audio/webm";
      const mr = new MediaRecorder(stream, { mimeType });

      chunksRef.current = [];
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      mr.onstart = () => setIsRecording(true);
      mr.onstop = async () => {
        setIsRecording(false);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        chunksRef.current = [];

        try {
          setBusy(true);
          // 1) STT
          const transcript = await sttFromBlob(blob, "pt");
          setMsgs(m => [...m, { role: "user", text: transcript }]);

          // 2) A Alma responde
          const answer = await askAlma(transcript);
          setMsgs(m => [...m, { role: "alma", text: answer }]);

          // 3) Fala a resposta
          await speak(answer);
        } catch (err: any) {
          setMsgs(m => [...m, { role: "sys", text: "⚠️ Falha na transcrição / resposta: " + (err?.message || String(err)) }]);
        } finally {
          setBusy(false);
        }

        // limpar o micro
        stream.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
        mediaRecRef.current = null;
      };

      mediaRecRef.current = mr;
      mr.start(); // sem timeslice: um único blob no fim
    } catch (err: any) {
      setIsRecording(false);
      setMsgs(m => [...m, { role: "sys", text: "⚠️ Não consegui iniciar o micro: " + (err?.message || String(err)) }]);
    }
  }

  function stopRecording() {
    try {
      mediaRecRef.current?.stop();
    } catch {}
  }

  /* =======================
     UI
     ======================= */

  return (
    <main className="mx-auto max-w-3xl p-4 flex flex-col gap-4">
      <h1 className="text-xl font-semibold">🎭 Alma — voz & texto</h1>

      {/* Botão explícito para desbloquear som quando bloqueado */}
      {(!audioUnlocked || audioBlocked) && (
        <div className="flex items-center gap-3">
          <button
            className="px-3 py-2 rounded bg-emerald-600 text-white"
            onClick={async () => {
              const ok = await unlockAudio();
              setAudioUnlocked(ok);
              setAudioBlocked(!ok);
            }}
          >
            Ativar som
          </button>
          <span className="text-sm text-zinc-400">Se o iOS bloquear, toca aqui uma vez.</span>
        </div>
      )}

      {/* Histórico */}
      <div className="rounded border border-zinc-700 p-3 h-72 overflow-auto bg-zinc-900/40">
        {msgs.map((m, i) => (
          <div key={i} className="mb-2">
            <span
              className={
                m.role === "user"
                  ? "text-sky-300"
                  : m.role === "alma"
                  ? "text-emerald-300"
                  : "text-amber-300"
              }
            >
              {m.role === "user" ? "Tu" : m.role === "alma" ? "Alma" : "•"}
              :
            </span>{" "}
            <span className="whitespace-pre-wrap">{m.text}</span>
          </div>
        ))}
      </div>

      {/* Caixa de texto */}
      <form onSubmit={onSendText} className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-100"
          placeholder="Escreve aqui…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          className="px-3 py-2 rounded bg-sky-600 text-white disabled:opacity-50"
          disabled={busy || !input.trim()}
        >
          Enviar
        </button>
      </form>

      {/* Botão “Manter para falar” */}
      <div className="flex items-center gap-3">
        <button
          className={`px-4 py-3 rounded text-white ${
            isRecording ? "bg-red-600" : "bg-emerald-600"
          }`}
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onMouseLeave={() => isRecording && stopRecording()}
          onTouchStart={(e) => {
            e.preventDefault();
            startRecording();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            stopRecording();
          }}
          disabled={busy}
          aria-pressed={isRecording}
        >
          {isRecording ? "A gravar…" : "Manter para falar"}
        </button>
        <span className="text-sm text-zinc-400">
          Mantém carregado para gravar. Solta para enviar.
        </span>
      </div>

      {/* Testar voz direta */}
      <div className="flex items-center gap-3">
        <button
          className="px-3 py-2 rounded bg-indigo-600 text-white"
          onClick={() => speak("Olá, sou a Alma. Já posso falar em voz!")}
        >
          Testar voz
        </button>
      </div>

      {/* elemento <audio> invisível */}
      <audio ref={ttsAudioRef} style={{ display: "none" }} />
    </main>
  );
}
