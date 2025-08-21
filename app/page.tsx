// app/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "alma"; text: string };

export default function Page() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [autoVoice, setAutoVoice] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // util: acrescenta mensagem ao histórico
  const pushMsg = (m: Msg) => setMsgs((prev) => [...prev, m]);

  // envia texto à Alma e opcionalmente fala a resposta
  const askAlma = async (text: string) => {
    if (!text.trim()) return;
    pushMsg({ role: "user", text });
    setIsThinking(true);
    try {
      // 1) pergunta à Alma
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const j = await r.json();
      const answer = j.answer || "Sem resposta.";
      pushMsg({ role: "alma", text: answer });

      // 2) TTS (se ligado)
      if (autoVoice) {
        const r2 = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: answer,
            // se a tua rota /api/tts aceitar language/voice, podes enviar aqui
          }),
        });

        if (!r2.ok) {
          const errTxt = await r2.text();
          pushMsg({
            role: "alma",
            text: `Erro no TTS: ${r2.status} ${errTxt.slice(0, 200)}`,
          });
        } else {
          const blob = await r2.blob();
          const url = URL.createObjectURL(blob);
          if (!audioRef.current) {
            audioRef.current = new Audio();
          }
          audioRef.current.src = url;
          audioRef.current.play().catch(() => {
            // se o autoplay falhar (iOS), mostramos uma dica
            pushMsg({
              role: "alma",
              text:
                "🔈 Toque no botão ▶️ para ouvir (o navegador bloqueou o autoplay).",
            });
          });
        }
      }
    } catch (e: any) {
      pushMsg({
        role: "alma",
        text: "Erro ao contactar a Alma: " + (e?.message || String(e)),
      });
    } finally {
      setIsThinking(false);
    }
  };

  // gravação: iniciar
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const preferredTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/mpeg",
      ];
      let mimeType = "";
      for (const t of preferredTypes) {
        if (MediaRecorder.isTypeSupported(t)) {
          mimeType = t;
          break;
        }
      }

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.start();
      setIsRecording(true);
    } catch (e: any) {
      pushMsg({
        role: "alma",
        text: "Não consegui aceder ao microfone: " + (e?.message || String(e)),
      });
    }
  };

  // gravação: parar → enviar para STT → perguntar à Alma
  const stopRecording = async () => {
    if (!mediaRecorderRef.current) return;
    const mr = mediaRecorderRef.current;

    await new Promise<void>((resolve) => {
      mr.onstop = () => resolve();
      mr.stop();
    });
    setIsRecording(false);

    // cria blob com o tipo preferido (Deepgram aceita webm/mp4/mp3/wav)
    const blobType =
      mr.mimeType ||
      (chunksRef.current[0]?.type || "audio/webm"); // fallback sensato
    const blob = new Blob(chunksRef.current, { type: blobType });
    chunksRef.current = [];

    try {
      const form = new FormData();
      form.append("file", blob, `recording.${blobType.split("/")[1] || "webm"}`);

      const r = await fetch("/api/stt", {
        method: "POST",
        body: form,
      });

      const j = await r.json();
      const transcript = j.text || j.transcript || "";

      if (!transcript) {
        pushMsg({
          role: "alma",
          text:
            "Não consegui transcrever o áudio. Tenta falar um pouco mais perto do microfone.",
        });
        return;
      }

      // mostra a transcrição como se fosse a tua mensagem
      pushMsg({ role: "user", text: transcript });

      // pergunta à Alma
      await askAlma(transcript);
    } catch (e: any) {
      pushMsg({
        role: "alma",
        text: "Erro no STT: " + (e?.message || String(e)),
      });
    }
  };

  const handleSend = async () => {
    const t = typing.trim();
    setTyping("");
    if (!t) return;
    await askAlma(t);
  };

  // atalhos: Enter para enviar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        const t = (document.getElementById("msgbox") as HTMLTextAreaElement)
          ?.value;
        if (t) handleSend();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [typing]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center p-4">
      <div className="w-full max-w-3xl flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">🧠 Alma — voz & texto</h1>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoVoice}
                onChange={(e) => setAutoVoice(e.target.checked)}
              />
              Falar resposta
            </label>
          </div>
        </header>

        {/* histórico */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 h-[60vh] overflow-auto">
          {msgs.length === 0 && (
            <p className="text-zinc-400">
              Fala comigo — grava áudio 🎙️ ou escreve uma pergunta 👇
            </p>
          )}
          <ul className="space-y-3">
            {msgs.map((m, i) => (
              <li
                key={i}
                className={
                  m.role === "user"
                    ? "text-right"
                    : "text-left"
                }
              >
                <div
                  className={
                    "inline-block px-3 py-2 rounded-lg " +
                    (m.role === "user"
                      ? "bg-blue-600"
                      : "bg-zinc-800")
                  }
                >
                  <span className="text-sm opacity-80 mr-2">
                    {m.role === "user" ? "Tu" : "Alma"}
                    {": "}
                  </span>
                  <span className="whitespace-pre-wrap">{m.text}</span>
                </div>
              </li>
            ))}
            {isThinking && (
              <li className="text-left">
                <div className="inline-block px-3 py-2 rounded-lg bg-zinc-800 animate-pulse">
                  A pensar…
                </div>
              </li>
            )}
          </ul>
        </section>

        {/* input + gravação */}
        <section className="flex flex-col gap-2">
          <div className="flex gap-2">
            <textarea
              id="msgbox"
              value={typing}
              onChange={(e) => setTyping(e.target.value)}
              placeholder="Escreve aqui… (Cmd/Ctrl+Enter para enviar)"
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-2 outline-none"
              rows={2}
            />
            <button
              onClick={handleSend}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500"
              disabled={!typing.trim() || isThinking}
            >
              Enviar
            </button>
          </div>

          <div className="flex items-center gap-2">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500"
                disabled={isThinking}
              >
                🎙️ Gravar
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500"
              >
                ⏹️ Parar
              </button>
            )}

            <button
              onClick={() => {
                if (!audioRef.current) audioRef.current = new Audio();
                audioRef.current?.play().catch(() => {});
              }}
              className="px-3 py-2 rounded-lg border border-zinc-700"
              title="Reproduzir última resposta"
            >
              ▶️ Ouvir última
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
