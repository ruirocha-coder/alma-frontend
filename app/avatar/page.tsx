"use client";

import React from "react";
import dynamic from "next/dynamic";

// Import relativo para evitar erro de alias "@/"
const AvatarCanvas = dynamic(() => import("../../components/AvatarCanvas"), {
  ssr: false,
});

export default function AvatarPage() {
  // URL do avatar .glb — usa variável de ambiente se existir
  const url =
    process.env.NEXT_PUBLIC_RPM_GLTF_URL ||
    "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>
        🎭 Avatar (Ready Player Me)
      </h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>
        A carregar modelo: <code>{url}</code>
      </p>
      <AvatarCanvas url={url} height={560} />
    </main>
  );
}
