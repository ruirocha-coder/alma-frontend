// app/page.tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

type ChatTurn = { role: 'user' | 'alma'; text: string };

export default function Page() {
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [testing, setTesting] = useState(false);
  const [input, setInput] = useState('Olá! Sou a Alma. Está a ouvir-me bem?');
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Limpeza de URL de blob para evitar leaks
  const cleanupAudio = useCallback(() => {
    try {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    } catch {}
  }, []);

  useEffect(() => {
    return () => cleanupAudio();
  }, [cleanupAudio]);

  // Desbloqueio de áudio em iOS: tocar 200ms de silêncio conta como gesto válido
  const unlockAudio = useCallback(async () => {
    try {
      // pequeno mp3 silencioso (data URI) — o play num clique “autoriza” a sessão
      const silent = new Audio(
        // 200ms de silêncio (mp3 minúsculo)
        'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////////////////////////////////////8='
      );
      silent.volume = 0;
      await silent.play();
      silent.pause();

      setAudioUnlocked(true);
    } catch (e) {
      alert('Não foi possível desbloquear o áudio. Tenta clicar novamente.');
    }
  }, []);

  // Falar (TTS)
  const speak = useCallback(
    async (text: string) => {
      if (!audioUnlocked) {
        alert('Clica primeiro em "Permitir áudio" para eu poder falar 🙂');
        return;
      }
      cleanupAudio();

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`TTS error: ${res.status} ${errTxt}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audio.volume = volume;
      audioRef.current = audio;

      await audio.play();
      audio.onended = () => {
        // limpeza suave após terminar
        cleanupAudio();
      };
    },
    [audioUnlocked, cleanupAudio, volume]
  );

  // Teste rápido de voz
  const handleTestVoice = useCallback(async () => {
    try {
      setTesting(true);
      await speak(input.trim() || 'Olá! Este é um teste de voz.');
    } catch (e: any) {
      console.error(e);
      alert(`Erro no /api/tts: ${e?.message || e}`);
    } finally {
      setTesting(false);
    }
  }, [input, speak]);

  // Exemplo de ciclo completo: USER → /api/alma → FALAR
  const handleAsk = useCallback(async () => {
    const q = input.trim();
    if (!q) return;

    setChat((c) => [...c, { role: 'user', text: q }]);
    setInput('');

    try {
      const r = await fetch('/api/alma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });

      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`Erro no /api/alma: ${r.status} ${txt}`);
      }

      const { answer } = await r.json();
      const final = answer || 'Sem resposta agora.';

      setChat((c) => [...c, { role: 'alma', text: final }]);

      // falar resposta
      await speak(final);
    } catch (e: any) {
      console.error(e);
      setChat((c) => [
        ...c,
        { role: 'alma', text: 'Ups — ocorreu um erro a obter resposta.' },
      ]);
    }
  }, [input, speak]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto p-4 md:p-8 flex flex-col gap-6">
        <h1 className="text-2xl md:text-3xl font-semibold">
          🎧 Alma – voz & texto
        </h1>

        {/* Barra de controlo */}
        <div className="flex flex-col md:flex-row items-start md:items-center gap-3 md:gap-6 rounded-lg border border-zinc-800 p-4">
          <button
            onClick={unlockAudio}
            className={`px-4 py-2 rounded-md ${
              audioUnlocked
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-indigo-600 hover:bg-indigo-500'
            }`}
          >
            {audioUnlocked ? 'Áudio desbloqueado ✅' : 'Permitir áudio 🔈'}
          </button>

          <div className="flex items-center gap-3">
            <label className="text-sm opacity-80">Volume</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
            />
            <span className="text-sm tabular-nums">{Math.round(volume * 100)}%</span>
          </div>

          <button
            onClick={handleTestVoice}
            disabled={testing}
            className="px-4 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60"
          >
            {testing ? 'A testar…' : 'Testar voz'}
          </button>
        </div>

        {/* Caixa de entrada */}
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 p-4">
          <textarea
            className="w-full min-h-[80px] rounded-md bg-zinc-900 p-3 outline-none"
            placeholder="Escreve algo para eu dizer…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="flex gap-3">
            <button
              onClick={handleTestVoice}
              className="px-4 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700"
            >
              Dizer (só voz)
            </button>
            <button
              onClick={handleAsk}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500"
            >
              Perguntar à Alma (voz + texto)
            </button>
          </div>
        </div>

        {/* Histórico simples */}
        <div className="rounded-lg border border-zinc-800">
          <div className="px-4 py-2 border-b border-zinc-800 text-sm opacity-70">
            Histórico
          </div>
          <div className="p-4 flex flex-col gap-3">
            {chat.length === 0 && (
              <div className="opacity-60 text-sm">
                Sem mensagens ainda. Escreve algo acima.
              </div>
            )}
            {chat.map((t, i) => (
              <div
                key={i}
                className={`p-3 rounded-md ${
                  t.role === 'user' ? 'bg-zinc-900' : 'bg-zinc-800'
                }`}
              >
                <div className="text-xs opacity-60 mb-1">
                  {t.role === 'user' ? 'Tu' : 'Alma'}
                </div>
                <div>{t.text}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="text-xs opacity-60">
          Dica iPad/Safari: clica em <em>Permitir áudio</em> antes de usar.
        </div>
      </div>
    </main>
  );
}
