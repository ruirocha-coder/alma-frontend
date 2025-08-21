"use client";

import { useState, useRef } from "react";

export default function Home() {
  const [transcript, setTranscript] = useState("");
  const [inputText, setInputText] = useState("Olá, eu sou a Alma.");
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 🎤 Start recording
  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    const chunks: BlobPart[] = [];

    recorder.ondataavailable = (e) => chunks.push(e.data);

    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const formData = new FormData();
      formData.append("file", blob, "audio.webm");

      const r = await fetch("/api/stt", { method: "POST", body: formData });
      const j = await r.json();
      setTranscript(j.transcript || "⚠️ Falha na transcrição");
    };

    recorder.start();
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
  };

  // ⏹ Stop recording
  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  // 🔊 Text-to-Speech
  const speak = async () => {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: inputText }),
    });

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.play();
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>🎙️ Teste STT / TTS</h1>

      <div>
        {!isRecording ? (
          <button onClick={startRecording}>🎤 Gravar</button>
        ) : (
          <button onClick={stopRecording}>⏹️ Parar</button>
        )}
      </div>

      <p><b>Transcrição:</b> {transcript}</p>

      <hr />

      <textarea
        rows={3}
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        style={{ width: "100%" }}
      />
      <button onClick={speak}>🔊 Falar</button>
      <audio ref={audioRef} controls />
    </div>
  );
}
