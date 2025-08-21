"use client";

import { useState, useRef } from "react";

export default function Home() {
  const [list, setList] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const mediaStream = useRef<MediaStream | null>(null);
  const mediaProcessor = useRef<ScriptProcessorNode | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const bufferData = useRef<Float32Array[]>([]);
  const recording = useRef(false);

  // 🎙️ Iniciar captura
  async function startRec() {
    audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 16000, // força 16kHz
    });

    mediaStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioContext.current.createMediaStreamSource(mediaStream.current);

    const processor = audioContext.current.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!recording.current) return;
      const input = e.inputBuffer.getChannelData(0);
      bufferData.current.push(new Float32Array(input));
    };

    source.connect(processor);
    processor.connect(audioContext.current.destination);

    mediaProcessor.current = processor;
    bufferData.current = [];
    recording.current = true;
    setList((prev) => [...prev, "🎙️ A gravar..."]);
  }

  // ⏹️ Parar e processar WAV
  async function stopRec() {
    recording.current = false;
    setLoading(true);

    // Concatenar floats
    const flat = mergeBuffers(bufferData.current);
    const wav = encodeWAV(flat, audioContext.current!.sampleRate);

    // criar Blob WAV
    const audioBlob = new Blob([wav], { type: "audio/wav" });

    // enviar para STT
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.wav");

    try {
      const sttRes = await fetch("/api/stt", { method: "POST", body: formData });
      const { transcript } = await sttRes.json();

      setList((prev) => [...prev, `👤 Tu: ${transcript}`]);

      // perguntar ao LLM
      const askRes = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: transcript }),
      });
      const { answer } = await askRes.json();
      setList((prev) => [...prev, `🤖 Alma: ${answer}`]);

      // sintetizar voz
      const ttsRes = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: answer }),
      });
      const audioBuffer = await ttsRes.arrayBuffer();
      const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play();
    } catch (err) {
      console.error(err);
      setList((prev) => [...prev, `⚠️ Erro: ${err}`]);
    }

    setLoading(false);
  }

  return (
    <main style={{ padding: 20 }}>
      <h1>🎤 Alma com WAV</h1>
      <button onClick={startRec} disabled={recording.current}>Iniciar</button>
      <button onClick={stopRec} disabled={!recording.current || loading}>
        Parar & Enviar
      </button>
      <div style={{ marginTop: 20 }}>
        {list.map((m, i) => (
          <p key={i}>{m}</p>
        ))}
      </div>
    </main>
  );
}

// 🔊 juntar buffers
function mergeBuffers(buffers: Float32Array[]) {
  let length = 0;
  buffers.forEach((b) => (length += b.length));
  const result = new Float32Array(length);
  let offset = 0;
  buffers.forEach((b) => {
    result.set(b, offset);
    offset += b.length;
  });
  return result;
}

// 🔊 converter para WAV (PCM 16-bit mono)
function encodeWAV(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  floatTo16BitPCM(view, 44, samples);

  return buffer;
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
