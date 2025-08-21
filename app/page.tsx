"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "alma"; text: string };

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isHolding, setIsHolding] = useState(false);
  const [recordingSupported, setRecordingSupported] = useState<boolean>(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const lastAnswerRef = useRef<string>("");

  // ---------- AUDIO: criar um único <audio> e desbloquear no iOS ----------
  useEffect(() => {
    const el = document.createElement("audio");
    el.setAttribute("playsinline", "true");
    el.preload = "auto";
    el.muted = false;
    audioRef.current = el;

    // tentativa de “unlock” no primeiro toque/clique
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      try {
        // cria um buffer curtinho de 0.01s em silêncio (WebAudio) — se falhar, ignoramos
        const ctx = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
        const src = ctx.createBufferSource();
        const buf = ctx.createBuffer(1, 220, 22050);
        src.buffer = buf;
        src.connect(ctx.destination);
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        src.start(0);
        audioUnlockedRef.current = true;
        console.log("[audio] desbloqueado");
      } catch {
        // fallback: considerar desbloqueado depois de um gesto
        audioUnlockedRef.current = true;
      }
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    };

    window.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("click", unlock);

    return () => {
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    };
  }, []);

  // ---------- STT: começar a gravar no “hold” ----------
  const startHold = useCallback(async () => {
    try {
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        setRecordingSupported(false);
        console.warn("[stt] MediaRecorder não suportado");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/mpeg",
      ];
      let mimeType = "";
      for (const c of mimeCandidates) {
        if (MediaRecorder.isTypeSupported(c)) {
          mimeType = c;
          break;
        }
      }
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void sendAudioForSTT(new Blob(chunksRef.current, { type: mimeType || "audio/webm" }));
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setIsHolding(true);
      console.log("[stt] recording start mime:", mimeType || "(default)");
    } catch (e) {
      console.error("[stt] erro a iniciar microfone:", e);
      setRecordingSupported(false);
    }
  }, []);

  // ---------- STT: parar no “release” ----------
  const stopHold = useCallback(() => {
    try {
      mediaRecorderRef.current?.stop();
      setIsHolding(false);
      console.log("[stt] recording stop");
    } catch (e) {
      console.error("[stt] erro a parar:", e);
    }
  }, []);

  // ---------- Enviar blob para /api/stt ----------
  async function sendAudioForSTT(blob: Blob) {
    try {
      const fd = new FormData();
      fd.append("file", blob, "fala.webm");
      const r = await fetch("/api/stt", { method: "POST", body: fd });
      if (!r.ok) {
        const txt = await r.text();
        console.error("[stt] falhou:", r.status, txt);
        pushAlma("Não consegui transcrever o áudio. Tenta falar um pouco mais perto do microfone.");
        return;
      }
      const j = await r.json();
      const transcript = (j.text || j.transcript || "").trim();
      if (!transcript) {
        pushAlma("Não apanhei nada. Podes repetir, por favor?");
        return;
      }
      pushUser(transcript);
      await askAlma(transcript);
    } catch (e: any) {
      console.error("[stt] erro:", e);
      pushAlma("Erro no STT. Tenta novamente.");
    }
  }

  // ---------- Conversa com o LLM (Alma-server) ----------
  async function askAlma(question: string) {
    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!r.ok) {
        const txt = await r.text();
        console.error("[alma] erro:", r.status, txt);
        pushAlma("Erro a contactar o Alma-server.");
        return;
      }
      const { answer } = await r.json();
      lastAnswerRef.current = answer || "";
      pushAlma(lastAnswerRef.current);
      if (lastAnswerRef.current) {
        await speak(lastAnswerRef.current);
      }
    } catch (e) {
      console.error("[alma] exceção:", e);
      pushAlma("Erro inesperado no Alma-server.");
    }
  }

  // ---------- TTS: aceita binário OU JSON base64 ----------
  async function speak(text: string) {
    if (!audioRef.current) return;
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!r.ok) {
        const txt = await r.text();
        console.error("[tts] falhou:", r.status, txt);
        return;
      }

      const ct = r.headers.get("content-type") || "";

      if (ct.includes("audio/")) {
        // backend devolve binário (audio/mpeg)
        const buf = await r.arrayBuffer();
        const blob = new Blob([buf], { type: ct });
        const url = URL.createObjectURL(blob);
        audioRef.current.pause();
        audioRef.current.src = url;
        await audioRef.current.play();
        console.log("[tts] reproduzido (binário)");
        // libertar URL depois de tocar
        audioRef.current.onended = () => URL.revokeObjectURL(url);
      } else {
        // backend devolve JSON com base64
        const j = await r.json();
        const b64: string =
          j.audio ||
          j.audioBase64 ||
          j.data ||
          "";
        if (!b64) {
          console.warn("[tts] JSON sem base64");
          return;
        }
        audioRef.current.pause();
        audioRef.current.src = `data:audio/mpeg;base64,${b64}`;
        await audioRef.current.play();
        console.log("[tts] reproduzido (base64)");
      }
    } catch (e: any) {
      console.error("[tts] exceção:", e?.message || e);
    }
  }

  // ---------- UI helpers ----------
  function pushUser(t: string) {
    setMessages((m) => [...m, { role: "user", text: t }]);
  }
  function pushAlma(t: string) {
    setMessages((m) => [...m, { role: "alma", text: t }]);
  }

  // mensagem inicial
  useEffect(() => {
    if (messages.length === 0) {
      pushAlma("Olá, sou a Alma. Carrega e mantém o botão para falar comigo.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-dvh flex flex-col items-center gap-6 p-4 text-zinc-100 bg-zinc-950">
      <h1 className="text-xl font-semibold">🎙️ Alma — voz</h1>

      <div className="w-full max-w-2xl flex flex-col gap-3">
        <div className="rounded-lg border border-zinc-800 p-3 h-[46vh] overflow-y-auto bg-zinc-900/40">
          {messages.map((m, i) => (
            <div key={i} className={`mb-2 ${m.role === "user" ? "text-right" : "text-left"}`}>
              <div
                className={`inline-block px-3 py-2 rounded-md ${
                  m.role === "user" ? "bg-sky-600/30 border border-sky-600/40" : "bg-zinc-800/60 border border-zinc-700/60"
                }`}
              >
                <span className="text-xs opacity-70 mr-2">{m.role === "user" ? "Tu" : "Alma"}</span>
                <span>{m.text}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
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
            className={`px-4 py-3 rounded-md font-medium border ${
              isHolding ? "bg-red-600/60 border-red-500" : "bg-zinc-800 border-zinc-700"
            }`}
          >
            {isHolding ? "🎙️ A gravar… solta para enviar" : "🎙️ Carrega e mantém para falar"}
          </button>

          <button
            onClick={() => {
              const t = "Teste de voz da Alma.";
              lastAnswerRef.current = t;
              pushAlma(t);
              void speak(t);
            }}
            className="px-3 py-3 rounded-md bg-zinc-800 border border-zinc-700"
          >
            🔊 Testar voz
          </button>

          {!recordingSupported && (
            <span className="text-amber-400 text-sm">
              O teu browser não suporta gravação. Tenta Chrome/Safari atualizados.
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
