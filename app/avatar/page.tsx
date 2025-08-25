"use client";

import React, { useState } from "react";
import AvatarCanvas from "@/components/AvatarCanvas";

const DEFAULT_GLB =
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

export default function AvatarPage() {
  const [url, setUrl] = useState<string>(DEFAULT_GLB);
  const [apply, setApply] = useState<string>(DEFAULT_GLB);
  const [autoRotate, setAutoRotate] = useState(true);

  return (
    <main
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: 16,
        color: "#fff",
        fontFamily:
          '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial',
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        🎭 Avatar (Ready Player Me)
      </h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>
        Cola o link <code>.glb</code> do Ready Player Me e carrega em “Aplicar”.
      </p>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://models.readyplayer.me/.../meu-avatar.glb"
          style={{
            flex: 1,
            minWidth: 280,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #333",
            background: "#0f0f0f",
            color: "#fff",
          }}
        />
        <button
          onClick={() => setApply(url.trim())}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid #333",
            background: "#2b2bff",
            color: "#fff",
          }}
        >
          Aplicar
        </button>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={autoRotate}
            onChange={(e) => setAutoRotate(e.target.checked)}
          />
          Auto-rotate
        </label>
      </div>

      <AvatarCanvas glbUrl={apply} autoRotate={autoRotate} />

      <div style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>
        Dica: se o modelo não carregar, confirma se o link .glb é público e
        válido no Ready Player Me.
      </div>
    </main>
  );
}
