"use client";

import { useState } from "react";

export default function Page() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask() {
    const question = q.trim();
    if (!question) return;
    setBusy(true);
    setLog((l) => [...l, `YOU: ${question}`]);
    setQ("");

    try {
      const r = await fetch("/api/alma", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const j = await r.json();
      setLog((l) => [...l, `ALMA: ${j.answer ?? "(sem resposta)"}`]);
    } catch (e: any) {
      setLog((l) => [...l, `ERRO: ${e?.message || e}`]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>Alma – Frontend mínimo</h1>
      <div
        style={{
          border: "1px solid #333",
          borderRadius: 8,
          padding: 12,
          minHeight: 260,
          background: "#111",
          marginBottom: 12,
          whiteSpace: "pre-wrap",
          lineHeight: 1.4,
        }}
      >
        {log.length ? log.join("\n\n") : "Escreve em baixo e carrega em Enviar…"}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Pergunta à Alma…"
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #333",
            background: "#0f0f0f",
            color: "#fff",
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #444",
            background: busy ? "#333" : "#5b5",
            color: "#000",
            fontWeight: 600,
          }}
        >
          {busy ? "A enviar…" : "Enviar"}
        </button>
      </form>
    </main>
  );
}
