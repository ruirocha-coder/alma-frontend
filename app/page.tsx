"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

type AskResponse = { answer?: string; error?: string };
type SttResponse = { transcript?: string; error?: string };

export default function Page() {
  // UI state
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [isHolding, setIsHolding] = useState(false);

  // Audio + gravação
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const mediaRecorderRef = useRef<any>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // ---------- ÁUDIO (TTS) ----------
  useEffect(() => {
    // prepara um <audio> dedicado ao TTS
    const a = new Audio();
    // evita erro de typings de "playsInline"
    a.setAttribute("playsinline", "true");
    (a as any).webkitPlaysInline = true;
    a.autoplay = false;
    a.preload = "auto";
    ttsAudioRef.current = a;

    // desbloqueio em primeiro gesto do utilizador
    const unlock = () => {
      if (unlockedRef.current || !ttsAudioRef.current) return;
      try {
        // pequena tentativa de tocar nada para desbloquear iOS
        ttsAudioRef.current.src = "";
        ttsAudioRef.current.play().catch(() => {
          /* ignorar */
        });
      } catch {
        /* ignorar */
      } finally {
        unlockedRef.current = true;
      }
    };

    // registamos vários tipos de gesto
    document.addEventListener("click", unlock, { once: true, capture: true });
    document.addEventListener("touchstart", unlock, { once: true, capture: true });
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });

    return () => {
      document.removeEventListener("click", unlock, { capture: true } as any);
      document.removeEventListener("touchstart", unlock, { capture: true } as any);
      document.removeEventListener("pointerdown", unlock, { capture: true } as any);
    };
  }, []);

  // Só alterei ESTA função: faz o fetch /api/tts e toca de forma robusta no Safari/Chrome
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
      // ElevenLabs normalmente devolve MPEG
      const blob = new Blob([ab], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);

      const audio = ttsAudioRef.current;
      if (!audio) {
        setStatus("⚠️ Áudio não inicializado.");
        return;
      }

      audio.src = url;
      audio.currentTime = 0;

      // iOS pode precisar de uma pequena folga de call-stack
      const playAudio = async () => {
        try {
          await audio.play();
        } catch (e: any) {
          console.warn("⚠️ Audio bloqueado:", e);
          setStatus("⚠️ O navegador bloqueou o áudio. Toca no ecrã e tenta de novo.");
        }
      };

      setTimeout(playAudio, 50);
    } catch (e: any) {
      setStatus("⚠️ Erro no TTS: " + (e?.message || e));
    }
  }

  // ---------- ASK (texto -> Alma -> resposta + voz) ----------
  const sendText = useCallback(async () => {
    const question = input.trim();
    if (!question) return;
    setStatus("A perguntar à Alma…");
    setAnswer("");

    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const j = (await r.json()) as AskResponse;
      if (!r.ok) {
        setStatus(`⚠️ Erro no ASK: ${r.status} ${(j?.error || JSON.stringify(j)).slice(0, 200)}`);
        return;
      }
      const ans = j.answer ?? "";
      setAnswer(ans);
      setStatus("✔️");
      // fala a resposta
      await speak(ans);
    } catch (e: any) {
      setStatus("⚠️ Erro no ASK: " + (e?.message || e));
    }
  }, [input]);

  // ---------- HOLD (voz -> STT -> Alma -> resposta + voz) ----------
  const startHold = useCallback(async () => {
    try {
      setStatus("🎤 A gravar… mantém carregado");
      setTranscript("");
      setIsHolding(true);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];

      mr.ondataavailable = (e: any) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        try {
          setStatus("🔁 A enviar áudio para STT…");
          const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
          const fd = new FormData();
          fd.append("file", blob, "input.webm");

          const r = await fetch("/api/stt", {
            method: "POST",
            body: fd,
          });

          const j = (await r.json()) as SttResponse;
          if (!r.ok) {
            setStatus(`⚠️ STT ${r.status}: ${JSON.stringify(j)}`);
            return;
          }

          const t = j.transcript?.trim() ?? "";
          setTranscript(t);
          if (!t) {
            setStatus("⚠️ Falha na transcrição");
            return;
          }

          // Pergunta à Alma e fala a resposta
          setStatus("A perguntar à Alma…");
          const rr = await fetch("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: t }),
          });
          const jj = (await rr.json()) as AskResponse;

          if (!rr.ok) {
            setStatus(`⚠️ Erro no ASK: ${rr.status} ${(jj?.error || JSON.stringify(jj)).slice(0, 200)}`);
            return;
          }

          const ans = jj.answer ?? "";
          setAnswer(ans);
          setStatus("✔️");
          await speak(ans);
        } catch (e: any) {
          setStatus("⚠️ Erro no STT/ASK: " + (e?.message || e));
        } finally {
          // libertar micro
          stream.getTracks().forEach((t) => t.stop());
        }
      };

      mediaRecorderRef.current = mr;
      mr.start();
    } catch (e: any) {
      setStatus("⚠️ Permissão do micro falhou: " + (e?.message || e));
      setIsHolding(false);
    }
  }, []);

  const stopHold = useCallback(() => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        setStatus("A processar áudio…");
        mediaRecorderRef.current.stop();
      }
    } finally {
      setIsHolding(false);
    }
  }, []);

  // ---------- UI ----------
  return (
    <main className="min-h-dvh p-6 flex flex-col items-center gap-6 bg-zinc-950 text-zinc-100">
      <h1 className="text-2xl font-semibold">🎭 Alma — voz & texto</h1>

      {/* STATUS */}
      <div className="text-sm text-zinc-300 min-h-5">{status}</div>

      {/* CAIXA TEXTO */}
      <div className="w-full max-w-2xl flex flex-col gap-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          className="w-full rounded-lg bg-zinc-900 border border-zinc-700 p-3 outline-none"
          placeholder="Escreve aqui para a Alma…"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={sendText}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition"
          >
            Enviar
          </button>

          {/* HOLD (pressiona e fala) */}
          <button
            onMouseDown={startHold}
            onMouseUp={stopHold}
            onMouseLeave={stopHold}
            onTouchStart={startHold}
            onTouchEnd={stopHold}
            className={`px-4 py-2 rounded-lg transition ${
              isHolding ? "bg-red-600" : "bg-sky-600 hover:bg-sky-500 active:bg-sky-700"
            }`}
          >
            {isHolding ? "A Gravar…" : "Manter p/ Falar"}
          </button>
        </div>
      </div>

      {/* TRANSCRIÇÃO */}
      <div className="w-full max-w-2xl">
        <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Transcrição</div>
        <div className="min-h-12 rounded-lg bg-zinc-900 border border-zinc-800 p-3 whitespace-pre-wrap">
          {transcript || <span className="text-zinc-600">—</span>}
        </div>
      </div>

      {/* RESPOSTA */}
      <div className="w-full max-w-2xl">
        <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Resposta da Alma</div>
        <div className="min-h-20 rounded-lg bg-zinc-900 border border-zinc-800 p-3 whitespace-pre-wrap">
          {answer || <span className="text-zinc-600">—</span>}
        </div>
      </div>
    </main>
  );
}
