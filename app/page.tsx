"use client";

import { useRef, useState } from "react";

// chama o teu endpoint que encaminha para o Alma-server (FastAPI /ask)
async function askAlma(question: string): Promise<string> {
  const r = await fetch("/api/alma", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Erro no /api/alma: ${r.status} ${t}`);
  }
  const j = await r.json();
  return j.answer || "Sem resposta.";
}

// chama o endpoint TTS (ElevenLabs) que devolve um MP3
async function speak(text: string) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Erro no /api/tts: ${r.status} ${t}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play();
}

type Msg = { who: "you" | "alma"; text: string };

export default function Page() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setQ("");
    setLog((L) => [...L, { who: "you", text: question }]);

    try {
      const answer = await askAlma(question);
      setLog((L) => [...L, { who: "alma", text: answer }]);
      await speak(answer); // 🔊 fala a resposta
    } catch (e: any) {
      setLog((L) => [
        ...L,
        { who: "alma", text: `Erro: ${e?.message || String(e)}` },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <main className="min-h-screen p-6 bg-zinc-950 text-zinc-50">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Alma – texto → voz 🎙️</h1>
        <p className="text-sm opacity-70 mb-6">
          Escreve a tua pergunta. A resposta será lida em voz alta.
        </p>

        <div className="rounded-lg border border-white/10 p-4 bg-white/5 mb-4">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="flex-1 px-3 py-2 rounded bg-black/30 border border-white/10 outline-none"
              placeholder="Escreve aqui… (Enter para enviar)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={busy}
            />
            <button
              onClick={send}
              disabled={busy}
              className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "A pensar…" : "Enviar"}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 p-4 bg-white/5 min-h-[160px]">
          {log.length === 0 ? (
            <div className="opacity-60 text-sm">Sem mensagens ainda.</div>
          ) : (
            <ul className="space-y-3">
              {log.map((m, i) => (
                <li key={i} className="leading-relaxed">
                  <span className="opacity-60 mr-2">
                    {m.who === "you" ? "Tu" : "Alma"}:
                  </span>
                  <span>{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="text-xs opacity-50 mt-4">
          Dica: verifica no Railway as variáveis <code>ALMA_SERVER_URL</code>,
          <code>ELEVENLABS_API_KEY</code> e <code>ELEVENLABS_VOICE_ID</code>.
        </div>
      </div>
    </main>
  );
}
