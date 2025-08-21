"use client";

import { useState, useRef } from "react";

export default function Home() {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const speakingRef = useRef(false);
  const [input, setInput] = useState("");

  // 👉 Função principal: pergunta ao Alma e fala resposta
  async function askAlmaAndSpeak(question: string) {
    if (speakingRef.current) return;
    speakingRef.current = true;

    try {
      // mostra pergunta do utilizador
      setMessages((prev) => [...prev, { role: "user", content: question }]);

      // 1) Perguntar ao Alma
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const j = await r.json();
      const answer = (j?.answer || "").trim();

      // registar resposta
      setMessages((prev) => [...prev, { role: "assistant", content: answer }]);

      if (!answer) return;

      // 2) TTS
      const t = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: answer }),
      });

      if (!t.ok) {
        console.warn("Falha no TTS:", await t.text());
        return;
      }

      // 3) Tocar áudio
      const ab = await t.arrayBuffer();
      const url = URL.createObjectURL(new Blob([ab], { type: "audio/mpeg" }));
      const audio = new Audio(url);
      audio.volume = 1.0;
      await audio.play();
    } catch (err) {
      console.error("Erro no askAlmaAndSpeak:", err);
    } finally {
      speakingRef.current = false;
    }
  }

  // 👉 Gravação: Start
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", blob, "recording.webm");

        try {
          const res = await fetch("/api/stt", { method: "POST", body: formData });
          const { transcript, error } = await res.json();

          if (error || !transcript?.trim()) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `⚠️ Falha na transcrição: ${error || "sem texto"}` },
            ]);
          } else {
            await askAlmaAndSpeak(transcript);
          }
        } catch (err) {
          console.error("Erro STT:", err);
        }
      };

      mediaRecorder.start();
    } catch (err) {
      console.error("Erro ao iniciar gravação:", err);
    }
  };

  // 👉 Gravação: Stop
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  // 👉 Input de texto
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const q = input.trim();
    setInput("");
    await askAlmaAndSpeak(q);
  };

  return (
    <main className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Alma</h1>

      <div className="border p-3 h-80 overflow-y-auto mb-4 bg-gray-50 rounded">
        {messages.map((m, i) => (
          <div key={i} className={`mb-2 ${m.role === "user" ? "text-blue-600" : m.role === "assistant" ? "text-green-700" : "text-gray-500"}`}>
            <b>{m.role}:</b> {m.content}
          </div>
        ))}
      </div>

      {/* Caixa de texto */}
      <form onSubmit={handleSubmit} className="flex mb-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escreve a tua pergunta..."
          className="flex-1 border p-2 rounded-l"
        />
        <button type="submit" className="bg-blue-600 text-white px-4 rounded-r">
          Enviar
        </button>
      </form>

      {/* Botão de Hold to Talk */}
      <button
        onMouseDown={startRecording}
        onMouseUp={stopRecording}
        onTouchStart={startRecording}
        onTouchEnd={stopRecording}
        className="bg-red-600 text-white px-4 py-2 rounded w-full"
      >
        🎤 Manter para falar
      </button>
    </main>
  );
}
