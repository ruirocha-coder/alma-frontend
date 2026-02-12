"use client";

import React, { useEffect, useRef, useState } from "react";
import AvatarCanvas from "../components/AvatarCanvas";

type LogItem = { role: "you" | "alma"; text: string };

// ---------- REMOVE LINKS APENAS PARA VOZ
function stripLinksForVoice(text: string): string {
  if (!text) return "";

  let t = String(text);

  t = t.replace(/\n?\s*Links dos produtos\s*:\s*\n[\s\S]*$/i, "");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1");
  t = t.replace(/\bhttps?:\/\/[^\s]+/gi, "");
  t = t.replace(/\bwww\.[^\s]+/gi, "");
  t = t.replace(/[()[\]{}<>]/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

// --- USER_ID
function getUserId() {
  try {
    const KEY = "alma_user_id";
    let v = localStorage.getItem(KEY);
    if (v) return v;
    v = "u_" + crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
    localStorage.setItem(KEY, v);
    return v;
  } catch {
    return "anon";
  }
}

const USER_ID = typeof window !== "undefined" ? getUserId() : "anon";

export default function Page() {

  const colors = {
    bg: "#0a0a0b",
    panel: "#0f0f11",
    fg: "#f3f3f3",
    fgDim: "#cfcfd3",
    border: "#26262b",
    accent: "#d4a017",
    bubbleUser: "#1b1b21",
    bubbleAlma: "#23232a",
  };

  const btnBase: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 999,
    border: `1px solid rgba(0,0,0,0.35)`,
    background: colors.accent,
    color: "#000",
    cursor: "pointer",
    fontWeight: 700,
  };

  const [status, setStatus] = useState("Pronto");
  const [isArmed, setIsArmed] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [typed, setTyped] = useState("");
  const [log, setLog] = useState<LogItem[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // ---------- AUDIO UNLOCK
  async function ensureAudioReady() {
    const el = ttsAudioRef.current;
    if (!el) return;
    try {
      await el.play().catch(() => {});
      el.pause();
      el.currentTime = 0;
    } catch {}
  }

  useEffect(() => {
    const el = document.getElementById("tts-audio") as HTMLAudioElement | null;
    if (el) ttsAudioRef.current = el;
  }, []);

  // ---------- MICRO
  async function requestMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setIsArmed(true);
      setStatus("Micro pronto.");
    } catch {
      setStatus("Permissão negada.");
    }
  }

  function startHold() {
    if (!isArmed) {
      requestMic();
      return;
    }

    if (!streamRef.current) return;

    chunksRef.current = [];

    const mr = new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = e => chunksRef.current.push(e.data);

    mr.onstop = async () => {
      const blob = new Blob(chunksRef.current);
      await handleTranscribe(blob);
    };

    mr.start();
    setIsRecording(true);
  }

  function stopHold() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  async function handleTranscribe(blob: Blob) {
    setStatus("A transcrever...");

    const fd = new FormData();
    fd.append("audio", blob);

    const r = await fetch("/api/stt", { method: "POST", body: fd });
    const j = await r.json();
    const txt = j.transcript || "";

    if (!txt) return;

    setLog(l => [...l, { role: "you", text: txt }]);

    await askAlma(txt);
  }

  // ---------- TTS
  async function speak(text: string) {

    const clean = stripLinksForVoice(text);

    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean })
    });

    const ab = await r.arrayBuffer();
    const blob = new Blob([ab], { type: "audio/mpeg" });

    const url = URL.createObjectURL(blob);

    const audio = ttsAudioRef.current;
    if (!audio) return;

    audio.src = url;
    await audio.play();
  }

  // ---------- ALMA
  async function askAlma(q: string) {

    setStatus("A perguntar à Alma...");

    const r = await fetch("/api/alma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, user_id: USER_ID })
    });

    const j = await r.json();
    const out = j.answer || "";

    setLog(l => [...l, { role: "alma", text: out }]);

    await speak(out);

    setStatus("Pronto");
  }

  async function sendTyped() {
    if (!typed.trim()) return;

    setLog(l => [...l, { role: "you", text: typed }]);

    await askAlma(typed);

    setTyped("");
  }

  // ---------- UI
  return (
    <main
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: 20,
        background: colors.bg,
        color: colors.fg,
        minHeight: "100vh"
      }}
    >

      <AvatarCanvas audioLevelRef={{ current: 0 }} />

      <audio id="tts-audio" />

      <div style={{ textAlign: "center", margin: 10 }}>{status}</div>

      <button
        onMouseDown={startHold}
        onMouseUp={stopHold}
        style={{
          ...btnBase,
          width: 300,
          background: isRecording ? "#8b0000" : colors.accent
        }}
      >
        {isRecording ? "A gravar..." : "Segurar para falar"}
      </button>

      <input
        value={typed}
        onChange={e => setTyped(e.target.value)}
        onKeyDown={e => e.key === "Enter" && sendTyped()}
        placeholder="Escrever..."
        style={{
          width: "100%",
          marginTop: 20,
          padding: 12,
          borderRadius: 999,
          border: "none"
        }}
      />

      <div style={{ marginTop: 20 }}>
        {log.map((m, i) => (
          <div key={i} style={{
            background: m.role === "alma" ? colors.bubbleAlma : colors.bubbleUser,
            padding: 12,
            borderRadius: 12,
            marginBottom: 8,
            whiteSpace: "pre-wrap"
          }}>
            {m.text}
          </div>
        ))}
      </div>

    </main>
  );
}
