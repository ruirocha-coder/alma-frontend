"use client";

import React, { useRef, useState } from "react";

type Message = { who: "You" | "Alma"; text: string };

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isHolding, setIsHolding] = useState(false);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // ---------- utils ----------
  function append(who: Message["who"], text: string) {
    setMessages((m) => [...m, { who, text }]);
  }

  // mantém o mesmo fluxo de TEXTO -> /api/alma -> /api/tts que já estava ok
  async function askAlma(question: string): Promise<string> {
    const r = await fetch("/api/alma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const j = await r.json();
    return (j?.answer || "").trim();
  }

  async function playTTS(text: string) {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const t = await r.text();
      append("Alma", `⚠️ Erro no TTS: ${r.status} ${t}`);
      return;
    }
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    try {
      await audio.play();
    } catch {
      append(
        "Alma",
        "⚠️ O navegador bloqueou o áudio automático. Toca no ecrã e tenta de novo."
      );
    }
    audio.onended = () => URL.revokeObjectURL(url);
  }

  async function sendText() {
    const q = input.trim();
    if (!q) return;
    setInput("");
    append("You", q);
    const a = await askAlma(q);
    if (a) {
      append("Alma", a);
      await playTTS(a); // mantém o comportamento que já funcionava
    }
  }

  // ---------- STT (apenas acrescenta o hold) ----------
  function pickBestMime(): string {
    const cands = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm",
      "audio/ogg",
      "audio/mp4", // safari / iOS
    ];
    for (const c of cands) {
      if ((window as any).MediaRecorder?.isTypeSupported?.(c)) return c;
    }
    return "audio/webm";
  }

  async function ensureMic(): Promise<MediaStream> {
    if (mediaStreamRef.current) return mediaStreamRef.current;
    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    mediaStreamRef.current = s;
    return s;
  }

  async function sendBlobToSTT(blob: Blob): Promise<string> {
    try {
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob, // envia bruto, sem FormData
      });
      const j = await res.json();
      if (!res.ok) {
        append("Alma", `⚠️ STT ${res.status}: ${JSON.stringify(j)}`);
        return "";
      }
      const t = (j?.transcript || "").trim();
      if (!t) append("Alma", "⚠️ Falha na transcrição");
      return t;
    } catch (e: any) {
      append("Alma", `⚠️ Erro no STT: ${e?.message || String(e)}`);
      return "";
    }
  }

  async function startHold() {
    try {
      const stream = await ensureMic();
      const mimeType = pickBestMime();

      chunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = rec;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          const transcript = await sendBlobToSTT(blob);
          if (!transcript) return;

          append("You", transcript);
          const answer = await askAlma(transcript);
          if (answer) {
            append("Alma", answer);
            await playTTS(answer);
          }
        } catch (e: any) {
          append("Alma", `⚠️ Erro ao processar áudio: ${e?.message || String(e)}`);
        }
      };

      rec.start(250);
      setIsHolding(true);
    } catch (e: any) {
      append("Alma", `⚠️ Erro a iniciar microfone: ${e?.message || String(e)}`);
      setIsHolding(false);
    }
  }

  async function stopHold() {
    try {
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
    } finally {
      setIsHolding(false);
    }
  }

  // ---------- UI simples ----------
  return (
    <main className="max-w-xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold">Alma — voz & texto</h1>

      <div className="border rounded p-2 h-64 overflow-y-auto bg-white/5">
        {messages.map((m, i) => (
          <div key={i} className="mb-2">
            <strong>{m.who}:</strong> {m.text}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onMouseDown={startHold}
          onMouseUp={stopHold}
          onTouchStart={startHold}
          onTouchEnd={stopHold}
          className={`px-4 py-2 rounded ${
            isHolding ? "bg-red-600" : "bg-blue-600"
          } text-white`}
        >
          {isHolding ? "A gravar…" : "Manter p/ Falar"}
        </button>

        <input
          className="flex-1 border rounded px-2"
          placeholder="Escreve e Enter…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendText()}
        />
        <button onClick={sendText} className="px-3 py-2 rounded bg-green-600 text-white">
          Enviar
        </button>
      </div>
    </main>
  );
}
